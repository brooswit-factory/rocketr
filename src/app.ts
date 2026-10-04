import { Elysia, type AnyElysia } from "elysia";
import { thatch, type Connection, type Frame, type McpHandle } from "@brooswit/thatch";
import type { Config } from "./config.js";
import type { Subscription } from "./rocketchat.js";
import { Batcher, Watcher, toFrame, type InboundEvent } from "./watcher.js";
import { buildTools, instrument, type AccountHandle } from "./tools.js";
import { page } from "./web.js";
import { Activity } from "./activity.js";
import { isLoopbackAddress } from "./auth.js";
import { isBindAllowed } from "./bind.js";
import { realClientIP } from "./forwarded.js";
import { parseConnectionHeaders, isHeaderError, connectionCredentials } from "./headers.js";
import { credentialKey, CredentialRejected, SessionManager, type Session } from "./session.js";
import { allowAll, type AccessContext, type CheckAccess } from "./access.js";
import { ConnectionLimiter, ToolCallLimiter, RequestCounters, DEFAULT_LIMITS, type LimitsOptions } from "./limits.js";
import { redactHeaders, targetHost } from "./redact.js";
import type { FetchLimits, Resolver } from "./ssrf.js";

export const VERSION = "1.0.0";

/**
 * No presence (the "online" dot) in this version: presence.ts opens a raw WebSocket to the
 * client-supplied URL using the system DNS resolver directly, bypassing the SSRF guard entirely —
 * a hostname that answers public to the guarded `/me` call and private to the WebSocket connect
 * (DNS rebinding) would get an unguarded, unpinned outbound connection to an internal address and
 * port. Fixing that (open the socket through the same pinned, deny-checked path as everything
 * else) is real work on a secondary feature, not blocking for a first stateless-proxy cut — see
 * FACTORY-644. An agent's online status in Rocket.Chat is simply unavailable in proxy mode for now.
 */

/** Undelivered frames kept per credential key for sessions that connect later. */
const PENDING_MAX = 50;
/** A room that never goes quiet still gets a turn every this many batch windows. */
const BATCH_MAX_FACTOR = 5;
/** How long a session with zero live connections is kept (watcher running, queue intact) before teardown. */
const DEFAULT_GRACE_PERIOD_MS = 2 * 60 * 1000;
/** How long a credential key that got a 401 is refused outright, no network call made. */
const DEFAULT_BACKOFF_MS = 60 * 1000;
/** Requests/hour from one source IP before an ALERT log line fires. */
const DEFAULT_ALERT_THRESHOLD_PER_IP = 20_000;
/** Server-injected only (auth() always overwrites it; a client-sent value for it is never trusted) — carries the resolved client IP from auth() to the "connect" handler, which only sees headers, with no race against concurrent connections. */
const INTERNAL_IP_HEADER = "x-rocketr-internal-ip";
/** How often the "no channel-on connection at all" log/event may fire for the same credential key, so the 1s retry loop cannot flood it. */
const NO_CHANNEL_LOG_INTERVAL_MS = 60 * 1000;

export interface Pending {
  /** Credential key the message was addressed to; only its sessions may receive it. */
  key: string;
  frame: Frame;
}

export interface Rocketr {
  app: AnyElysia;
  mcp: McpHandle;
  activity: Activity;
  pending: Pending[];
  /** Try to push every pending frame; returns how many landed somewhere. */
  deliver(): Promise<number>;
  listen(): Promise<{ port: number }>;
  stop(): Promise<void>;
  /** Test/observability hook: the live in-memory sessions. */
  sessions(): Session[];
}

export interface CreateRocketrDeps {
  /** Test-only: replaces the SSRF-guarded fetch entirely (e.g. to point at a fake Rocket.Chat). Never set in production. */
  fetch?: typeof fetch;
  /** Source address of an incoming request, before X-Forwarded-For resolution. Default: the real peer via Bun. */
  requestIP?: (req: Request) => string | undefined;
  checkAccess?: CheckAccess;
  limits?: Partial<LimitsOptions>;
  gracePeriodMs?: number;
  backoffMs?: number;
  fetchLimits?: FetchLimits;
  resolver?: Resolver;
  alertThresholdPerIP?: number;
}

export async function createRocketr(cfg: Config, deps: CreateRocketrDeps = {}): Promise<Rocketr> {
  const activity = new Activity();
  const log = (message: string) => { console.error(`rocketr: ${message}`); activity.record({ type: "log", message }); };
  const logRefusal = (ip: string, reason: string) => log(`refused connection ip=${ip} reason=${reason}`);

  // Secure by default: enforced here too (not just in loadConfig) so a Config built directly can't skip it.
  if (!isBindAllowed(cfg.host)) throw new Error(`rocketr: host "${cfg.host}" is not loopback, the tailnet range, or a ULA address`);

  const checkAccess = deps.checkAccess ?? allowAll;
  const limitsOptions: LimitsOptions = { ...DEFAULT_LIMITS, ...deps.limits };
  const limiter = new ConnectionLimiter(limitsOptions);
  const toolLimiter = new ToolCallLimiter({ maxPerMinute: limitsOptions.toolCallsPerMinutePerConnection });
  const counters = new RequestCounters({ perIPAlertThreshold: deps.alertThresholdPerIP ?? DEFAULT_ALERT_THRESHOLD_PER_IP, log });

  const pending: Pending[] = [];
  const batchers = new Map<string, Batcher>();
  let delivering = Promise.resolve(0);
  /** Last time (key) got a "no channel-on connection at all" log/event, so deliverOnce's 1s retry loop can't flood it. */
  const lastNoChannelLogAt = new Map<string, number>();

  const adopt = async (session: Session, sub: Subscription) => {
    if (sub.desktopNotifications || sub.disableNotifications !== undefined) return;
    try {
      await session.rc.saveNotification(sub.rid, session.options.notify);
      sub.desktopNotifications = session.options.notify;
      log(`@${session.self.username}: ${sub.fname || sub.name} notifications set to ${session.options.notify}`);
    } catch (err) {
      log(`@${session.self.username}: cannot set notifications for ${sub.fname || sub.name}: ${(err as Error).message}`);
    }
  };

  const onCreateSession = (session: Session) => {
    const key = session.key;
    const batcher = new Batcher({
      quietMs: session.options.batchMs,
      maxMs: session.options.batchMs * BATCH_MAX_FACTOR,
      flush: async (events) => {
        const frame = toFrame(events);
        frame.meta.account = session.self.username;
        activity.record({ type: "inbound", frame });
        pending.push({ key, frame });
        const own = pending.filter((p) => p.key === key);
        if (own.length > PENDING_MAX) {
          pending.splice(pending.indexOf(own[0]!), 1);
          log(`@${session.self.username}: dropped undelivered message ${own[0]!.frame.meta.message_id} (queue full)`);
        }
        await deliver();
      },
    });
    batchers.set(key, batcher);

    const watcher = new Watcher(session.rc, {
      self: session.self,
      fallback: session.options.notify,
      pollMs: session.options.pollMs,
      // The lookback window is applied once, here, by back-dating the watcher's own start time —
      // everything else about "restarts never replay history" is unchanged.
      now: () => new Date(Date.now() - session.options.lookbackSec * 1000),
      log: (m) => log(`@${session.self.username}: ${m}`),
      onSubscription: (sub) => adopt(session, sub),
      onEvent: async (e) => { await batcher.add([key, e.room.id, e.message.tmid ?? ""].join("\0"), e); },
    });
    session.watcher = watcher;
    watcher.start();

    void (async () => {
      try { for (const sub of await session.rc.subscriptions()) await adopt(session, sub); }
      catch (err) { log(`@${session.self.username}: cannot list rooms: ${(err as Error).message}`); }
    })();
  };

  const onTeardownSession = (session: Session) => {
    void batchers.get(session.key)?.flushAll();
    batchers.delete(session.key);
    log(`@${session.self.username}: session torn down (idle grace period elapsed)`);
  };

  const sessions = new SessionManager({
    gracePeriodMs: deps.gracePeriodMs ?? DEFAULT_GRACE_PERIOD_MS,
    backoffMs: deps.backoffMs ?? DEFAULT_BACKOFF_MS,
    fetchLimits: deps.fetchLimits,
    resolver: deps.resolver,
    ...(deps.fetch ? { fetchOverride: deps.fetch } : {}),
    onCreate: onCreateSession,
    onTeardown: onTeardownSession,
  });

  // `app` is assigned below (Elysia needs the thatch plugin to exist first) but this closure is only
  // ever called per-request, long after that assignment — by then the capture is live, not a TDZ read.
  const requestIP: (req: Request) => string | undefined = deps.requestIP ?? ((req) => app.server?.requestIP(req)?.address ?? undefined);

  /**
   * The only place `auth` ever runs against a client-named Rocket.Chat server: validates headers,
   * applies the always-on limits, calls `checkAccess` (once for the connection, and again for a
   * brand-new credential key), then creates/reuses the session — which is itself where the SSRF
   * guard's `/me` preflight happens. Everything here either refuses (false, logged, no state
   * created) or accepts and leaves the connection's refcount already incremented.
   */
  const auth = async (req: Request): Promise<boolean> => {
    const peer = requestIP(req);
    const ip = realClientIP(peer, req.headers.get("x-forwarded-for"));
    // Stashed on the request's own Headers so the "connect" event — which only ever sees headers,
    // never the original Request — can read it with no race against a concurrent connection's auth().
    req.headers.set(INTERNAL_IP_HEADER, ip);

    const headerRecord: Record<string, string> = {};
    req.headers.forEach((v, k) => { headerRecord[k] = v; });

    const parsed = parseConnectionHeaders(headerRecord);
    if (isHeaderError(parsed)) { logRefusal(ip, `invalid-credentials: header ${parsed.field} ${parsed.message}`); return false; }

    if (!limiter.canConnect(ip)) { logRefusal(ip, "limit-exceeded: too many connections from this source IP"); return false; }

    const key = credentialKey(parsed);
    const ctxBase: Omit<AccessContext, "event"> = { sourceIP: ip, headers: redactHeaders(headerRecord), targetUrl: parsed.url, credentialKeyHash: key };

    const connDecision = await checkAccess({ ...ctxBase, event: "connection" });
    if (!connDecision.allow) { logRefusal(ip, `checkAccess denied the connection: ${connDecision.reason}`); return false; }

    if (!limiter.canUseKey(ip, key)) { logRefusal(ip, "limit-exceeded: too many distinct credential keys"); return false; }

    if (sessions.isNewKey(key)) {
      const keyDecision = await checkAccess({ ...ctxBase, event: "new-key" });
      if (!keyDecision.allow) { logRefusal(ip, `checkAccess denied the new credential key: ${keyDecision.reason}`); return false; }
    }

    try {
      await sessions.acquire(
        { url: parsed.url, userId: parsed.userId, token: parsed.token },
        { notify: parsed.notify, batchMs: parsed.batchMs, pollMs: parsed.pollMs, lookbackSec: parsed.lookbackSec },
      );
    } catch (err) {
      if (err instanceof CredentialRejected) { logRefusal(ip, `${err.reason}: ${err.message}`); return false; }
      logRefusal(ip, `error validating credential: ${(err as Error).message}`);
      return false;
    }

    limiter.addConnection(ip, key);
    return true;
  };

  const accountOf = (c: Connection): AccountHandle => {
    const key = credentialKey(connectionCredentials(c.headers));
    const session = sessions.get(key);
    if (!session) throw new Error("this session's Rocket.Chat credential is no longer active (reconnect to restart it)");
    return { rc: session.rc, self: session.self, url: session.creds.url, fallback: session.options.notify };
  };

  /** Request-volume counters (always on) and the per-connection tool-call rate limit, around every tool call. */
  const guardTools = (tools: ReturnType<typeof buildTools>) => Object.fromEntries(Object.entries(tools).map(([name, def]) => [name, {
    ...def,
    handler: async (args: unknown, c: Connection) => {
      const ip = c.headers[INTERNAL_IP_HEADER] || "unknown";
      counters.record(ip, targetHost(c.headers["x-rocketr-url"] ?? ""));
      if (!toolLimiter.allow(c.id)) throw new Error("tool-call rate limit exceeded for this connection; slow down");
      return def.handler(args as never, c);
    },
  }]));

  const { plugin, mcp } = thatch({
    serverInfo: { name: "rocketr", version: VERSION },
    auth,
    tools: instrument(guardTools(buildTools(accountOf, (account, roomId, level) => {
      if (level !== "nothing") return;
      for (const item of [...pending]) {
        if (item.frame.meta.room_id === roomId) {
          const session = sessions.get(item.key);
          if (session?.self.username === account) pending.splice(pending.indexOf(item), 1);
        }
      }
    }, { dir: cfg.attachmentDir, maxBytes: cfg.attachmentMaxBytes, allowedTypes: cfg.attachmentTypes })), activity),
  });

  mcp.on("connect", (c) => {
    const key = credentialKey(connectionCredentials(c.headers));
    const session = sessions.get(key);
    activity.connected(c, session?.self.username ?? "?");
  });
  mcp.on("disconnect", (c, reason) => {
    activity.record({ type: "disconnect", agentId: c.id, reason });
    const ip = c.headers[INTERNAL_IP_HEADER] || "unknown";
    const key = credentialKey(connectionCredentials(c.headers));
    sessions.release(key);
    limiter.removeConnection(ip, key);
    toolLimiter.forget(c.id);
  });

  /**
   * Pushes are opt-in (`x-rocketr-channel: on`) and go only to sessions of the addressed credential
   * key. Claude Code accepts a frame on the wire even when the session wasn't started with the
   * channel flag, then drops it silently — so a tools-only session must never count as a delivery.
   */
  /** Every channel-on connection for the credential key, newest first, so a refusal from the
   * newest can fall back to an older connection that may still have a live stream. */
  const listening = (key: string) => mcp.connections
    .filter((c) => c.headers["x-rocketr-channel"] === "on" && credentialKey(connectionCredentials(c.headers)) === key)
    .sort((a, b) => b.connectedAt - a.connectedAt);

  /** An account with no channel-on connection at all leaves no per-attempt event — log it out loud
   * instead, at most once a minute per key so the 1s retry loop can't flood it. */
  const noteNoChannel = (key: string, waiting: number) => {
    const now = Date.now();
    const last = lastNoChannelLogAt.get(key);
    if (last !== undefined && now - last < NO_CHANNEL_LOG_INTERVAL_MS) return;
    lastNoChannelLogAt.set(key, now);
    const username = sessions.get(key)?.self.username ?? null;
    log(`${username ? `@${username}` : key.slice(0, 12)}: no channel-on connection, ${waiting} frame${waiting === 1 ? "" : "s"} waiting`);
    activity.record({ type: "no-channel", key, username, waiting });
  };

  const deliverOnce = async () => {
    let landed = 0;
    for (const item of [...pending]) {
      const targets = listening(item.key);
      if (!targets.length) {
        noteNoChannel(item.key, pending.filter((p) => p.key === item.key).length);
        continue;
      }
      for (const target of targets) {
        const delivery = await target.send(item.frame);
        activity.record({ type: "push", agentId: target.id, messageId: item.frame.meta.message_id ?? "", delivery });
        if (delivery.claim === "C2") {
          pending.splice(pending.indexOf(item), 1);
          landed++;
          const rid = item.frame.meta.room_id;
          const session = sessions.get(item.key);
          if (rid && session) await session.rc.markRead(rid).catch((err) => log(`markRead: ${(err as Error).message}`));
          break;
        }
        // "bad-meta" is a problem with the frame itself, not this connection — every other
        // connection would refuse it the same way, so stop trying and leave it pending.
        if (delivery.reason === "bad-meta") break;
      }
    }
    return landed;
  };
  // serialize: the watchers and the retry timer must not push the same frame twice
  const deliver = () => (delivering = delivering.then(deliverOnce, deliverOnce));

  /** The observer app (/, /api/snapshot, /api/stream) has no per-account auth of its own — it shows
   * every session's activity, including message content — so it stays loopback-only unconditionally. */
  const observerGuard = (req: Request): Response | null => isLoopbackAddress(requestIP(req))
    ? null
    : new Response(JSON.stringify({ error: "forbidden" }), { status: 403, headers: { "content-type": "application/json" } });

  const app: AnyElysia = new Elysia()
    .use(plugin)
    .get("/", ({ request }) => observerGuard(request) ?? new Response(page, { headers: { "content-type": "text/html; charset=utf-8" } }))
    .get("/api/snapshot", ({ request }) => observerGuard(request) ?? ({
      sessions: sessions.list().map((s) => ({
        keyHash: s.key.slice(0, 12),
        username: s.self.username,
        connections: s.refCount,
        health: s.watcher?.health() ?? null,
        noChannelConnection: listening(s.key).length === 0,
      })),
      version: VERSION,
      pending: pending.length,
      pendingByKey: pending.reduce<Record<string, number>>((counts, item) => {
        const short = item.key.slice(0, 12);
        counts[short] = (counts[short] ?? 0) + 1;
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
    app, mcp, activity, pending, deliver,
    sessions: () => sessions.list(),
    async listen() {
      app.listen({ hostname: cfg.host, port: cfg.port, idleTimeout: 0 });
      retry = setInterval(() => { if (pending.length) void deliver(); }, 1000);
      log(`listening on http://${cfg.host}:${app.server!.port} (stateless proxy mode: no accounts configured, credentials are client-carried)`);
      return { port: app.server!.port! };
    },
    async stop() {
      if (retry) clearInterval(retry);
      for (const batcher of batchers.values()) await batcher.flushAll();
      sessions.stopAll();
      await mcp.closeAll();
      await app.stop(true); // close open observer streams too
    },
  };
}
