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
}

export const DEFAULT_AUTH_RATE_LIMIT: RateLimitOptions = { maxFailures: 10, windowMs: 5 * 60 * 1000, lockoutMs: 15 * 60 * 1000 };

/**
 * Per-key (source IP) failure tracking with a lockout window. A locked key is refused outright —
 * its credentials are never even checked — so a lockout can't itself be used to distinguish
 * "right secret, wrong account" from "wrong secret" by timing.
 */
export class FailureRateLimiter {
  private readonly failures = new Map<string, number[]>();
  private readonly lockedUntil = new Map<string, number>();

  constructor(private readonly opts: RateLimitOptions) {}

  isLocked(key: string, now = Date.now()): boolean {
    const until = this.lockedUntil.get(key);
    if (until === undefined) return false;
    if (now < until) return true;
    this.lockedUntil.delete(key);
    this.failures.delete(key);
    return false;
  }

  recordFailure(key: string, now = Date.now()): void {
    const recent = (this.failures.get(key) ?? []).filter((t) => now - t < this.opts.windowMs);
    recent.push(now);
    this.failures.set(key, recent);
    if (recent.length >= this.opts.maxFailures) this.lockedUntil.set(key, now + this.opts.lockoutMs);
  }

  recordSuccess(key: string): void {
    this.failures.delete(key);
    this.lockedUntil.delete(key);
  }
}

const BEARER = /^Bearer (.+)$/;

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
  rateLimit?: RateLimitOptions;
}

/** Builds the `auth` callback thatch calls per MCP connection attempt. Refusals are uniform (thatch's own generic 401). */
export function createAuthenticator(opts: AuthenticatorOptions): (req: Request, account: string) => boolean {
  const limiter = new FailureRateLimiter(opts.rateLimit ?? DEFAULT_AUTH_RATE_LIMIT);
  return (req, account) => {
    const ip = opts.requestIP(req) ?? "unknown";
    if (limiter.isLocked(ip)) return false;
    const ok = checkCredentials(opts, req, account);
    if (ok) limiter.recordSuccess(ip);
    else limiter.recordFailure(ip);
    return ok;
  };
}

function checkCredentials(opts: AuthenticatorOptions, req: Request, account: string): boolean {
  if (!opts.known(account)) return false;
  const secret = opts.secretOf(account);
  if (secret !== undefined) {
    const m = BEARER.exec(req.headers.get("authorization") ?? "");
    return !!m && timingSafeEqualStr(m[1]!, secret);
  }
  if (opts.loopbackBind && opts.allowUnauthenticatedLoopback) {
    opts.onUnauthenticatedLoopback(account);
    return true;
  }
  return false;
}
