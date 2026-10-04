/**
 * Everything bounding an open relay once auth is gone: connections and credential keys per source
 * IP (and in total, bounding watchers/memory against a flood of distinct keys), a per-connection
 * tool-call rate limit, and request-volume counters that alert once per hour per subject (plus once
 * the first time a brand-new target host is seen — the SSRF-probing signal). Always on; nothing
 * here is inside `checkAccess` and a permissive policy there cannot weaken it.
 */
export interface LimitsOptions {
  maxConnectionsPerIP: number;
  maxKeysPerIP: number;
  maxKeysTotal: number;
  toolCallsPerMinutePerConnection: number;
}

export const DEFAULT_LIMITS: LimitsOptions = {
  maxConnectionsPerIP: 50,
  maxKeysPerIP: 20,
  maxKeysTotal: 2000,
  toolCallsPerMinutePerConnection: 60,
};

/** Per source IP: live connection count and the set of credential keys in use (refcounted so a shared key across several IPs tracks correctly). Also a global key count. */
export class ConnectionLimiter {
  private readonly connectionsByIP = new Map<string, number>();
  private readonly keysByIP = new Map<string, Map<string, number>>();
  private readonly keyTotalRefs = new Map<string, number>();

  constructor(private readonly o: LimitsOptions) {}

  canConnect(ip: string): boolean {
    return (this.connectionsByIP.get(ip) ?? 0) < this.o.maxConnectionsPerIP;
  }

  /** Whether accepting this (ip, key) pair is within the per-IP and total distinct-key caps. Checked BEFORE addConnection. */
  canUseKey(ip: string, key: string): boolean {
    const perIP = this.keysByIP.get(ip);
    const alreadyForIP = perIP?.has(key) ?? false;
    if (!alreadyForIP && (perIP?.size ?? 0) >= this.o.maxKeysPerIP) return false;
    const alreadyTotal = this.keyTotalRefs.has(key);
    if (!alreadyTotal && this.keyTotalRefs.size >= this.o.maxKeysTotal) return false;
    return true;
  }

  addConnection(ip: string, key: string): void {
    this.connectionsByIP.set(ip, (this.connectionsByIP.get(ip) ?? 0) + 1);
    const perIP = this.keysByIP.get(ip) ?? new Map<string, number>();
    perIP.set(key, (perIP.get(key) ?? 0) + 1);
    this.keysByIP.set(ip, perIP);
    this.keyTotalRefs.set(key, (this.keyTotalRefs.get(key) ?? 0) + 1);
  }

  removeConnection(ip: string, key: string): void {
    const conns = (this.connectionsByIP.get(ip) ?? 1) - 1;
    if (conns <= 0) this.connectionsByIP.delete(ip);
    else this.connectionsByIP.set(ip, conns);

    const perIP = this.keysByIP.get(ip);
    if (perIP) {
      const n = (perIP.get(key) ?? 1) - 1;
      if (n <= 0) perIP.delete(key);
      else perIP.set(key, n);
      if (!perIP.size) this.keysByIP.delete(ip);
    }

    const total = (this.keyTotalRefs.get(key) ?? 1) - 1;
    if (total <= 0) this.keyTotalRefs.delete(key);
    else this.keyTotalRefs.set(key, total);
  }
}

/** A sliding one-minute window per connection, so one session can't hammer Rocket.Chat via its tools. */
export class ToolCallLimiter {
  private readonly calls = new Map<string, number[]>();
  constructor(private readonly o: { maxPerMinute: number }) {}

  allow(connectionId: string, now = Date.now()): boolean {
    const recent = (this.calls.get(connectionId) ?? []).filter((t) => now - t < 60_000);
    if (recent.length >= this.o.maxPerMinute) {
      this.calls.set(connectionId, recent);
      return false;
    }
    recent.push(now);
    this.calls.set(connectionId, recent);
    return true;
  }

  forget(connectionId: string): void {
    this.calls.delete(connectionId);
  }
}

const HOUR_MS = 60 * 60 * 1000;

export interface CounterOptions {
  /** Requests/hour from one source IP before an ALERT line is emitted (once per hour while it stays over). */
  perIPAlertThreshold: number;
  log: (line: string) => void;
}

/**
 * Counts only — never request/response bodies or query strings. Rolling-hour counts per source IP
 * and per target host, kept in memory; an ALERT line fires once per hour per subject when a source
 * IP crosses the threshold, and once, ever, the first time a new target host is seen at all (the
 * SSRF-probing signal — legitimate traffic should only ever name the clients' own common host).
 */
export class RequestCounters {
  private readonly byIP = new Map<string, number[]>();
  private readonly byHost = new Map<string, number[]>();
  private readonly knownHosts = new Set<string>();
  private readonly lastAlertAt = new Map<string, number>();

  constructor(private readonly o: CounterOptions) {}

  record(ip: string, host: string, now = Date.now()): void {
    this.bump(this.byIP, ip, now);
    this.bump(this.byHost, host, now);

    if (!this.knownHosts.has(host)) {
      this.knownHosts.add(host);
      // The very first host seen (right after startup) is expected and not itself alarming on its own;
      // still logged, because a log reader deciding "is this the common host" needs to see it appear.
      this.o.log(`ALERT: new target host seen for the first time: ${host}`);
    }

    const ipCount = this.byIP.get(ip)!.length;
    if (ipCount > this.o.perIPAlertThreshold) this.maybeAlert(ip, "source IP", ipCount, now);
  }

  private bump(map: Map<string, number[]>, key: string, now: number): void {
    const recent = (map.get(key) ?? []).filter((t) => now - t < HOUR_MS);
    recent.push(now);
    map.set(key, recent);
  }

  private maybeAlert(subject: string, kind: string, count: number, now = Date.now()): void {
    const last = this.lastAlertAt.get(subject);
    if (last !== undefined && now - last < HOUR_MS) return;
    this.lastAlertAt.set(subject, now);
    this.o.log(`ALERT: ${kind} "${subject}" at ${count} requests/hour, over the ${this.o.perIPAlertThreshold}/hour threshold`);
  }
}
