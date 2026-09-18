import type { Frame } from "@brooswit/thatch";
import type { Message, RocketChat, RoomType, Subscription, User } from "./rocketchat.js";

export interface InboundEvent {
  kind: "dm" | "mention";
  message: Message;
  room: { id: string; name: string; type: RoomType };
}

/**
 * Should this message reach a session? Gate on the SENDER's id, never the room:
 * anyone in a shared channel could otherwise put text in front of Claude.
 */
export function classify(m: Message, sub: Subscription, self: User, allow: ReadonlySet<string>): InboundEvent | null {
  if (m.t || m.u._id === self._id || !allow.has(m.u._id)) return null;
  const kind = sub.t === "d" ? "dm" : m.mentions?.some((x) => x._id === self._id) ? "mention" : null;
  return kind && { kind, message: m, room: { id: sub.rid, name: sub.fname || sub.name, type: sub.t } };
}

/** Meta values must all be strings — Claude Code silently drops a frame with any other type. */
export function toFrame(e: InboundEvent): Frame {
  const m = e.message;
  const files = (m.attachments ?? []).map((a) => a.title_link ? `[attachment: ${a.title ?? "file"}]` : a.text).filter(Boolean);
  const meta: Record<string, string> = {
    kind: e.kind,
    room_id: e.room.id,
    room_name: e.room.name,
    room_type: e.room.type,
    sender: m.u.username,
    message_id: m._id,
    ts: m.ts,
  };
  if (m.tmid) meta.thread_id = m.tmid;
  return { content: [m.msg, ...files].filter(Boolean).join("\n") || "(empty message)", meta };
}

export interface WatcherOptions {
  self: User;
  /** Allowed sender user ids. */
  allow: ReadonlySet<string>;
  pollMs: number;
  onEvent: (e: InboundEvent) => Promise<void>;
  now?: () => Date;
  log?: (msg: string) => void;
}

type Source = Pick<RocketChat, "subscriptions" | "syncMessages">;

/** How far back to look on each poll, to cover clock skew between us and the server. Duplicates are dropped by id. */
const OVERLAP_MS = 5_000;
const SEEN_MAX = 2_000;

export class Watcher {
  readonly startedAt: Date;
  private subsSince: Date;
  private readonly roomSince = new Map<string, Date>();
  private readonly seen = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private failures = 0;

  constructor(private readonly rc: Source, private readonly o: WatcherOptions) {
    this.startedAt = (o.now ?? (() => new Date()))();
    this.subsSince = this.startedAt;
  }

  /** One poll. Only messages created after the watcher started are considered — restarts never replay history. */
  async tick(): Promise<InboundEvent[]> {
    const subs = await this.rc.subscriptions(back(this.subsSince));
    const events: InboundEvent[] = [];
    for (const sub of subs) {
      if (sub._updatedAt > this.subsSince.toISOString()) this.subsSince = new Date(sub._updatedAt);
      const since = this.roomSince.get(sub.rid) ?? this.startedAt;
      const msgs = (await this.rc.syncMessages(sub.rid, back(since))).sort((a, b) => a.ts.localeCompare(b.ts));
      for (const m of msgs) {
        if (m._updatedAt > since.toISOString()) this.roomSince.set(sub.rid, new Date(m._updatedAt));
        if (m.ts < this.startedAt.toISOString() || this.seen.has(m._id)) continue; // edits of old messages, repeats
        this.remember(m._id);
        const e = classify(m, sub, this.o.self, this.o.allow);
        if (e) events.push(e);
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

const back = (d: Date) => new Date(d.getTime() - OVERLAP_MS);
