import { createHash } from "node:crypto";
import { RocketChat, RocketChatError, type NotifyLevel, type User } from "./rocketchat.js";
import type { Watcher } from "./watcher.js";
import { ssrfSafeFetch, SsrfBlockedError, type FetchLimits, type Resolver, type SsrfFetchInit } from "./ssrf.js";
import { FailureRateLimiter } from "./auth.js";

export interface Credentials { url: string; userId: string; token: string }

/** The in-memory account-session key: sha256(url, userId, token). Never derived from a header's account claim — there is none. */
export function credentialKey({ url, userId, token }: Credentials): string {
  return createHash("sha256").update(url).update("\0").update(userId).update("\0").update(token).digest("hex");
}

export interface SessionOptions {
  notify: NotifyLevel;
  batchMs: number;
  pollMs: number;
  lookbackSec: number;
}

export interface Session {
  key: string;
  rc: RocketChat;
  self: User;
  /** Kept only so a presence connection can be opened; never logged. */
  creds: Credentials;
  options: SessionOptions;
  /** Assigned by `onCreate` right after the session is registered, once the caller builds the watcher. */
  watcher?: Watcher;
  /** Live MCP connections currently using this credential key. */
  refCount: number;
  teardownTimer?: ReturnType<typeof setTimeout> | undefined;
}

export type RejectReason = "invalid-credentials" | "blocked-url";

export class CredentialRejected extends Error {
  constructor(readonly reason: RejectReason, message: string) { super(message); }
}

export interface SessionManagerOptions {
  /** How long a session with zero live connections is kept (watcher running, queue intact) before teardown. */
  gracePeriodMs: number;
  /** How long a credential key that got a 401 from Rocket.Chat is refused outright, no network call made. */
  backoffMs: number;
  fetchLimits?: FetchLimits | undefined;
  resolver?: Resolver | undefined;
  /** Test-only escape hatch: replaces the SSRF-guarded fetch entirely. Production never sets this — see ssrf.test.ts for the guard's own coverage. */
  fetchOverride?: (typeof fetch) | undefined;
  /** Called once, synchronously, right after a brand-new session is registered — build and assign `session.watcher` here, then start it. */
  onCreate: (session: Session) => void;
  /** Called once a torn-down session's watcher has been stopped. */
  onTeardown: (session: Session) => void;
}

/**
 * In-memory account sessions keyed by credential hash. Connections sharing a key share one session
 * (one watcher, one queue); a session is created on first use — validated against Rocket.Chat's
 * `/me` before anything else starts — and torn down after its last connection closes plus a grace
 * period. A 401 drops the key immediately and refuses it outright (no network call) for a backoff
 * window, so a bad credential can't be used to probe Rocket.Chat repeatedly.
 */
export class SessionManager {
  private readonly sessions = new Map<string, Session>();
  /** maxFailures: 1 — a single 401 is enough to distrust a credential key for the backoff window. */
  private readonly backoff: FailureRateLimiter;
  private readonly creating = new Map<string, Promise<Session>>();

  constructor(private readonly o: SessionManagerOptions) {
    this.backoff = new FailureRateLimiter({ maxFailures: 1, windowMs: o.backoffMs, lockoutMs: o.backoffMs });
  }

  get(key: string): Session | undefined { return this.sessions.get(key); }
  list(): Session[] { return [...this.sessions.values()]; }
  isNewKey(key: string): boolean { return !this.sessions.has(key) && !this.creating.has(key); }

  isBackedOff(key: string, now = Date.now()): boolean {
    return this.backoff.isLocked(key, now);
  }

  /**
   * The existing or newly-validated session for `creds`, with its refcount already incremented for
   * this caller. Throws `CredentialRejected` on a 401 (which also starts the backoff window) or an
   * SSRF-blocked URL; never makes a network call for a key already in its backoff window.
   */
  async acquire(creds: Credentials, options: SessionOptions): Promise<Session> {
    const key = credentialKey(creds);
    const existing = this.sessions.get(key);
    if (existing) {
      existing.refCount++;
      if (existing.teardownTimer) { clearTimeout(existing.teardownTimer); existing.teardownTimer = undefined; }
      return existing;
    }
    if (this.isBackedOff(key)) throw new CredentialRejected("invalid-credentials", "credential key is within its post-401 backoff window");

    let inflight = this.creating.get(key);
    let isCreator = false;
    if (!inflight) {
      isCreator = true;
      inflight = this.create(key, creds, options).finally(() => this.creating.delete(key));
      this.creating.set(key, inflight);
    }
    const session = await inflight;
    if (!isCreator) session.refCount++; // the creator already counted itself inside create()
    return session;
  }

  private async create(key: string, creds: Credentials, options: SessionOptions): Promise<Session> {
    const fetchImpl = this.o.fetchOverride ??
      (((url: string | URL, init?: RequestInit) => ssrfSafeFetch(url, toSsrfInit(init), this.o.fetchLimits, this.o.resolver)) as typeof fetch);
    const rc = new RocketChat({ url: creds.url, userId: creds.userId, token: creds.token, fetch: fetchImpl });
    let self: User;
    try {
      self = await rc.me();
    } catch (err) {
      if (err instanceof RocketChatError && err.status === 401) {
        this.backoff.recordFailure(key);
        throw new CredentialRejected("invalid-credentials", "Rocket.Chat rejected the credential (401)");
      }
      if (err instanceof SsrfBlockedError) throw new CredentialRejected("blocked-url", err.message);
      throw err;
    }
    this.backoff.recordSuccess(key);
    const session: Session = { key, rc, self, creds, options, refCount: 1 };
    this.sessions.set(key, session);
    this.o.onCreate(session);
    return session;
  }

  /** Decrements refcount; at zero, schedules teardown after the grace period (cancelled if another connection arrives first). */
  release(key: string): void {
    const session = this.sessions.get(key);
    if (!session) return;
    session.refCount = Math.max(0, session.refCount - 1);
    if (session.refCount > 0) return;
    session.teardownTimer = setTimeout(() => {
      if (this.sessions.get(key) !== session || session.refCount > 0) return;
      this.sessions.delete(key);
      session.watcher?.stop();
      this.o.onTeardown(session);
    }, this.o.gracePeriodMs);
  }

  /** Stops every session immediately, skipping the grace period — for process shutdown. */
  stopAll(): void {
    for (const session of this.sessions.values()) {
      if (session.teardownTimer) clearTimeout(session.teardownTimer);
      session.watcher?.stop();
    }
    this.sessions.clear();
  }
}

function toSsrfInit(init?: RequestInit): SsrfFetchInit {
  if (!init) return {};
  const headers: Record<string, string> = {};
  if (init.headers) for (const [k, v] of Object.entries(init.headers as Record<string, string>)) headers[k] = v;
  if (init.body instanceof FormData) return { method: init.method, headers, form: init.body };
  const body = typeof init.body === "string" || Buffer.isBuffer(init.body) ? (init.body as string | Buffer) : undefined;
  return { method: init.method, headers, body };
}
