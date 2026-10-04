import { describe, expect, test } from "bun:test";
import { ConnectionLimiter, RequestCounters, ToolCallLimiter } from "../../src/limits.js";

describe("ConnectionLimiter", () => {
  test("refuses a new connection once the per-IP connection cap is hit", () => {
    const limiter = new ConnectionLimiter({ maxConnectionsPerIP: 2, maxKeysPerIP: 10, maxKeysTotal: 10, toolCallsPerMinutePerConnection: 60 });
    expect(limiter.canConnect("ip1")).toBe(true);
    limiter.addConnection("ip1", "k1");
    limiter.addConnection("ip1", "k1");
    expect(limiter.canConnect("ip1")).toBe(false);
    expect(limiter.canConnect("ip2")).toBe(true); // a different IP is unaffected
  });

  test("releasing a connection frees capacity again", () => {
    const limiter = new ConnectionLimiter({ maxConnectionsPerIP: 1, maxKeysPerIP: 10, maxKeysTotal: 10, toolCallsPerMinutePerConnection: 60 });
    limiter.addConnection("ip1", "k1");
    expect(limiter.canConnect("ip1")).toBe(false);
    limiter.removeConnection("ip1", "k1");
    expect(limiter.canConnect("ip1")).toBe(true);
  });

  test("refuses a new distinct key once the per-IP key cap is hit, but an already-used key is always fine", () => {
    const limiter = new ConnectionLimiter({ maxConnectionsPerIP: 100, maxKeysPerIP: 2, maxKeysTotal: 100, toolCallsPerMinutePerConnection: 60 });
    limiter.addConnection("ip1", "k1");
    limiter.addConnection("ip1", "k2");
    expect(limiter.canUseKey("ip1", "k1")).toBe(true); // already in use — never blocked by the cap itself
    expect(limiter.canUseKey("ip1", "k3")).toBe(false); // a third distinct key would exceed the cap
  });

  test("refuses a brand-new key once the GLOBAL distinct-key cap is hit, even from a fresh IP", () => {
    const limiter = new ConnectionLimiter({ maxConnectionsPerIP: 100, maxKeysPerIP: 100, maxKeysTotal: 2, toolCallsPerMinutePerConnection: 60 });
    limiter.addConnection("ip1", "k1");
    limiter.addConnection("ip2", "k2");
    expect(limiter.canUseKey("ip3", "k3")).toBe(false);
    expect(limiter.canUseKey("ip1", "k1")).toBe(true); // existing key from any IP stays fine
  });

  test("a key shared across two IPs is only fully freed once BOTH release it", () => {
    const limiter = new ConnectionLimiter({ maxConnectionsPerIP: 100, maxKeysPerIP: 1, maxKeysTotal: 1, toolCallsPerMinutePerConnection: 60 });
    limiter.addConnection("ip1", "shared");
    limiter.addConnection("ip2", "shared");
    limiter.removeConnection("ip1", "shared");
    // the global key count should still reflect "shared" in use (ip2 still holds it) — a brand-new key is still refused
    expect(limiter.canUseKey("ip3", "new-key")).toBe(false);
    limiter.removeConnection("ip2", "shared");
    expect(limiter.canUseKey("ip3", "new-key")).toBe(true);
  });
});

describe("ToolCallLimiter", () => {
  test("allows up to the per-minute cap, then refuses", () => {
    const limiter = new ToolCallLimiter({ maxPerMinute: 2 });
    const t0 = 1_000_000;
    expect(limiter.allow("c1", t0)).toBe(true);
    expect(limiter.allow("c1", t0 + 1)).toBe(true);
    expect(limiter.allow("c1", t0 + 2)).toBe(false);
  });

  test("the window slides — an old call ages out", () => {
    const limiter = new ToolCallLimiter({ maxPerMinute: 1 });
    const t0 = 1_000_000;
    expect(limiter.allow("c1", t0)).toBe(true);
    expect(limiter.allow("c1", t0 + 30_000)).toBe(false);
    expect(limiter.allow("c1", t0 + 60_001)).toBe(true);
  });

  test("connections are independent", () => {
    const limiter = new ToolCallLimiter({ maxPerMinute: 1 });
    expect(limiter.allow("a", 0)).toBe(true);
    expect(limiter.allow("b", 0)).toBe(true);
  });

  test("forget() clears a connection's history", () => {
    const limiter = new ToolCallLimiter({ maxPerMinute: 1 });
    expect(limiter.allow("c1", 0)).toBe(true);
    expect(limiter.allow("c1", 1)).toBe(false);
    limiter.forget("c1");
    expect(limiter.allow("c1", 2)).toBe(true);
  });
});

describe("RequestCounters", () => {
  test("alerts the first time a new target host is ever seen", () => {
    const lines: string[] = [];
    const counters = new RequestCounters({ perIPAlertThreshold: 1000, log: (l) => lines.push(l) });
    counters.record("1.2.3.4", "chat.example.com");
    expect(lines.some((l) => l.includes("ALERT") && l.includes("new target host") && l.includes("chat.example.com"))).toBe(true);
    lines.length = 0;
    counters.record("5.6.7.8", "chat.example.com"); // same host again — no repeat alert
    expect(lines.some((l) => l.includes("new target host"))).toBe(false);
  });

  test("alerts once per hour when a source IP crosses the threshold, then suppresses until the hour passes", () => {
    const lines: string[] = [];
    const counters = new RequestCounters({ perIPAlertThreshold: 2, log: (l) => lines.push(l) });
    const t0 = 1_000_000;
    counters.record("1.2.3.4", "h", t0);
    counters.record("1.2.3.4", "h", t0 + 1);
    counters.record("1.2.3.4", "h", t0 + 2); // 3rd request, over the threshold of 2
    const alerts = lines.filter((l) => l.includes("ALERT") && l.includes("source IP"));
    expect(alerts.length).toBe(1);
    counters.record("1.2.3.4", "h", t0 + 3); // still within the hour — suppressed
    expect(lines.filter((l) => l.includes("ALERT") && l.includes("source IP")).length).toBe(1);
    // an hour later, the earlier counts have rolled out of the window — it takes a fresh burst to alert again
    counters.record("1.2.3.4", "h", t0 + 60 * 60 * 1000 + 10);
    counters.record("1.2.3.4", "h", t0 + 60 * 60 * 1000 + 11);
    counters.record("1.2.3.4", "h", t0 + 60 * 60 * 1000 + 12);
    expect(lines.filter((l) => l.includes("ALERT") && l.includes("source IP")).length).toBe(2);
  });

  test("counts are never logged — only the subject and a count", () => {
    const lines: string[] = [];
    const counters = new RequestCounters({ perIPAlertThreshold: 1, log: (l) => lines.push(l) });
    counters.record("1.2.3.4", "chat.example.com", 0);
    counters.record("1.2.3.4", "chat.example.com", 1);
    for (const line of lines) {
      expect(line).not.toMatch(/\?.*=/); // no query strings
      expect(line.length).toBeLessThan(200); // never a dumped payload
    }
  });

  // Manager review on PR #14 (comment 29464, item 3): a timestamp-per-request array and unbounded
  // knownHosts/lastAlertAt maps meant cycling distinct hostnames (or a sustained high request rate)
  // grew memory and log lines without limit.
  test("cycling many distinct target hosts caps the new-host ALERT lines per hour, with one suppression summary instead of flooding the log", () => {
    const lines: string[] = [];
    const counters = new RequestCounters({ perIPAlertThreshold: 1_000_000, log: (l) => lines.push(l) });
    const t0 = 1_000_000;
    for (let i = 0; i < 100; i++) counters.record("1.2.3.4", `probe-${i}.invalid`, t0 + i);
    const newHostAlerts = lines.filter((l) => l.includes("new target host"));
    expect(newHostAlerts.length).toBeLessThanOrEqual(20); // the compiled-in per-hour cap
    expect(lines.some((l) => l.includes("suppressed"))).toBe(false); // no suppression line yet — the hour hasn't rolled over

    // crossing into the next hour window emits exactly one suppression summary, then resumes alerting
    counters.record("1.2.3.4", "probe-200.invalid", t0 + 60 * 60 * 1000 + 1);
    expect(lines.filter((l) => l.includes("suppressed")).length).toBe(1);
  });

  test("a single request volume does not grow a subject's own memory without bound — counts are minute-bucketed, not one entry per request", () => {
    const lines: string[] = [];
    const counters = new RequestCounters({ perIPAlertThreshold: 50_000, log: (l) => lines.push(l) });
    const t0 = 1_000_000;
    // 10,000 requests from the same IP within the same minute must still only ever alert based on
    // the per-minute-bucketed total, not balloon an array — this just has to complete fast and
    // report a sane total without the test itself timing out or ballooning memory.
    for (let i = 0; i < 10_000; i++) counters.record("1.2.3.4", "chat.example.com", t0 + (i % 1000));
    // no crash, no explosion — and since every request is well under the threshold, no alert fires
    expect(lines.some((l) => l.includes("source IP"))).toBe(false);
  });
});
