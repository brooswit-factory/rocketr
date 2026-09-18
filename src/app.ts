import { Elysia, type AnyElysia } from "elysia";
import { thatch, type Connection, type Frame, type McpHandle } from "@brooswit/thatch";
import type { Config } from "./config.js";
import { RocketChat, type User } from "./rocketchat.js";
import { Watcher, toFrame } from "./watcher.js";
import { Activity } from "./activity.js";
import { buildTools, instrument } from "./tools.js";
import { page } from "./web.js";

export const VERSION = "0.2.0";
/** Undelivered frames kept for sessions that connect later. */
const PENDING_MAX = 50;
/** The header a connection names its Rocket.Chat account with. Required: there is no default account. */
export const ACCOUNT_HEADER = "x-rocketr-account";

export interface Account {
  rc: RocketChat;
  self: User;
  watcher: Watcher;
}

export interface Pending {
  /** Username of the account the message was addressed to; only its sessions may receive it. */
  account: string;
  frame: Frame;
}

export interface Rocketr {
  app: AnyElysia;
  mcp: McpHandle;
  /** Keyed by Rocket.Chat username. */
  accounts: Map<string, Account>;
  activity: Activity;
  /** Frames waiting for a session of their account with a live channel stream. */
  pending: Pending[];
  /** Try to push every pending frame; returns how many landed somewhere. */
  deliver(): Promise<number>;
  listen(): Promise<{ port: number }>;
  stop(): Promise<void>;
}

export async function createRocketr(cfg: Config, deps: { fetch?: typeof fetch } = {}): Promise<Rocketr> {
  const activity = new Activity();
  const log = (message: string) => { console.error(`rocketr: ${message}`); activity.record({ type: "log", message }); };

  const accounts = new Map<string, Account>();
  const pending: Pending[] = [];
  let delivering = Promise.resolve(0);

  const allow = new Set<string>();
  const clients: Array<{ rc: RocketChat; self: User }> = [];
  for (const a of cfg.accounts) {
    const rc = new RocketChat({ url: cfg.url, userId: a.userId, token: a.token, ...(deps.fetch ? { fetch: deps.fetch } : {}) });
    const self = await rc.me();
    // the header names the account by username, so a name that doesn't match its token would be a lie
    if (self.username !== a.name) throw new Error(`rocketr: account "${a.name}" signs in as @${self.username} — fix ROCKETR_ACCOUNTS or its token`);
    clients.push({ rc, self });
  }
  for (const username of cfg.allow) {
    try { allow.add((await clients[0]!.rc.userByUsername(username))._id); }
    catch (err) { log(`allowlist: cannot resolve @${username}: ${(err as Error).message}`); }
  }
  if (!allow.size) log("no allowed senders resolved (ROCKETR_ALLOW) — nothing will be pushed into sessions");

  const accountOf = (c: Connection): Account => {
    const a = accounts.get(c.headers[ACCOUNT_HEADER] ?? "");
    if (!a) throw new Error(`this session has no Rocket.Chat account (set the ${ACCOUNT_HEADER} header)`);
    return a;
  };

  const { plugin, mcp } = thatch({
    serverInfo: { name: "rocketr", version: VERSION },
    // No fallback account: a client that doesn't name a known one is refused at connect.
    auth: (req) => accounts.has(req.headers.get(ACCOUNT_HEADER) ?? ""),
    tools: instrument(buildTools(accountOf, cfg.url), activity),
  });
  mcp.on("connect", (c) => activity.connected(c));
  mcp.on("disconnect", (c, reason) => activity.record({ type: "disconnect", agentId: c.id, reason }));

  /**
   * Pushes are opt-in (`x-rocketr-channel: on`) and go only to sessions of the addressed account. Claude Code
   * accepts a frame on the wire even when the session wasn't started with the channel flag, then drops it
   * silently — so a tools-only session must never count as a delivery, or the message is marked read and lost.
   */
  const listening = (account: string) =>
    mcp.connections.filter((c) => c.headers["x-rocketr-channel"] === "on" && c.headers[ACCOUNT_HEADER] === account);

  const deliverOnce = async () => {
    let landed = 0;
    for (const item of [...pending]) {
      const targets = listening(item.account);
      if (!targets.length) continue;
      let ok = false;
      for (const c of targets) {
        const d = await c.send(item.frame);
        activity.record({ type: "push", agentId: c.id, messageId: item.frame.meta.message_id ?? "", delivery: d });
        ok ||= d.claim === "C2";
      }
      if (!ok) continue;
      pending.splice(pending.indexOf(item), 1);
      landed++;
      const rid = item.frame.meta.room_id;
      if (rid) await accounts.get(item.account)!.rc.markRead(rid).catch((err) => log(`markRead: ${(err as Error).message}`));
    }
    return landed;
  };
  // serialize: the watchers and the retry timer must not push the same frame twice
  const deliver = () => (delivering = delivering.then(deliverOnce, deliverOnce));

  for (const { rc, self } of clients) {
    const watcher = new Watcher(rc, {
      self, allow, pollMs: cfg.pollMs, log,
      onEvent: async (e) => {
        const frame = toFrame(e);
        frame.meta.account = self.username;
        activity.record({ type: "inbound", frame });
        pending.push({ account: self.username, frame });
        if (pending.length > PENDING_MAX) log(`dropped undelivered message ${pending.shift()!.frame.meta.message_id} (queue full)`);
        await deliver();
      },
    });
    accounts.set(self.username, { rc, self, watcher });
  }

  const app = new Elysia()
    .use(plugin)
    .get("/", () => new Response(page, { headers: { "content-type": "text/html; charset=utf-8" } }))
    .get("/api/snapshot", () => ({
      accounts: [...accounts.values()].map((a) => ({ id: a.self._id, username: a.self.username })),
      server: cfg.url, version: VERSION, pending: pending.length, ...activity.snapshot(),
    }))
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
    app, mcp, accounts, activity, pending, deliver,
    async listen() {
      app.listen({ hostname: cfg.host, port: cfg.port, idleTimeout: 0 });
      for (const a of accounts.values()) a.watcher.start();
      retry = setInterval(() => { if (pending.length) void deliver(); }, Math.max(cfg.pollMs, 1000));
      log(`listening on http://${cfg.host}:${app.server!.port} as ${[...accounts.keys()].map((u) => `@${u}`).join(", ")}`);
      return { port: app.server!.port! };
    },
    async stop() {
      for (const a of accounts.values()) a.watcher.stop();
      if (retry) clearInterval(retry);
      await mcp.closeAll();
      await app.stop(true); // close open observer streams too
    },
  };
}
