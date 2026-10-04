/**
 * No client auth in this version (design v3.1): Rocket.Chat itself authenticates the credentials a
 * client presents, so the proxy needs no bearer secret of its own. What's left here is the
 * reusable machinery the old per-account auth already had — loopback/address checks and a bounded,
 * windowed failure limiter — now re-keyed on source IP and credential key instead of account name.
 */

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
 * Per-key failure tracking with a lockout window. A locked key is refused outright — nothing it
 * presents is even checked — so a lockout can't itself be used to distinguish one refusal reason
 * from another by timing. The key is caller-chosen: today, a credential-key hash for the post-401
 * backoff, or a composite of (source IP, ...) for other limits.
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

/** Why a connection attempt was refused — see the refusal log line. */
export type RefusalReason = "invalid-credentials" | "blocked-url" | "limit-exceeded";
