import { Elysia, type AnyElysia } from "elysia";
import { thatch, type Frame, type McpHandle } from "@brooswit/thatch";
import type { Config } from "./config.js";
import { RocketChat, type User } from "./rocketchat.js";
import { Watcher, toFrame } from "./watcher.js";
import { Activity } from "./activity.js";
import { buildTools, instrument } from "./tools.js";
import { page } from "./web.js";

export const VERSION = "0.1.0";
/** Undelivered frames kept for sessions that connect later. */
const PENDING_MAX = 50;

export interface Rocketr {
  app: AnyElysia;
  mcp: McpHandle;
  rc: RocketChat;
  self: User;
  watcher: Watcher;
  activity: Activity;
  /** Frames waiting for a session with a live channel stream. */
  pending: Frame[];
  /** Try to push every pending frame; returns how many landed somewhere. */
  deliver(): Promise<number>;
  listen(): Promise<{ port: number }>;
  stop(): Promise<void>;
}

export async function createRocketr(cfg: Config, deps: { fetch?: typeof fetch } = {}): Promise<Rocketr> {
  const rc = new RocketChat({ url: cfg.url, userId: cfg.userId, token: cfg.token, ...(deps.fetch ? { fetch: deps.fetch } : {}) });
  const activity = new Activity();
  const log = (message: string) => { console.error(`rocketr: ${message}`); activity.record({ type: "log", message }); };

  const self = await rc.me();
  const allow = new Set<string>();
  for (const username of cfg.allow) {
    try { allow.add((await rc.userByUsername(username))._id); }
    catch (err) { log(`allowlist: cannot resolve @${username}: ${(err as Error).message}`); }
  }
  if (!allow.size) log("no allowed senders resolved (ROCKETR_ALLOW) — nothing will be pushed into sessions");

  const { plugin, mcp } = thatch({
    serverInfo: { name: "rocketr", version: VERSION },
    tools: instrument(buildTools(rc, self, cfg.url), activity),
  });
  mcp.on("connect", (c) => activity.connected(c));
  mcp.on("disconnect", (c, reason) => activity.record({ type: "disconnect", agentId: c.id, reason }));

  const pending: Frame[] = [];
  let delivering = Promise.resolve(0);
  /** A session opts out of pushes (tools only) with `x-rocketr-channel: off`. */
  const listening = () => mcp.connections.filter((c) => c.headers["x-rocketr-channel"] !== "off");

  const deliverOnce = async () => {
    let landed = 0;
    for (const frame of [...pending]) {
      const targets = listening();
      if (!targets.length) break;
      let ok = false;
      for (const c of targets) {
        const d = await c.send(frame);
        activity.record({ type: "push", agentId: c.id, messageId: frame.meta.message_id ?? "", delivery: d });
        ok ||= d.claim === "C2";
      }
      if (!ok) continue;
      pending.splice(pending.indexOf(frame), 1);
      landed++;
      if (frame.meta.room_id) await rc.markRead(frame.meta.room_id).catch((err) => log(`markRead: ${(err as Error).message}`));
    }
    return landed;
  };
  // serialize: the watcher and the retry timer must not push the same frame twice
  const deliver = () => (delivering = delivering.then(deliverOnce, deliverOnce));

  const watcher = new Watcher(rc, {
    self, allow, pollMs: cfg.pollMs, log,
    onEvent: async (e) => {
      const frame = toFrame(e);
      activity.record({ type: "inbound", frame });
      pending.push(frame);
      if (pending.length > PENDING_MAX) log(`dropped undelivered message ${pending.shift()!.meta.message_id} (queue full)`);
      await deliver();
    },
  });

  const app = new Elysia()
    .use(plugin)
    .get("/", () => new Response(page, { headers: { "content-type": "text/html; charset=utf-8" } }))
    .get("/api/snapshot", () => ({ self: { id: self._id, username: self.username }, server: cfg.url, version: VERSION, pending: pending.length, ...activity.snapshot() }))
    .get("/api/stream", ({ request }) => {
      let off = () => {};
      const stream = new ReadableStream<string>({
        start(ctrl) {
          ctrl.enqueue(": connected\n\n");
          off = activity.subscribe((e) => ctrl.enqueue(`data: ${JSON.stringify(e)}\n\n`));
          request.signal.addEventListener("abort", () => off());
        },
        cancel() { off(); },
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
    });

  let retry: ReturnType<typeof setInterval> | undefined;
  return {
    app, mcp, rc, self, watcher, activity, pending, deliver,
    async listen() {
      app.listen({ hostname: cfg.host, port: cfg.port, idleTimeout: 0 });
      watcher.start();
      retry = setInterval(() => { if (pending.length) void deliver(); }, Math.max(cfg.pollMs, 1000));
      log(`listening on http://${cfg.host}:${app.server!.port} as @${self.username}`);
      return { port: app.server!.port! };
    },
    async stop() {
      watcher.stop();
      if (retry) clearInterval(retry);
      await mcp.closeAll();
      await app.stop(true); // close open observer streams too
    },
  };
}
