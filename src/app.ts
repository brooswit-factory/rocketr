import { Elysia, type AnyElysia } from "elysia";
import { thatch, type Connection, type Frame, type McpHandle } from "@brooswit/thatch";
import type { Config } from "./config.js";
import { RocketChat, RocketChatError, type Subscription, type User } from "./rocketchat.js";
import { Batcher, Watcher, toFrame, type InboundEvent } from "./watcher.js";
import { Activity } from "./activity.js";
import { buildTools, instrument } from "./tools.js";
import { Presence } from "./presence.js";
import { page } from "./web.js";
import { createAuthenticator, isLoopbackAddress, isLoopbackHost, type RateLimitOptions } from "./auth.js";

export const VERSION = "0.3.0";
/**
 * Undelivered frames kept per account for sessions that connect later. Per account, so an account with no live
 * session (whose rooms are all at `all`) can't push out frames meant for an agent that is listening.
 */
const PENDING_MAX = 50;
/** A room that never goes quiet still gets a turn every this many batch windows. */
const BATCH_MAX_FACTOR = 5;
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

/** A configured account excluded from service at startup, and why. */
export interface AccountFailure {
  /** The name configured in ROCKETR_ACCOUNTS — not necessarily the server's own username for it. */
  name: string;
  /** Human-readable: a username mismatch (names the server's actual username) or a 401. */
  detail: string;
}

/**
 * One consolidated message naming every failed account, so a reader can tell a coordinated rename
 * (many accounts, consistent pattern) apart from a single broken one. Shared by the "some accounts
 * failed" log line and the "every account failed" thrown error, so the two cases never diverge.
 */
function describeAccountFailures(failures: AccountFailure[], total: number): string {
  const lines = failures.map((f) => `  - "${f.name}": ${f.detail}`).join("\n");
  return [
    `rocketr: ${failures.length} of ${total} configured account(s) failed startup preflight:`,
    lines,
    `Update ROCKETR_ACCOUNTS/secrets.env to match the current server-side usernames, or fix the token(s).`,
  ].join("\n");
}

export interface Rocketr {
  app: AnyElysia;
  mcp: McpHandle;
  /** Keyed by Rocket.Chat username. Only accounts that passed the startup preflight. */
  accounts: Map<string, Account>;
  /** Configured accounts excluded at startup (username mismatch or 401), with why. */
  excludedAccounts: AccountFailure[];
  activity: Activity;
  /** Frames waiting for a session of their account with a live channel stream. */
  pending: Pending[];
  /** Try to push every pending frame; returns how many landed somewhere. */
  deliver(): Promise<number>;
  listen(): Promise<{ port: number }>;
  stop(): Promise<void>;
}

export async function createRocketr(cfg: Config, deps: {
  fetch?: typeof fetch;
  presence?: (options: ConstructorParameters<typeof Presence>[0]) => Pick<Presence, "setListening" | "stop">;
  /** Source address of an incoming request, for rate limiting and the observer app's loopback guard. Default: the real peer via Bun. */
  requestIP?: (req: Request) => string | undefined;
  authRateLimit?: RateLimitOptions;
} = {}): Promise<Rocketr> {
  const activity = new Activity();
  const log = (message: string) => { console.error(`rocketr: ${message}`); activity.record({ type: "log", message }); };

  // Secure by default: enforced here too (not just in loadConfig) so a Config built directly can't skip it.
  if (!isLoopbackHost(cfg.host)) {
    const bare = cfg.accounts.filter((a) => !a.clientSecret).map((a) => a.name);
    if (bare.length) {
      throw new Error(`rocketr: host "${cfg.host}" is not loopback, but account(s) without a client secret would be reachable unauthenticated: ${bare.map((n) => `"${n}"`).join(", ")}`);
    }
  }

  const accounts = new Map<string, Account>();
  const pending: Pending[] = [];
  const presences = new Map<string, Pick<Presence, "setListening" | "stop">>();
  let delivering = Promise.resolve(0);

  // Every configured account is checked, even after an earlier one fails: stopping at the first
  // failure would only ever name that one account, leaving a reader unable to tell a coordinated
  // rename (many accounts, consistent pattern) apart from a single broken one.
  const clients: Array<{ rc: RocketChat; self: User }> = [];
  const failures: AccountFailure[] = [];
  for (const a of cfg.accounts) {
    const rc = new RocketChat({ url: cfg.url, userId: a.userId, token: a.token, ...(deps.fetch ? { fetch: deps.fetch } : {}) });
    let self: User;
    try {
      self = await rc.me();
    } catch (err) {
      const status = err instanceof RocketChatError ? err.status : undefined;
      failures.push({ name: a.name, detail: status === 401 ? "401 Unauthorized — token rejected" : `preflight failed: ${(err as Error).message}` });
      continue;
    }
    // The header names the account by username, so a name that doesn't match its token would be a lie:
    // never serve it under the name it claims. It is excluded below, not thrown — one drifted account
    // must not take every other, healthy account down with it.
    if (self.username !== a.name) {
      failures.push({ name: a.name, detail: `signs in as @${self.username}, not @${a.name}` });
      continue;
    }
    clients.push({ rc, self });
    presences.set(self.username, (deps.presence ?? ((options) => new Presence(options)))({
      url: cfg.url, userId: a.userId, token: a.token,
      log: (message) => log(`@${self.username}: ${message}`),
    }));
  }

  if (failures.length) {
    const message = describeAccountFailures(failures, cfg.accounts.length);
    if (failures.length === cfg.accounts.length) {
      // Every configured account failed: zero accounts would be served. Reporting "healthy" while
      // serving nothing would be its own silent failure, so this exits non-zero on purpose —
      // deliberately keeping the crash/restart signal for a config that serves nobody. Because that
      // re-triggers the restart loop, this is the SAME message (via describeAccountFailures) that a
      // partial failure only logs: whichever path runs, the journal gets one consolidated, actionable
      // line. Restarting fast against a mistake that a human hasn't fixed yet is unhelpful noise, so
      // systemd/rocketr.service's RestartSec/RestartSteps back off progressively instead of a flat 5s.
      throw new Error(message);
    }
    log(message);
  }

  /**
   * Give a room that never had a preference saved the agent default, so it shows (and can be changed) in Rocket.Chat's
   * own UI. A room someone explicitly reset to "default" is left alone.
   */
  const adopt = async (rc: RocketChat, self: User, sub: Subscription) => {
    const migrate = cfg.migrateLegacyAllToMentions && sub.desktopNotifications === "all";
    if (!migrate && (sub.desktopNotifications || sub.disableNotifications !== undefined)) return;
    const level = migrate ? "mentions" : cfg.defaultNotifications;
    try {
      await rc.saveNotification(sub.rid, level);
      sub.desktopNotifications = level;
      log(`@${self.username}: ${sub.fname || sub.name} notifications set to ${level}`);
    } catch (err) {
      log(`@${self.username}: cannot set notifications for ${sub.fname || sub.name}: ${(err as Error).message}`);
    }
  };
  for (const { rc, self } of clients) {
    try { for (const sub of await rc.subscriptions()) await adopt(rc, self, sub); }
    catch (err) { log(`@${self.username}: cannot list rooms: ${(err as Error).message}`); }
  }

  /** The account a connection named, or the bridge's opt-in default when it named none. */
  const nameOf = (header: string | null | undefined) => header || cfg.defaultAccount || "";
  const accountOf = (c: Connection): Account => {
    const a = accounts.get(nameOf(c.headers[ACCOUNT_HEADER]));
    if (!a) throw new Error(`this session has no Rocket.Chat account (set the ${ACCOUNT_HEADER} header)`);
    return a;
  };

  // `app` is assigned below (Elysia needs the thatch plugin to exist first) but these closures are only
  // ever called per-request, long after that assignment — by then the capture is live, not a TDZ read.
  const requestIP: (req: Request) => string | undefined = deps.requestIP ?? ((req) => app.server?.requestIP(req)?.address ?? undefined);
  const secretOf = new Map(cfg.accounts.map((a) => [a.name, a.clientSecret] as const));
  const loopbackBind = isLoopbackHost(cfg.host);
  const authenticate = createAuthenticator({
    known: (name) => accounts.has(name),
    secretOf: (name) => secretOf.get(name),
    loopbackBind,
    allowUnauthenticatedLoopback: cfg.allowUnauthenticatedLoopback,
    requestIP,
    onUnauthenticatedLoopback: (name) => log(`@${name}: connected with no client credential (ROCKETR_ALLOW_UNAUTHENTICATED_LOOPBACK) — set ROCKETR_ACCOUNT_${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_CLIENT_SECRET to require one`),
    ...(deps.authRateLimit ? { rateLimit: deps.authRateLimit } : {}),
  });
  /** The observer app (/, /api/snapshot, /api/stream) has no per-account auth — it shows every account's
   * activity, including message content — so it stays loopback-only regardless of client secrets or ROCKETR_HOST. */
  const observerGuard = (req: Request): Response | null => isLoopbackAddress(requestIP(req))
    ? null
    : new Response(JSON.stringify({ error: "forbidden" }), { status: 403, headers: { "content-type": "application/json" } });

  const { plugin, mcp } = thatch({
    serverInfo: { name: "rocketr", version: VERSION },
    // No fallback account unless ROCKETR_DEFAULT_ACCOUNT opts a single-account bridge in: a client that
    // doesn't name a known one is refused at connect.
    auth: (req) => authenticate(req, nameOf(req.headers.get(ACCOUNT_HEADER))),
    tools: instrument(buildTools(accountOf, cfg.url, cfg.defaultNotifications, (account, roomId, level) => {
      if (level !== "nothing") return;
      for (const item of [...pending]) {
        if (item.account === account && item.frame.meta.room_id === roomId) pending.splice(pending.indexOf(item), 1);
      }
    }, { dir: cfg.attachmentDir, maxBytes: cfg.attachmentMaxBytes }), activity),
  });
  const syncPresence = (c: Connection) => {
    const account = nameOf(c.headers[ACCOUNT_HEADER]);
    presences.get(account)?.setListening(mcp.connections.filter((session) =>
      nameOf(session.headers[ACCOUNT_HEADER]) === account && session.headers["x-rocketr-channel"] === "on").length > 0);
  };
  mcp.on("connect", (c) => { activity.connected(c); syncPresence(c); });
  mcp.on("disconnect", (c, reason) => {
    activity.record({ type: "disconnect", agentId: c.id, reason });
    syncPresence(c);
  });

  /**
   * Pushes are opt-in (`x-rocketr-channel: on`) and go only to sessions of the addressed account. Claude Code
   * accepts a frame on the wire even when the session wasn't started with the channel flag, then drops it
   * silently — so a tools-only session must never count as a delivery, or the message is marked read and lost.
   */
  const listening = (account: string) => mcp.connections
    .filter((c) => c.headers["x-rocketr-channel"] === "on" && nameOf(c.headers[ACCOUNT_HEADER]) === account)
    .sort((a, b) => b.connectedAt - a.connectedAt)[0];

  const deliverOnce = async () => {
    let landed = 0;
    for (const item of [...pending]) {
      const target = listening(item.account);
      if (!target) continue;
      const delivery = await target.send(item.frame);
      activity.record({ type: "push", agentId: target.id, messageId: item.frame.meta.message_id ?? "", delivery });
      if (delivery.claim !== "C2") continue;
      pending.splice(pending.indexOf(item), 1);
      landed++;
      const rid = item.frame.meta.room_id;
      if (rid) await accounts.get(item.account)!.rc.markRead(rid).catch((err) => log(`markRead: ${(err as Error).message}`));
    }
    return landed;
  };
  // serialize: the watchers and the retry timer must not push the same frame twice
  const deliver = () => (delivering = delivering.then(deliverOnce, deliverOnce));

  /** Which account each event was addressed to (events themselves don't carry it). */
  const accountOfEvent = new WeakMap<InboundEvent, string>();
  const batcher = new Batcher({
    quietMs: cfg.batchMs, maxMs: cfg.batchMs * BATCH_MAX_FACTOR,
    flush: async (events) => {
      const frame = toFrame(events);
      const account = frame.meta.account = accountOfEvent.get(events[0]!)!;
      activity.record({ type: "inbound", frame });
      pending.push({ account, frame });
      const own = pending.filter((p) => p.account === account);
      if (own.length > PENDING_MAX) {
        pending.splice(pending.indexOf(own[0]!), 1);
        log(`@${account}: dropped undelivered message ${own[0]!.frame.meta.message_id} (queue full)`);
      }
      await deliver();
    },
  });

  for (const { rc, self } of clients) {
    const watcher = new Watcher(rc, {
      self, fallback: cfg.defaultNotifications, pollMs: cfg.pollMs, log,
      onSubscription: (sub) => adopt(rc, self, sub),
      onEvent: async (e) => {
        accountOfEvent.set(e, self.username);
        await batcher.add([self.username, e.room.id, e.message.tmid ?? ""].join("\0"), e);
      },
    });
    accounts.set(self.username, { rc, self, watcher });
  }

  const app: AnyElysia = new Elysia()
    .use(plugin)
    .get("/", ({ request }) => observerGuard(request) ?? new Response(page, { headers: { "content-type": "text/html; charset=utf-8" } }))
    .get("/api/snapshot", ({ request }) => observerGuard(request) ?? ({
      accounts: [...accounts.values()].map((a) => ({ id: a.self._id, username: a.self.username })),
      // So a partial outage never reads as "all healthy": named explicitly, not just absent from `accounts`.
      excludedAccounts: failures,
      server: cfg.url,
      version: VERSION,
      pending: pending.length,
      // Counts only: enough to diagnose a stalled account without exposing message contents.
      pendingByAccount: pending.reduce<Record<string, number>>((counts, item) => {
        counts[item.account] = (counts[item.account] ?? 0) + 1;
        return counts;
      }, {}),
      ...activity.snapshot(),
    }))
    .get("/api/stream", ({ request }) => {
      const blocked = observerGuard(request);
      if (blocked) return blocked;
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
    app, mcp, accounts, excludedAccounts: failures, activity, pending, deliver,
    async listen() {
      app.listen({ hostname: cfg.host, port: cfg.port, idleTimeout: 0 });
      for (const a of accounts.values()) a.watcher.start();
      retry = setInterval(() => { if (pending.length) void deliver(); }, Math.max(cfg.pollMs, 1000));
      log(`listening on http://${cfg.host}:${app.server!.port} as ${[...accounts.keys()].map((u) => `@${u}`).join(", ")}` +
        (failures.length ? ` (excluding ${failures.length} account(s): ${failures.map((f) => `"${f.name}"`).join(", ")} — see the startup preflight error above)` : ""));
      return { port: app.server!.port! };
    },
    async stop() {
      for (const a of accounts.values()) a.watcher.stop();
      if (retry) clearInterval(retry);
      await batcher.flushAll();
      await mcp.closeAll();
      for (const presence of presences.values()) presence.stop();
      await app.stop(true); // close open observer streams too
    },
  };
}
