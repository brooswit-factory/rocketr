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
    onRefused: () => {},
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

  describe("refusal log (A2)", () => {
    const refusals = () => { const log: Array<{ account: string; ip: string; reason: string }> = []; return { log, onRefused: (info: any) => log.push(info) }; };

    test("each reason logs exactly what happened", () => {
      const secret = "s".repeat(32);
      const { log, onRefused } = refusals();
      const auth = createAuthenticator({ ...base, onRefused, secretOf: (a) => (a === "claude" ? secret : undefined), loopbackBind: true, allowUnauthenticatedLoopback: false });

      auth(req(), "nobody"); // unknown-account
      auth(req({ authorization: "Bearer " + "w".repeat(32) }), "claude"); // bad-secret
      auth(req(), "claude"); // missing-secret (secret configured, nothing presented)

      expect(log).toEqual([
        { account: "nobody", ip: "198.51.100.1", reason: "unknown-account" },
        { account: "claude", ip: "198.51.100.1", reason: "bad-secret" },
        { account: "claude", ip: "198.51.100.1", reason: "missing-secret" },
      ]);
    });

    test("an account with no secret configured, refused because the transition flag is off, logs missing-secret", () => {
      const { log, onRefused } = refusals();
      const auth = createAuthenticator({ ...base, onRefused, secretOf: () => undefined, loopbackBind: true, allowUnauthenticatedLoopback: false });
      auth(req(), "claude");
      expect(log).toEqual([{ account: "claude", ip: "198.51.100.1", reason: "missing-secret" }]);
    });

    test("the allowed unauthenticated-loopback path is not a refusal: no log line", () => {
      const { log, onRefused } = refusals();
      const auth = createAuthenticator({ ...base, onRefused, secretOf: () => undefined, loopbackBind: true, allowUnauthenticatedLoopback: true });
      expect(auth(req(), "claude")).toBe(true);
      expect(log).toEqual([]);
    });

    test("never logs the secret, the Authorization header, or any part of it", () => {
      const secret = "s".repeat(32);
      const { log, onRefused } = refusals();
      const auth = createAuthenticator({ ...base, onRefused, secretOf: () => secret, loopbackBind: true, allowUnauthenticatedLoopback: true });
      auth(req({ authorization: `Bearer ${secret}-but-wrong` }), "claude");
      const dump = JSON.stringify(log);
      expect(dump).not.toContain(secret);
      expect(dump.toLowerCase()).not.toContain("bearer");
      expect(dump.toLowerCase()).not.toContain("authorization");
    });

    test("a client-supplied account name is stripped of control characters and truncated before logging", () => {
      const { log, onRefused } = refusals();
      const auth = createAuthenticator({ ...base, onRefused, known: () => false, secretOf: () => undefined, loopbackBind: true, allowUnauthenticatedLoopback: false });
      const dirty = "evil name" + "x".repeat(100);
      auth(req(), dirty);
      expect(log[0]!.account).not.toMatch(/[\x00-\x1f\x7f]/);
      expect(log[0]!.account.length).toBeLessThanOrEqual(65); // MAX_LOGGED_ACCOUNT_LEN + the truncation marker
    });

    test("a locked key logs once, then suppresses repeats until the lockout clears", () => {
      const secret = "s".repeat(32);
      const { log, onRefused } = refusals();
      const auth = createAuthenticator({
        ...base, onRefused, secretOf: () => secret, loopbackBind: true, allowUnauthenticatedLoopback: true,
        rateLimit: { maxFailures: 1, windowMs: 10_000, lockoutMs: 10_000 },
      });
      auth(req({ authorization: "Bearer wrong" }), "claude"); // bad-secret, triggers the lock
      auth(req({ authorization: `Bearer ${secret}` }), "claude"); // locked — logged once
      auth(req({ authorization: `Bearer ${secret}` }), "claude"); // locked — suppressed
      auth(req({ authorization: `Bearer ${secret}` }), "claude"); // locked — suppressed
      expect(log.map((l) => l.reason)).toEqual(["bad-secret", "locked"]);
    });
  });

  describe("per-(IP, account) lockout (A3)", () => {
    test("a bad client on account X does not lock account Y at the same IP", () => {
      const secretX = "x".repeat(32), secretY = "y".repeat(32);
      const auth = createAuthenticator({
        ...base, known: (a) => a === "x" || a === "y", secretOf: (a) => (a === "x" ? secretX : secretY),
        loopbackBind: true, allowUnauthenticatedLoopback: true,
        rateLimit: { maxFailures: 1, windowMs: 10_000, lockoutMs: 10_000 },
      });
      expect(auth(req({ authorization: "Bearer wrong" }), "x")).toBe(false); // locks (ip, x)
      expect(auth(req({ authorization: `Bearer ${secretY}` }), "y")).toBe(true); // (ip, y) unaffected
    });

    test("unknown-account attempts from one IP share a single per-IP bucket, isolated from known accounts at that IP", () => {
      const secret = "s".repeat(32);
      const auth = createAuthenticator({
        ...base, known: (a) => a === "claude", secretOf: () => secret, loopbackBind: true, allowUnauthenticatedLoopback: true,
        rateLimit: { maxFailures: 2, windowMs: 10_000, lockoutMs: 10_000 },
      });
      expect(auth(req(), "ghost1")).toBe(false);
      expect(auth(req(), "ghost2")).toBe(false); // second distinct unknown name from the same IP — still locks the shared bucket
      expect(auth(req(), "ghost3")).toBe(false); // now locked
      expect(auth(req({ authorization: `Bearer ${secret}` }), "claude")).toBe(true); // claude's own key is untouched
    });

    test("a missing secret is never counted as a failure, so it cannot lock anyone out — neither branch that produces it", () => {
      // branch 1: no secret configured for the account, and the transition flag is off (so the
      // unauthenticated-loopback path doesn't apply either) — refused, but not for a credential reason.
      {
        const log: Array<{ reason: string }> = [];
        const auth = createAuthenticator({
          ...base, onRefused: (info) => log.push(info), secretOf: () => undefined, loopbackBind: true, allowUnauthenticatedLoopback: false,
          rateLimit: { maxFailures: 1, windowMs: 10_000, lockoutMs: 10_000 },
        });
        for (let i = 0; i < 5; i++) expect(auth(req(), "claude")).toBe(false);
        // every one of those 5 refusals must be its own missing-secret reason, never "locked" —
        // with maxFailures: 1, a single counted failure would lock the key and turn every
        // subsequent refusal's reason into "locked" instead.
        expect(log.map((l) => l.reason)).toEqual(Array(5).fill("missing-secret"));
      }
      // branch 2: a secret IS configured for the account, but the client presents no Authorization
      // header at all (as opposed to a wrong one, which is bad-secret and DOES count).
      {
        const secret = "s".repeat(32);
        const log: Array<{ reason: string }> = [];
        const auth = createAuthenticator({
          ...base, onRefused: (info) => log.push(info), secretOf: () => secret, loopbackBind: true, allowUnauthenticatedLoopback: true,
          rateLimit: { maxFailures: 1, windowMs: 10_000, lockoutMs: 10_000 },
        });
        for (let i = 0; i < 5; i++) expect(auth(req(), "claude")).toBe(false);
        expect(log.map((l) => l.reason)).toEqual(Array(5).fill("missing-secret"));
        // and the key was truly never touched: the correct credential still succeeds afterwards.
        expect(auth(req({ authorization: `Bearer ${secret}` }), "claude")).toBe(true);
      }
    });

    test("a success resets the key, clearing any accumulated failures", () => {
      const secret = "s".repeat(32);
      const auth = createAuthenticator({
        ...base, secretOf: () => secret, loopbackBind: true, allowUnauthenticatedLoopback: true,
        rateLimit: { maxFailures: 2, windowMs: 10_000, lockoutMs: 10_000 },
      });
      expect(auth(req({ authorization: "Bearer wrong" }), "claude")).toBe(false);
      expect(auth(req({ authorization: `Bearer ${secret}` }), "claude")).toBe(true); // success resets the count
      expect(auth(req({ authorization: "Bearer wrong" }), "claude")).toBe(false); // 1 of 2 again, not locked yet
      expect(auth(req({ authorization: `Bearer ${secret}` }), "claude")).toBe(true);
    });

    test("recovers after the lockout window elapses", () => {
      const limiter = new FailureRateLimiter({ maxFailures: 1, windowMs: 10_000, lockoutMs: 100 });
      limiter.recordFailure("ip claude", 0);
      expect(limiter.isLocked("ip claude", 50)).toBe(true);
      expect(limiter.isLocked("ip claude", 150)).toBe(false);
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
  });
});
