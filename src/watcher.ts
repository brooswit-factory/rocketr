import type { Frame } from "@brooswit/thatch";
import type { Message, NotifyLevel, RocketChat, RoomType, Subscription, User } from "./rocketchat.js";

/** Strongest first: a batch carries the strongest kind among its messages. */
export const KINDS = ["dm", "mention", "thread", "channel"] as const;
export type Kind = (typeof KINDS)[number];

export interface InboundEvent {
  kind: Kind;
  message: Message;
  room: { id: string; name: string; type: RoomType };
}

/** The room's level for this account: its own saved preference, else `fallback`. "Mute all" wins over both. */
export function levelOf(sub: Subscription, fallback: NotifyLevel): NotifyLevel {
  if (sub.disableNotifications) return "nothing";
  const own = sub.desktopNotifications;
  return own && own !== "default" ? own : fallback;
}

/**
 * Should this message reach a session? The recipient's own Rocket.Chat preference for the room decides, the way it
 * decides a person's desktop alerts: `all` pushes everything; `mentions` pushes DMs, @mentions (@all/@here unless
 * group mentions are muted) and replies in followed threads; `nothing` pushes nothing. Any sender counts — there is
 * no allowlist, so text from anyone in the room can reach the agent. Own, system and ignored users' messages never do.
 */
export function classify(m: Message, sub: Subscription, self: User, fallback: NotifyLevel): InboundEvent | null {
  if (m.t || m.u._id === self._id || sub.ignored?.includes(m.u._id)) return null;
  const direct = m.mentions?.some((x) => x._id === self._id);
  const group = !sub.muteGroupMentions && m.mentions?.some((x) => x._id === "all" || x._id === "here");
  const kind: Kind = sub.t === "d" ? "dm" : direct || group ? "mention" : m.tmid ? "thread" : "channel";
  const level = levelOf(sub, fallback);
  const followed = !!m.tmid && !!sub.tunread?.includes(m.tmid);
  const notify = level === "all" || (level === "mentions" && (kind === "dm" || kind === "mention" || followed));
  return notify ? { kind, message: m, room: { id: sub.rid, name: sub.fname || sub.name, type: sub.t } } : null;
}

const text = (m: Message) => {
  const files = (m.attachments ?? []).map((a) => a.title_link ? `[attachment: ${a.title ?? "file"}]` : a.text).filter(Boolean);
  return [m.msg, ...files].filter(Boolean).join("\n") || "(empty message)";
};

/**
 * One frame for a burst of messages from the same room and thread (a single message stays as plain text).
 * Meta values must all be strings — Claude Code silently drops a frame with any other type.
 */
export function toFrame(events: InboundEvent[]): Frame {
  const first = events[0]!, last = events.at(-1)!.message;
  const senders = [...new Set(events.map((e) => e.message.u.username))];
  const meta: Record<string, string> = {
    kind: KINDS[Math.min(...events.map((e) => KINDS.indexOf(e.kind)))]!,
    room_id: first.room.id,
    room_name: first.room.name,
    room_type: first.room.type,
    sender: senders.join(","),
    message_id: last._id,
    ts: last.ts,
  };
  if (last.tmid) meta.thread_id = last.tmid;
  if (events.length > 1) {
    meta.count = String(events.length);
    meta.message_ids = events.map((e) => e.message._id).join(",");
  }
  const content = events.length === 1 ? text(last) : events.map((e) => `@${e.message.u.username}: ${text(e.message)}`).join("\n");
  return { content, meta };
}

export interface WatcherOptions {
  self: User;
  /** Level for rooms whose preference was never saved. */
  fallback: NotifyLevel;
  pollMs: number;
  onEvent: (e: InboundEvent) => Promise<void>;
  /** Sees each changed subscription before its messages are classified, and may update it (e.g. save a default level). */
  onSubscription?: (sub: Subscription) => Promise<void>;
  now?: () => Date;
  log?: (msg: string) => void;
}

type Source = Pick<RocketChat, "subscriptions" | "syncMessages" | "rooms">;

/** How far back to look on each poll, to cover clock skew between us and the server. Duplicates are dropped by id. */
const OVERLAP_MS = 5_000;
const SEEN_MAX = 2_000;

export interface UnsyncedRoom {
  room: string;
  lastActivityAt: string;
  lastSyncedAt: string | null;
}

export class Watcher {
  readonly startedAt: Date;
  private subsSince: Date;
  private roomsSince: Date;
  private subsSeeded = false;
  /** Every room this account is known to belong to, keyed by room id — seeded once in full, then kept current by
   * `subscriptions.get`'s own deltas (level, mute and join/leave changes). */
  private readonly subs = new Map<string, Subscription>();
  /** Last `rooms.get` activity timestamp seen for a room — moves on every post, unlike a subscription's own
   * `_updatedAt` under a mentions-only `Unread_Count` setting. */
  private readonly lastActivityAt = new Map<string, Date>();
  /** Last time messages were actually synced for a room. */
  private readonly roomSince = new Map<string, Date>();
  /** Activity timestamp already logged as unsynced for a room, so a stuck room warns once, not every poll. */
  private readonly warnedActivityAt = new Map<string, string>();
  private readonly seen = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private failures = 0;
  private lastSuccessAt: Date | undefined;

  /** Stream health for the observer app (FACTORY-644): never exposes anything but counts and timestamps. */
  health(): { running: boolean; consecutiveFailures: number; lastSuccessAt: string | null } {
    return { running: this.running, consecutiveFailures: this.failures, lastSuccessAt: this.lastSuccessAt?.toISOString() ?? null };
  }

  /** Per-room sync state for the observer app (FACTORY-645): how many rooms are tracked, and any at level
   * "all" whose `rooms.get` activity hasn't been matched by a message sync yet. */
  rooms(): { tracked: number; unsyncedActive: UnsyncedRoom[] } {
    const unsyncedActive: UnsyncedRoom[] = [];
    for (const [rid, activity] of this.lastActivityAt) {
      const sub = this.subs.get(rid);
      if (!sub || levelOf(sub, this.o.fallback) !== "all") continue;
      const synced = this.roomSince.get(rid);
      if (synced && synced >= activity) continue;
      unsyncedActive.push({ room: sub.fname || sub.name, lastActivityAt: activity.toISOString(), lastSyncedAt: synced?.toISOString() ?? null });
    }
    return { tracked: this.subs.size, unsyncedActive };
  }

  constructor(private readonly rc: Source, private readonly o: WatcherOptions) {
    this.startedAt = (o.now ?? (() => new Date()))();
    this.subsSince = this.startedAt;
    this.roomsSince = this.startedAt;
  }

  /**
   * One poll. Only messages created after the watcher started are considered — restarts never replay history.
   * `subscriptions.get` still drives level, mute and join/leave changes; activity is detected with
   * `rooms.get?updatedSince` instead (a room's `_updatedAt` moves on every post, so a plain channel message is
   * never missed just because the server counts it as read without a mention). One extra REST call per poll.
   */
  async tick(): Promise<InboundEvent[]> {
    const subs = this.subsSeeded ? await this.rc.subscriptions(back(this.subsSince)) : await this.rc.subscriptions();
    this.subsSeeded = true;
    for (const sub of subs) {
      if (sub._updatedAt > this.subsSince.toISOString()) this.subsSince = new Date(sub._updatedAt);
      await this.o.onSubscription?.(sub);
      this.subs.set(sub.rid, sub);
    }

    const rooms = await this.rc.rooms(back(this.roomsSince));
    for (const r of rooms) {
      const updatedAt = r._updatedAt ?? r.lastMessage?._updatedAt;
      if (!updatedAt) continue;
      if (updatedAt > this.roomsSince.toISOString()) this.roomsSince = new Date(updatedAt);
      if (!this.subs.has(r._id)) continue; // not a member we track (or membership not yet known)
      this.lastActivityAt.set(r._id, new Date(updatedAt));
    }

    const events: InboundEvent[] = [];
    for (const [rid, sub] of this.subs) {
      const activity = this.lastActivityAt.get(rid);
      const since = this.roomSince.get(rid) ?? this.startedAt;
      if (!activity || activity <= since) continue;
      const msgs = (await this.rc.syncMessages(rid, back(since))).sort((a, b) => a.ts.localeCompare(b.ts));
      let caughtUpTo = since;
      for (const m of msgs) {
        const updatedAt = new Date(m._updatedAt);
        if (updatedAt > caughtUpTo) caughtUpTo = updatedAt;
        if (m.ts < this.startedAt.toISOString() || this.seen.has(m._id)) continue; // edits of old messages, repeats
        this.remember(m._id);
        const e = classify(m, sub, this.o.self, this.o.fallback);
        if (e) events.push(e);
      }
      this.roomSince.set(rid, caughtUpTo);
      if (caughtUpTo < activity && levelOf(sub, this.o.fallback) === "all" && this.warnedActivityAt.get(rid) !== activity.toISOString()) {
        this.warnedActivityAt.set(rid, activity.toISOString());
        this.o.log?.(`room "${sub.fname || sub.name}" shows activity at ${activity.toISOString()} the watcher could not sync (last synced ${caughtUpTo.toISOString()})`);
      }
    }
    for (const e of events) await this.o.onEvent(e);
    return events;
  }

  start() {
    if (this.running) return;
    this.running = true;
    const loop = async () => {
      try {
        await this.tick();
        if (this.failures) this.o.log?.(`poll recovered after ${this.failures} failure(s)`);
        this.failures = 0;
        this.lastSuccessAt = (this.o.now ?? (() => new Date()))();
      } catch (err) {
        this.failures++;
        if (this.failures === 1 || this.failures % 20 === 0) this.o.log?.(`poll failed (${this.failures}x): ${(err as Error).message}`);
      }
      // back off to 60s while the server is unreachable
      if (this.running) this.timer = setTimeout(loop, Math.min(this.o.pollMs * 2 ** Math.min(this.failures, 5), 60_000));
    };
    void loop();
  }

  stop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
  }

  private remember(id: string) {
    this.seen.add(id);
    if (this.seen.size > SEEN_MAX) this.seen.delete(this.seen.values().next().value!);
  }
}

/**
 * Coalesces bursts so a busy room doesn't flood a session with turns: events with the same key (account, room and
 * thread — a reply needs one thread_id) are held until `quietMs` pass with no new one, or `maxMs` after the first.
 * `quietMs` 0 flushes every event on its own.
 */
export class Batcher {
  private readonly open = new Map<string, { events: InboundEvent[]; timer: ReturnType<typeof setTimeout>; first: number }>();

  constructor(private readonly o: { quietMs: number; maxMs: number; flush: (events: InboundEvent[]) => Promise<void> }) {}

  async add(key: string, e: InboundEvent) {
    if (this.o.quietMs <= 0) return this.o.flush([e]);
    const b = this.open.get(key);
    if (b) clearTimeout(b.timer);
    const batch = b ?? { events: [], timer: undefined as never, first: Date.now() };
    batch.events.push(e);
    const wait = Math.max(0, Math.min(this.o.quietMs, batch.first + this.o.maxMs - Date.now()));
    batch.timer = setTimeout(() => void this.flushKey(key), wait);
    this.open.set(key, batch);
  }

  /** Flush everything now (on shutdown, nothing is left behind in a timer). */
  async flushAll() {
    for (const key of [...this.open.keys()]) await this.flushKey(key);
  }

  private async flushKey(key: string) {
    const b = this.open.get(key);
    if (!b) return;
    clearTimeout(b.timer);
    this.open.delete(key);
    await this.o.flush(b.events);
  }
}

const back = (d: Date) => new Date(d.getTime() - OVERLAP_MS);
