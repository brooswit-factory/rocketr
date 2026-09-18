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

export interface Subscription {
  rid: string;
  name: string;
  fname?: string;
  t: RoomType;
  unread: number;
  userMentions: number;
  _updatedAt: string;
}

export interface Room { _id: string; t: RoomType; name?: string; fname?: string }

export class RocketChatError extends Error {
  constructor(readonly status: number, readonly path: string, message: string) {
    super(`${path}: ${message} (HTTP ${status})`);
  }
}

const HISTORY: Record<RoomType, string> = { c: "channels.history", p: "groups.history", d: "im.history", l: "livechat/messages.history" };

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
}
