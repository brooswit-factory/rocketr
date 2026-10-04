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
const MINUTE_MS = 60 * 1000;
const MINUTES_PER_HOUR = 60;
/** Distinct subjects (IPs or hosts) tracked at once per structure below; oldest is evicted first — bounds memory against a flood of distinct values (e.g. cycling source IPs or probe hostnames). */
const MAX_TRACKED_SUBJECTS = 10_000;
/** New-target-host ALERT lines emitted per hour, globally, before the rest are counted and summarized instead of logged one-by-one. */
const MAX_NEW_HOST_ALERTS_PER_HOUR = 20;

export interface CounterOptions {
  /** Requests/hour from one source IP before an ALERT line is emitted (once per hour while it stays over). */
  perIPAlertThreshold: number;
  log: (line: string) => void;
}

/**
 * Per-subject request counts bucketed by minute (never one entry per request — a subject's memory
 * footprint is capped at 60 buckets regardless of request volume) and pruned to the trailing hour
 * on every access. The number of distinct subjects tracked at once is itself capped, oldest evicted
 * first, so a flood of distinct IPs or hostnames can't grow this without bound either.
 */
class MinuteBucketCounter {
  private readonly buckets = new Map<string, Map<number, number>>();
  private readonly order: string[] = [];

  constructor(private readonly maxSubjects = MAX_TRACKED_SUBJECTS) {}

  /** Records one hit for `subject` at `now` and returns its trailing-hour total. */
  bump(subject: string, now: number): number {
    let bucket = this.buckets.get(subject);
    if (!bucket) {
      bucket = new Map<number, number>();
      this.buckets.set(subject, bucket);
      this.order.push(subject);
      if (this.order.length > this.maxSubjects) {
        const oldest = this.order.shift()!;
        this.buckets.delete(oldest);
      }
    }
    const minuteKey = Math.floor(now / MINUTE_MS);
    for (const k of bucket.keys()) if (minuteKey - k >= MINUTES_PER_HOUR) bucket.delete(k);
    bucket.set(minuteKey, (bucket.get(minuteKey) ?? 0) + 1);
    let total = 0;
    for (const v of bucket.values()) total += v;
    return total;
  }
}

/** A Set bounded to `max` entries, oldest evicted first. */
class BoundedSet<T> {
  private readonly set = new Set<T>();
  private readonly order: T[] = [];
  constructor(private readonly max = MAX_TRACKED_SUBJECTS) {}
  has(v: T): boolean { return this.set.has(v); }
  add(v: T): void {
    if (this.set.has(v)) return;
    this.set.add(v);
    this.order.push(v);
    if (this.order.length > this.max) this.set.delete(this.order.shift()!);
  }
}

/**
 * Counts only — never request/response bodies or query strings. Trailing-hour counts per source IP
 * and per target host, kept in memory and bounded (see `MinuteBucketCounter`/`BoundedSet` above); an
 * ALERT line fires once per hour per subject when a source IP crosses the threshold, and once per
 * new target host (the SSRF-probing signal — legitimate traffic should only ever name the clients'
 * own common host) — capped at a small number of such lines per hour, with the rest counted into one
 * suppression summary instead of flooding the log.
 */
export class RequestCounters {
  private readonly byIP = new MinuteBucketCounter();
  private readonly byHost = new MinuteBucketCounter();
  private readonly knownHosts = new BoundedSet<string>();
  private readonly lastAlertAt = new Map<string, number>();
  private readonly lastAlertOrder: string[] = [];
  private newHostAlertWindowStart = 0;
  private newHostAlertsThisWindow = 0;
  private suppressedThisWindow = 0;

  constructor(private readonly o: CounterOptions) {}

  record(ip: string, host: string, now = Date.now()): void {
    const ipCount = this.byIP.bump(ip, now);
    this.byHost.bump(host, now);

    if (now - this.newHostAlertWindowStart >= HOUR_MS) {
      if (this.suppressedThisWindow > 0) {
        this.o.log(`ALERT: ${this.suppressedThisWindow} further new-target-host alert(s) suppressed in the previous hour`);
      }
      this.newHostAlertWindowStart = now;
      this.newHostAlertsThisWindow = 0;
      this.suppressedThisWindow = 0;
    }
    if (!this.knownHosts.has(host)) {
      this.knownHosts.add(host);
      if (this.newHostAlertsThisWindow < MAX_NEW_HOST_ALERTS_PER_HOUR) {
        this.newHostAlertsThisWindow++;
        // The very first host seen (right after startup) is expected and not itself alarming on its own;
        // still logged, because a log reader deciding "is this the common host" needs to see it appear.
        this.o.log(`ALERT: new target host seen for the first time: ${host}`);
      } else {
        this.suppressedThisWindow++;
      }
    }

    if (ipCount > this.o.perIPAlertThreshold) this.maybeAlert(ip, "source IP", ipCount, now);
  }

  private maybeAlert(subject: string, kind: string, count: number, now: number): void {
    const last = this.lastAlertAt.get(subject);
    if (last !== undefined && now - last < HOUR_MS) return;
    if (!this.lastAlertAt.has(subject)) {
      this.lastAlertOrder.push(subject);
      if (this.lastAlertOrder.length > MAX_TRACKED_SUBJECTS) this.lastAlertAt.delete(this.lastAlertOrder.shift()!);
    }
    this.lastAlertAt.set(subject, now);
    this.o.log(`ALERT: ${kind} "${subject}" at ${count} requests/hour, over the ${this.o.perIPAlertThreshold}/hour threshold`);
  }
}
