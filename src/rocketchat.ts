/** The slice of the Rocket.Chat REST API rocketr needs. Auth is a personal access token. */

export type RoomType = "c" | "p" | "d" | "l";

export interface User { _id: string; username: string; name?: string }

export interface Message {
  _id: string;
  rid: string;
  msg: string;
  ts: string;
  _updatedAt: string;
  u: User;
  /** Set on system messages (joins, topic changes, ...). */
  t?: string;
  tmid?: string;
  tcount?: number;
  mentions?: Array<{ _id: string; username?: string }>;
  attachments?: Array<{ title?: string; title_link?: string; text?: string }>;
}

/** A room's notification level, as Rocket.Chat's per-room "Notification Preferences" set it. */
export type NotifyLevel = "all" | "mentions" | "nothing";
export const NOTIFY_LEVELS = ["all", "mentions", "nothing"] as const;

export interface Subscription {
  rid: string;
  name: string;
  fname?: string;
  t: RoomType;
  unread: number;
  userMentions: number;
  _updatedAt: string;
  /** Absent until the room's preference is saved once ("default" after it is reset). */
  desktopNotifications?: NotifyLevel | "default";
  mobilePushNotifications?: NotifyLevel | "default";
  /** "Mute all" in Rocket.Chat's UI. */
  disableNotifications?: boolean;
  muteGroupMentions?: boolean;
  /** User ids this account ignores in the room. */
  ignored?: string[];
  /** Followed threads with unread replies. */
  tunread?: string[];
}

export interface Room { _id: string; t: RoomType; name?: string; fname?: string }

export class RocketChatError extends Error {
  constructor(readonly status: number, readonly path: string, message: string) {
    super(`${path}: ${message} (HTTP ${status})`);
  }
}

const HISTORY: Record<RoomType, string> = { c: "channels.history", p: "groups.history", d: "im.history", l: "livechat/messages.history" };
/** Only channels and private groups have a membership list to add/remove someone from. */
const INVITE: Partial<Record<RoomType, string>> = { c: "channels.invite", p: "groups.invite" };
const KICK: Partial<Record<RoomType, string>> = { c: "channels.kick", p: "groups.kick" };

export class RocketChat {
  private readonly fetch: typeof fetch;
  constructor(private readonly o: { url: string; userId: string; token: string; fetch?: typeof fetch }) {
    this.fetch = o.fetch ?? fetch;
  }

  private async call<T>(path: string, init: { query?: Record<string, string | number | undefined>; body?: unknown } = {}): Promise<T> {
    const url = new URL(`${this.o.url}/api/v1/${path}`);
    for (const [k, v] of Object.entries(init.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
    const res = await this.fetch(url, {
      method: init.body === undefined ? "GET" : "POST",
      headers: { "X-User-Id": this.o.userId, "X-Auth-Token": this.o.token, "Content-Type": "application/json" },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
    const data = (await res.json().catch(() => ({}))) as { success?: boolean; error?: string; message?: string };
    if (!res.ok || data.success === false) throw new RocketChatError(res.status, path, data.error ?? data.message ?? res.statusText);
    return data as T;
  }

  me() { return this.call<User>("me"); }

  async userByUsername(username: string) {
    return (await this.call<{ user: User }>("users.info", { query: { username } })).user;
  }

  /** Subscriptions changed since `since` (all of them when omitted). */
  async subscriptions(since?: Date) {
    return (await this.call<{ update: Subscription[] }>("subscriptions.get", { query: { updatedSince: since?.toISOString() } })).update;
  }

  async subscription(rid: string) {
    return (await this.call<{ subscription: Subscription }>("subscriptions.getOne", { query: { roomId: rid } })).subscription;
  }

  /** Sets the desktop and the push level together: for an agent both mean "wake me for this". */
  async saveNotification(rid: string, level: NotifyLevel) {
    const notifications = { desktopNotifications: level, mobilePushNotifications: level };
    await this.call("rooms.saveNotification", { body: { roomId: rid, notifications } });
  }

  /** Messages created or edited in a room after `since`. */
  async syncMessages(rid: string, since: Date) {
    return (await this.call<{ result: { updated: Message[] } }>("chat.syncMessages", { query: { roomId: rid, lastUpdate: since.toISOString() } })).result.updated;
  }

  /** Newest-first, as Rocket.Chat returns it. */
  async history(room: Room, count: number) {
    return (await this.call<{ messages: Message[] }>(HISTORY[room.t], { query: { roomId: room._id, count } })).messages;
  }

  async threadMessages(tmid: string, count: number) {
    return (await this.call<{ messages: Message[] }>("chat.getThreadMessages", { query: { tmid, count } })).messages;
  }

  async roomById(roomId: string) { return (await this.call<{ room: Room }>("rooms.info", { query: { roomId } })).room; }
  async roomByName(roomName: string) { return (await this.call<{ room: Room }>("rooms.info", { query: { roomName } })).room; }

  /** The DM room with `username`, created on first use. */
  async dm(username: string) {
    const { room } = await this.call<{ room: { _id: string; rid?: string } }>("im.create", { body: { username } });
    return this.roomById(room.rid ?? room._id);
  }

  async send(rid: string, text: string, tmid?: string) {
    const message = { rid, msg: text, ...(tmid ? { tmid } : {}) };
    return (await this.call<{ message: Message }>("chat.sendMessage", { body: { message } })).message;
  }

  async markRead(rid: string) { await this.call("subscriptions.read", { body: { rid } }); }

  async addMember(room: Room, userId: string) {
    const path = INVITE[room.t];
    if (!path) throw new Error(`cannot add a member to a "${room.t}" room`);
    await this.call(path, { body: { roomId: room._id, userId } });
  }

  async removeMember(room: Room, userId: string) {
    const path = KICK[room.t];
    if (!path) throw new Error(`cannot remove a member from a "${room.t}" room`);
    await this.call(path, { body: { roomId: room._id, userId } });
  }
}
