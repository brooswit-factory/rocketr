import { createHash, timingSafeEqual as nodeTimingSafeEqual } from "node:crypto";

/**
 * Constant-time string compare. `crypto.timingSafeEqual` throws on a length mismatch — comparing
 * fixed-length digests instead means a wrong-length guess takes the same time as a right-length one,
 * so secret length is never observable from response timing either.
 */
export function timingSafeEqualStr(a: string, b: string): boolean {
  const da = createHash("sha256").update(a).digest();
  const db = createHash("sha256").update(b).digest();
  return nodeTimingSafeEqual(da, db);
}

/** Whether `host` (rocketr's own bind address) is loopback-only. */
export function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

/** Whether a request's remote address is loopback. */
export function isLoopbackAddress(address: string | null | undefined): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

export interface RateLimitOptions {
  /** Failures from one key within `windowMs` before it is locked out. */
  maxFailures: number;
  windowMs: number;
  lockoutMs: number;
  /** Max distinct keys tracked at once; the oldest is evicted first. Bounds memory against a flood of spoofed keys. */
  maxKeys?: number;
}

export const DEFAULT_AUTH_RATE_LIMIT: RateLimitOptions = { maxFailures: 10, windowMs: 5 * 60 * 1000, lockoutMs: 15 * 60 * 1000 };

const DEFAULT_MAX_KEYS = 10_000;

/**
 * Per-key failure tracking with a lockout window. A locked key is refused outright — its credentials
 * are never even checked — so a lockout can't itself be used to distinguish "right secret, wrong
 * account" from "wrong secret" by timing. The key is caller-chosen (see createAuthenticator): a
 * composite of (source IP, account name) for a known account, or just the IP for an unknown one.
 */
export class FailureRateLimiter {
  private readonly failures = new Map<string, number[]>();
  private readonly lockedUntil = new Map<string, number>();
  /** Keys whose current lockout has already produced one log line — see noteLockoutForLogging. */
  private readonly lockoutLogged = new Set<string>();
  /** Insertion order of every key that ever recorded a failure, for oldest-first eviction. */
  private readonly order: string[] = [];
  private readonly maxKeys: number;

  constructor(private readonly opts: RateLimitOptions) {
    this.maxKeys = opts.maxKeys ?? DEFAULT_MAX_KEYS;
  }

  private evictIfOverCapacity(key: string): void {
    if (this.failures.has(key)) return; // already tracked — this failure doesn't grow the key count
    this.order.push(key);
    if (this.order.length <= this.maxKeys) return;
    const oldest = this.order.shift()!;
    this.failures.delete(oldest);
    this.lockedUntil.delete(oldest);
    this.lockoutLogged.delete(oldest);
  }

  isLocked(key: string, now = Date.now()): boolean {
    const until = this.lockedUntil.get(key);
    if (until === undefined) return false;
    if (now < until) return true;
    this.lockedUntil.delete(key);
    this.failures.delete(key);
    this.lockoutLogged.delete(key);
    return false;
  }

  recordFailure(key: string, now = Date.now()): void {
    this.evictIfOverCapacity(key);
    const recent = (this.failures.get(key) ?? []).filter((t) => now - t < this.opts.windowMs);
    recent.push(now);
    this.failures.set(key, recent);
    if (recent.length >= this.opts.maxFailures) this.lockedUntil.set(key, now + this.opts.lockoutMs);
  }

  recordSuccess(key: string): void {
    this.failures.delete(key);
    this.lockedUntil.delete(key);
    this.lockoutLogged.delete(key);
  }

  /** True the first time it's called for a key's current lockout; false (suppressed) after, until the lockout clears — so a hammered, already-locked key logs once, not per request. */
  noteLockoutForLogging(key: string): boolean {
    if (this.lockoutLogged.has(key)) return false;
    this.lockoutLogged.add(key);
    return true;
  }
}

const BEARER = /^Bearer (.+)$/;

/** Why a connection attempt was refused — see the A2 refusal log line. */
export type RefusalReason = "unknown-account" | "bad-secret" | "missing-secret" | "locked";

/** Max length of a client-supplied account name once logged. Longer names are truncated, not rejected. */
const MAX_LOGGED_ACCOUNT_LEN = 64;

/** Client-supplied, so never logged verbatim: strips control characters and truncates. */
function sanitizeAccountForLog(account: string): string {
  // eslint-disable-next-line no-control-regex -- deliberately stripping control chars from untrusted input
  const stripped = account.replace(/[\x00-\x1f\x7f]/g, "");
  return stripped.length > MAX_LOGGED_ACCOUNT_LEN ? `${stripped.slice(0, MAX_LOGGED_ACCOUNT_LEN)}…` : stripped;
}

export interface AuthenticatorOptions {
  /** Whether `account` is currently served (passed startup preflight) — an unknown name is always refused. */
  known: (account: string) => boolean;
  /** The configured client secret for `account`, or undefined when none is set. */
  secretOf: (account: string) => string | undefined;
  /** Whether rocketr's own bind address is loopback (not the connecting peer — see ROCKETR_ALLOW_UNAUTHENTICATED_LOOPBACK). */
  loopbackBind: boolean;
  allowUnauthenticatedLoopback: boolean;
  /** The connecting source's address, for rate limiting only. */
  requestIP: (req: Request) => string | undefined;
  /** Called once per connection that used the unauthenticated-loopback fallback. Never passed a secret. */
  onUnauthenticatedLoopback: (account: string) => void;
  /** Called once per refused connection attempt (deduped for "locked" — see FailureRateLimiter.noteLockoutForLogging). Never passed a secret or header content; `account` is already sanitized for logging. */
  onRefused: (info: { account: string; ip: string; reason: RefusalReason }) => void;
  rateLimit?: RateLimitOptions;
}

/**
 * Builds the `auth` callback thatch calls per MCP connection attempt. Refusals are uniform (thatch's
 * own generic 401) to the client, but internally distinguish a reason for the A2 log.
 *
 * Rate-limit key: a known account is keyed on (source IP, account name), so one misbehaving client
 * locks out only its own account at its own IP — not the whole fleet behind a shared loopback
 * address, and not another account's connections. An unknown account name has no real account to
 * isolate by, so those attempts share one per-IP bucket instead (bounding a guessing spree without
 * letting it spoof unlimited distinct keys). Only a presented-and-wrong secret (bad-secret) or an
 * unknown account counts as a failure; a missing secret never does — a client that simply hasn't
 * rolled out its credential yet (the Phase A transition state) must never get itself locked out.
 */
export function createAuthenticator(opts: AuthenticatorOptions): (req: Request, account: string) => boolean {
  const limiter = new FailureRateLimiter(opts.rateLimit ?? DEFAULT_AUTH_RATE_LIMIT);
  return (req, account) => {
    const ip = opts.requestIP(req) ?? "unknown";
    const known = opts.known(account);
    const key = known ? `${ip}\0${account}` : ip;
    const refuse = (reason: RefusalReason) => {
      opts.onRefused({ account: sanitizeAccountForLog(account), ip, reason });
      return false;
    };

    if (limiter.isLocked(key)) {
      if (limiter.noteLockoutForLogging(key)) opts.onRefused({ account: sanitizeAccountForLog(account), ip, reason: "locked" });
      return false;
    }
    if (!known) {
      limiter.recordFailure(key);
      return refuse("unknown-account");
    }

    const secret = opts.secretOf(account);
    if (secret !== undefined) {
      const m = BEARER.exec(req.headers.get("authorization") ?? "");
      if (m && timingSafeEqualStr(m[1]!, secret)) {
        limiter.recordSuccess(key);
        return true;
      }
      if (m) {
        limiter.recordFailure(key);
        return refuse("bad-secret");
      }
      return refuse("missing-secret"); // nothing was presented to compare — not a counted failure
    }
    if (opts.loopbackBind && opts.allowUnauthenticatedLoopback) {
      opts.onUnauthenticatedLoopback(account);
      return true;
    }
    return refuse("missing-secret");
  };
}
