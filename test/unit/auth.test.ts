import { describe, expect, test } from "bun:test";
import {
  createAuthenticator, DEFAULT_AUTH_RATE_LIMIT, FailureRateLimiter, isLoopbackAddress, isLoopbackHost, timingSafeEqualStr,
} from "../../src/auth.js";

describe("timingSafeEqualStr", () => {
  test("matches equal strings", () => {
    expect(timingSafeEqualStr("a-long-enough-secret-value", "a-long-enough-secret-value")).toBe(true);
  });

  test("rejects a mismatch of the same length", () => {
    expect(timingSafeEqualStr("a-long-enough-secret-value", "b-long-enough-secret-value")).toBe(false);
  });

  test("rejects a length mismatch without throwing (unlike crypto.timingSafeEqual)", () => {
    expect(timingSafeEqualStr("short", "a-much-longer-string-than-that")).toBe(false);
    expect(timingSafeEqualStr("", "nonempty")).toBe(false);
    expect(timingSafeEqualStr("", "")).toBe(true);
  });
});

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

  test("the exported default is sane", () => {
    expect(DEFAULT_AUTH_RATE_LIMIT.maxFailures).toBeGreaterThan(0);
    expect(DEFAULT_AUTH_RATE_LIMIT.windowMs).toBeGreaterThan(0);
    expect(DEFAULT_AUTH_RATE_LIMIT.lockoutMs).toBeGreaterThan(0);
  });
});

describe("createAuthenticator", () => {
  const req = (headers: Record<string, string> = {}) => new Request("http://x/", { headers });
  const base = {
    known: (a: string) => a === "claude",
    requestIP: () => "198.51.100.1",
    onUnauthenticatedLoopback: () => {},
  };

  test("an unknown account is refused even with a correct-looking bearer", () => {
    const auth = createAuthenticator({ ...base, secretOf: () => "x".repeat(32), loopbackBind: true, allowUnauthenticatedLoopback: true });
    expect(auth(req({ authorization: "Bearer " + "x".repeat(32) }), "nobody")).toBe(false);
  });

  describe("account has a secret configured", () => {
    const secret = "s".repeat(32);
    const auth = () => createAuthenticator({ ...base, secretOf: () => secret, loopbackBind: true, allowUnauthenticatedLoopback: true });

    test("the correct bearer is accepted", () => {
      expect(auth()(req({ authorization: `Bearer ${secret}` }), "claude")).toBe(true);
    });
    test("a wrong bearer is refused", () => {
      expect(auth()(req({ authorization: "Bearer " + "w".repeat(32) }), "claude")).toBe(false);
    });
    test("a missing bearer is refused, even though unauthenticated loopback is allowed", () => {
      expect(auth()(req(), "claude")).toBe(false);
    });
    test("a non-Bearer or malformed Authorization header is refused", () => {
      expect(auth()(req({ authorization: secret }), "claude")).toBe(false);
      expect(auth()(req({ authorization: "Basic " + secret }), "claude")).toBe(false);
    });
  });

  describe("account has no secret configured", () => {
    test("allowed while loopback-bound and the transition flag is on", () => {
      let warned: string | undefined;
      const auth = createAuthenticator({
        ...base, secretOf: () => undefined, loopbackBind: true, allowUnauthenticatedLoopback: true,
        onUnauthenticatedLoopback: (a) => { warned = a; },
      });
      expect(auth(req(), "claude")).toBe(true);
      expect(warned).toBe("claude");
    });

    test("refused when the transition flag is off, even though bound loopback", () => {
      const auth = createAuthenticator({ ...base, secretOf: () => undefined, loopbackBind: true, allowUnauthenticatedLoopback: false });
      expect(auth(req(), "claude")).toBe(false);
    });

    test("refused when the bind is not loopback, even with the transition flag on", () => {
      const auth = createAuthenticator({ ...base, secretOf: () => undefined, loopbackBind: false, allowUnauthenticatedLoopback: true });
      expect(auth(req(), "claude")).toBe(false);
    });

    test("a bearer presented anyway is irrelevant — the account just has no secret to check it against", () => {
      const auth = createAuthenticator({ ...base, secretOf: () => undefined, loopbackBind: true, allowUnauthenticatedLoopback: true });
      expect(auth(req({ authorization: "Bearer whatever" }), "claude")).toBe(true);
    });
  });

  test("the Rocket.Chat token is never accepted as a client secret: only the configured clientSecret is compared", () => {
    const clientSecret = "c".repeat(32), rcToken = "t".repeat(32);
    const auth = createAuthenticator({ ...base, secretOf: () => clientSecret, loopbackBind: true, allowUnauthenticatedLoopback: true });
    expect(auth(req({ authorization: `Bearer ${rcToken}` }), "claude")).toBe(false);
    expect(auth(req({ authorization: `Bearer ${clientSecret}` }), "claude")).toBe(true);
  });

  test("a locked-out source is refused outright, even with the correct secret", () => {
    const secret = "s".repeat(32);
    const auth = createAuthenticator({
      ...base, secretOf: () => secret, loopbackBind: true, allowUnauthenticatedLoopback: true,
      rateLimit: { maxFailures: 2, windowMs: 10_000, lockoutMs: 10_000 },
    });
    expect(auth(req({ authorization: "Bearer wrong" }), "claude")).toBe(false);
    expect(auth(req({ authorization: "Bearer wrong" }), "claude")).toBe(false);
    expect(auth(req({ authorization: `Bearer ${secret}` }), "claude")).toBe(false); // now locked out
  });
});
