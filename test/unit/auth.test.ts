import { describe, expect, test } from "bun:test";
import { DEFAULT_AUTH_RATE_LIMIT, FailureRateLimiter, isLoopbackAddress, isLoopbackHost } from "../../src/auth.js";

describe("isLoopbackHost / isLoopbackAddress", () => {
  test("loopback forms", () => {
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
    expect(isLoopbackHost("localhost")).toBe(true);
  });
  test("non-loopback forms", () => {
    expect(isLoopbackHost("0.0.0.0")).toBe(false);
    expect(isLoopbackHost("10.0.0.5")).toBe(false);
    expect(isLoopbackAddress("203.0.113.5")).toBe(false);
    expect(isLoopbackAddress(undefined)).toBe(false);
    expect(isLoopbackAddress(null)).toBe(false);
  });
  test("IPv4-mapped IPv6 loopback counts", () => {
    expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true);
  });
});

describe("FailureRateLimiter", () => {
  test("locks out after the failure threshold within the window, until it expires", () => {
    const limiter = new FailureRateLimiter({ maxFailures: 3, windowMs: 1000, lockoutMs: 500 });
    const t0 = 1_000_000;
    limiter.recordFailure("ip", t0);
    limiter.recordFailure("ip", t0 + 10);
    expect(limiter.isLocked("ip", t0 + 20)).toBe(false);
    limiter.recordFailure("ip", t0 + 20);
    expect(limiter.isLocked("ip", t0 + 30)).toBe(true);
    expect(limiter.isLocked("ip", t0 + 519)).toBe(true);
    expect(limiter.isLocked("ip", t0 + 521)).toBe(false); // lockout expired
  });

  test("failures outside the window don't accumulate", () => {
    const limiter = new FailureRateLimiter({ maxFailures: 2, windowMs: 100, lockoutMs: 1000 });
    const t0 = 0;
    limiter.recordFailure("ip", t0);
    expect(limiter.isLocked("ip", t0 + 200)).toBe(false);
    limiter.recordFailure("ip", t0 + 200); // only one failure still "recent" at this point
    expect(limiter.isLocked("ip", t0 + 200)).toBe(false);
  });

  test("a success clears the count for that key", () => {
    const limiter = new FailureRateLimiter({ maxFailures: 2, windowMs: 1000, lockoutMs: 1000 });
    limiter.recordFailure("ip", 0);
    limiter.recordSuccess("ip");
    limiter.recordFailure("ip", 10);
    expect(limiter.isLocked("ip", 10)).toBe(false);
  });

  test("keys are independent", () => {
    const limiter = new FailureRateLimiter({ maxFailures: 1, windowMs: 1000, lockoutMs: 1000 });
    limiter.recordFailure("a", 0);
    expect(limiter.isLocked("a", 0)).toBe(true);
    expect(limiter.isLocked("b", 0)).toBe(false);
  });

  test("a locked key logs once, then suppresses repeats until the lockout clears", () => {
    const limiter = new FailureRateLimiter({ maxFailures: 1, windowMs: 1000, lockoutMs: 1000 });
    limiter.recordFailure("k", 0);
    expect(limiter.noteLockoutForLogging("k")).toBe(true);
    expect(limiter.noteLockoutForLogging("k")).toBe(false);
    expect(limiter.noteLockoutForLogging("k")).toBe(false);
  });

  test("the map stays bounded: a flood of distinct keys evicts the oldest one, clearing its lockout too", () => {
    const limiter = new FailureRateLimiter({ maxFailures: 1, windowMs: 10_000, lockoutMs: 10_000, maxKeys: 3 });
    limiter.recordFailure("ip1", 0); // locks immediately (maxFailures: 1)
    limiter.recordFailure("ip2", 0);
    limiter.recordFailure("ip3", 0);
    expect(limiter.isLocked("ip1", 0)).toBe(true);
    limiter.recordFailure("ip4", 0); // a 4th distinct key — evicts the oldest (ip1)
    expect(limiter.isLocked("ip1", 0)).toBe(false); // evicted — spoofing distinct names can't grow the map forever
    expect(limiter.isLocked("ip2", 0)).toBe(true);
    expect(limiter.isLocked("ip3", 0)).toBe(true);
    expect(limiter.isLocked("ip4", 0)).toBe(true);
  });

  test("the exported default is sane", () => {
    expect(DEFAULT_AUTH_RATE_LIMIT.maxFailures).toBeGreaterThan(0);
    expect(DEFAULT_AUTH_RATE_LIMIT.windowMs).toBeGreaterThan(0);
    expect(DEFAULT_AUTH_RATE_LIMIT.lockoutMs).toBeGreaterThan(0);
  });
});
