import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { FakeRocketChat } from "./fake-rocketchat.js";
import { CredentialRejected, SessionManager, credentialKey, type Session } from "../../src/session.js";

let fake: FakeRocketChat;
beforeEach(() => { fake = new FakeRocketChat().start(); });
afterEach(() => fake.stop());

function manager(overrides: Partial<ConstructorParameters<typeof SessionManager>[0]> = {}) {
  const created: Session[] = [];
  const torndown: Session[] = [];
  const mgr = new SessionManager({
    gracePeriodMs: 50,
    backoffMs: 200,
    fetchOverride: fetch,
    onCreate: (s) => created.push(s),
    onTeardown: (s) => torndown.push(s),
    ...overrides,
  });
  return { mgr, created, torndown };
}

const credsFor = (fake: FakeRocketChat, u: "bot1" | "bot2" = "bot1") => ({ url: fake.url, userId: u, token: fake.tokens.get(u)! });
const opts = { notify: "mentions" as const, batchMs: 0, pollMs: 3000, lookbackSec: 0 };

describe("SessionManager", () => {
  test("validates a new credential key against /me before returning it", async () => {
    const { mgr } = manager();
    const session = await mgr.acquire(credsFor(fake), opts);
    expect(session.self.username).toBe("claude");
    expect(session.refCount).toBe(1);
  });

  test("connections sharing a credential key share one session (one watcher)", async () => {
    const { mgr } = manager();
    const a = await mgr.acquire(credsFor(fake), opts);
    const b = await mgr.acquire(credsFor(fake), opts);
    expect(a).toBe(b);
    expect(a.refCount).toBe(2);
  });

  test("two different credential keys get two different sessions", async () => {
    const { mgr } = manager();
    const a = await mgr.acquire(credsFor(fake, "bot1"), opts);
    const b = await mgr.acquire(credsFor(fake, "bot2"), opts);
    expect(a).not.toBe(b);
    expect(a.self.username).toBe("claude");
    expect(b.self.username).toBe("lead");
  });

  test("is torn down after the last connection releases it, plus the grace period", async () => {
    const { mgr, torndown } = manager();
    await mgr.acquire(credsFor(fake), opts);
    await mgr.acquire(credsFor(fake), opts);
    const key = credentialKey(credsFor(fake));
    mgr.release(key);
    mgr.release(key);
    expect(mgr.get(key)).toBeDefined(); // still here — grace period hasn't elapsed
    await new Promise((r) => setTimeout(r, 120));
    expect(mgr.get(key)).toBeUndefined();
    expect(torndown).toHaveLength(1);
  });

  test("a reconnect before the grace period elapses cancels the teardown and reuses the session", async () => {
    const { mgr, created, torndown } = manager();
    await mgr.acquire(credsFor(fake), opts);
    const key = credentialKey(credsFor(fake));
    mgr.release(key);
    await new Promise((r) => setTimeout(r, 10));
    const again = await mgr.acquire(credsFor(fake), opts);
    await new Promise((r) => setTimeout(r, 80)); // past the original grace period
    expect(mgr.get(key)).toBe(again);
    expect(torndown).toHaveLength(0);
    expect(created).toHaveLength(1); // never recreated — the same session was reused throughout
  });

  test("a 401 is rejected as invalid-credentials and starts a backoff window — no second /me call while backed off", async () => {
    let calls = 0;
    const countingFetch = ((...args: Parameters<typeof fetch>) => { calls++; return fetch(...args); }) as typeof fetch;
    const { mgr } = manager({ fetchOverride: countingFetch, backoffMs: 60_000 });
    const bad = { url: fake.url, userId: "bot1", token: "wrong-token" };
    await expect(mgr.acquire(bad, opts)).rejects.toBeInstanceOf(CredentialRejected);
    expect(calls).toBe(1);
    await expect(mgr.acquire(bad, opts)).rejects.toMatchObject({ reason: "invalid-credentials" });
    expect(calls).toBe(1); // backed off — no second network call, even with the same bad credential
  });

  test("acquiring concurrently with the same new key only validates once (no duplicate /me calls)", async () => {
    let calls = 0;
    const countingFetch = ((...args: Parameters<typeof fetch>) => { calls++; return fetch(...args); }) as typeof fetch;
    const { mgr } = manager({ fetchOverride: countingFetch });
    const [a, b] = await Promise.all([mgr.acquire(credsFor(fake), opts), mgr.acquire(credsFor(fake), opts)]);
    expect(a).toBe(b);
    expect(a.refCount).toBe(2);
    expect(calls).toBe(1); // exactly one /me call validated the key, even though two connections raced in
  });

  test("blocked-url: an https target that resolves to a denied address is rejected before any RocketChat call", async () => {
    // No fetchOverride here — this exercises the real ssrfSafeFetch path via a fake resolver.
    const { mgr } = manager({ fetchOverride: undefined, resolver: { resolve4: async () => ["127.0.0.1"], resolve6: async () => [] } });
    await expect(mgr.acquire({ url: "https://internal.invalid", userId: "x", token: "y" }, opts)).rejects.toMatchObject({ reason: "blocked-url" });
  });
});
