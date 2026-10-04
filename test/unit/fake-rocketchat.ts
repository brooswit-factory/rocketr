import type { Message, Room, Subscription, User } from "../../src/rocketchat.js";

/** An in-memory Rocket.Chat that speaks the REST slice rocketr uses, for two bot accounts. */
export class FakeRocketChat {
  readonly bot: User = { _id: "bot1", username: "claude", name: "Claude" };
  readonly lead: User = { _id: "bot2", username: "lead", name: "Lead" };
  readonly users: User[] = [this.bot, this.lead, { _id: "u-boss", username: "boss" }, { _id: "u-rando", username: "rando" }];
  readonly tokens = new Map([["bot1", "tok"], ["bot2", "tok2"]]);
  readonly rooms: Room[] = [
    { _id: "GENERAL", t: "c", name: "general" }, { _id: "dm-boss", t: "d" }, { _id: "dm-boss-lead", t: "d" }, { _id: "dm-agents", t: "d" },
    { _id: "PRIVATE", t: "p", name: "leadership" },
  ];
  /** Each bot's DM room with a given user. */
  private readonly dms: Record<string, Record<string, string>> = { bot1: { boss: "dm-boss", lead: "dm-agents" }, bot2: { boss: "dm-boss-lead", claude: "dm-agents" } };
  readonly subs = new Map<string, Subscription[]>();
  /** A room's own last-activity timestamp, bumped by every post regardless of `mentionsOnlyUnread` — what
   * `rooms.get` reports, mirroring the real server's `_updatedAt`. */
  readonly roomUpdatedAt = new Map<string, string>();
  /** Simulates a server with `Unread_Count = mentions` (or any non-"all_messages" setting): a plain post
   * (no @mention, not a DM) never bumps the recipient's own subscription — only `rooms.get` sees it move. */
  mentionsOnlyUnread = false;
  readonly messages: Message[] = [];
  readonly sent: Array<{ rid: string; msg: string; tmid?: string }> = [];
  readonly reactions: Array<{ uid: string; messageId: string; emoji: string; shouldReact: boolean }> = [];
  readonly reads: string[] = [];
  readonly saved: Array<{ uid: string; rid: string; desktopNotifications?: string; mobilePushNotifications?: string }> = [];
  /** Members of each private group ("p" room), so groups.invite can enforce "caller must already be in it". */
  readonly groupMembers = new Map<string, Set<string>>();
  readonly invited: Array<{ rid: string; userId: string }> = [];
  readonly kicked: Array<{ rid: string; userId: string }> = [];
  /** Files served at /file-upload/..., keyed by path. */
  readonly files = new Map<string, { type: string; body: Buffer; lengthHeader?: boolean }>();
  readonly fileRequests: string[] = [];
  private n = 0;
  server!: ReturnType<typeof Bun.serve>;

  constructor() {
    const at = new Date(0).toISOString();
    const sub = (rid: string, name: string, t: Subscription["t"]): Subscription => ({ rid, name, t, unread: 0, userMentions: 0, _updatedAt: at });
    this.subs.set("bot1", [sub("GENERAL", "general", "c"), sub("dm-boss", "boss", "d"), sub("dm-agents", "lead", "d")]);
    this.subs.set("bot2", [sub("GENERAL", "general", "c"), sub("dm-boss-lead", "boss", "d"), sub("dm-agents", "claude", "d")]);
    this.groupMembers.set("PRIVATE", new Set(["bot1"])); // claude is in; lead is not
    for (const r of this.rooms) this.roomUpdatedAt.set(r._id, at);
  }

  get url() { return `http://127.0.0.1:${this.server.port}`; }

  /**
   * Someone posts. The room's own activity timestamp always moves. A subscription's `_updatedAt` (and its
   * `unread` count) moves too, UNLESS `mentionsOnlyUnread` is set and this post is a plain message to a
   * non-DM subscriber it doesn't @mention — the real-world "Unread_Count = mentions" misconfiguration this
   * watcher must not depend on.
   */
  post(rid: string, username: string, msg: string, extra: Partial<Message> = {}) {
    const u = this.users.find((x) => x.username === username)!;
    const ts = new Date().toISOString();
    const m: Message = { _id: `m${++this.n}`, rid, msg, ts, _updatedAt: ts, u, ...extra };
    this.messages.push(m);
    this.roomUpdatedAt.set(rid, ts);
    for (const [subUid, list] of this.subs) for (const s of list) {
      if (s.rid !== rid) continue;
      const mentioned = s.t === "d" || (m.mentions?.some((x) => x._id === subUid || x._id === "all" || x._id === "here") ?? false);
      if (this.mentionsOnlyUnread && !mentioned) continue;
      s.unread++; s._updatedAt = ts;
    }
    return m;
  }

  start() {
    this.server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => this.handle(req) });
    return this;
  }
  stop() { this.server.stop(true); }

  private async handle(req: Request): Promise<Response> {
    const uid = req.headers.get("x-user-id") ?? "";
    const me = this.users.find((u) => u._id === uid);
    if (!me || this.tokens.get(uid) !== req.headers.get("x-auth-token")) return json({ success: false, error: "You must be logged in to do this." }, 401);
    const url = new URL(req.url);
    if (url.pathname.startsWith("/file-upload/")) {
      this.fileRequests.push(url.pathname);
      const f = this.files.get(url.pathname);
      return f ? new Response(f.body, { headers: { "content-type": f.type, ...(f.lengthHeader === false ? {} : { "content-length": String(f.body.length) }) } }) : new Response("nope", { status: 404 });
    }
    const q = (k: string) => url.searchParams.get(k);
    const body = req.method === "POST" ? await req.json() as any : {};
    const route = url.pathname.replace("/api/v1/", "");
    const room = (id: string | null) => this.rooms.find((r) => r._id === id || r.name === id);
    switch (route) {
      case "me": return json({ success: true, ...me });
      case "users.info": { const u = this.users.find((x) => x.username === q("username")); return u ? json({ success: true, user: u }) : json({ success: false, error: "User not found." }, 400); }
      case "subscriptions.get": { const since = q("updatedSince"); return json({ success: true, update: (this.subs.get(uid) ?? []).filter((s) => !since || s._updatedAt > since) }); }
      case "rooms.get": {
        const since = q("updatedSince");
        const mine = new Set((this.subs.get(uid) ?? []).map((s) => s.rid));
        const update = this.rooms
          .filter((r) => mine.has(r._id))
          .map((r) => ({ ...r, _updatedAt: this.roomUpdatedAt.get(r._id) ?? new Date(0).toISOString() }))
          .filter((r) => !since || r._updatedAt > since);
        return json({ success: true, update });
      }
      case "chat.syncMessages": return json({ success: true, result: { updated: this.messages.filter((m) => m.rid === q("roomId") && m._updatedAt > q("lastUpdate")!), deleted: [] } });
      case "channels.history": case "im.history": case "groups.history":
        return json({ success: true, messages: this.messages.filter((m) => m.rid === q("roomId")).reverse().slice(0, Number(q("count"))) });
      case "chat.getThreadMessages": return json({ success: true, messages: this.messages.filter((m) => m.tmid === q("tmid")).reverse() });
      case "rooms.info": { const r = room(q("roomId") ?? q("roomName")); return r ? json({ success: true, room: r }) : json({ success: false, error: "not found" }, 400); }
      case "im.create": { const rid = this.dms[uid]?.[body.username] ?? `dm-${uid}-${body.username}`; return json({ success: true, room: { _id: rid, rid } }); }
      case "chat.sendMessage": {
        this.sent.push(body.message);
        const ts = new Date().toISOString();
        const m: Message = { _id: `s${++this.n}`, rid: body.message.rid, msg: body.message.msg, ts, _updatedAt: ts, u: me, ...(body.message.tmid ? { tmid: body.message.tmid } : {}) };
        this.messages.push(m);
        return json({ success: true, message: m });
      }
      case "chat.getMessage": {
        const m = this.messages.find((x) => x._id === q("msgId"));
        // like the server: a message in a room this account is not subscribed to does not exist for it
        if (!m || !this.subs.get(uid)?.some((x) => x.rid === m.rid)) return json({ success: false, error: "Message not found" }, 400);
        return json({ success: true, message: m });
      }
      case "chat.react": this.reactions.push({ uid, ...body }); return json({ success: true });
      case "subscriptions.read": this.reads.push(body.rid); return json({ success: true });
      case "channels.invite": this.invited.push({ rid: body.roomId, userId: body.userId }); return json({ success: true });
      case "channels.kick": this.kicked.push({ rid: body.roomId, userId: body.userId }); return json({ success: true });
      case "groups.invite": {
        const members = this.groupMembers.get(body.roomId) ?? new Set();
        if (!members.has(uid)) return json({ success: false, error: "error-not-allowed", errorType: "error-not-allowed" }, 403);
        members.add(body.userId);
        this.groupMembers.set(body.roomId, members);
        this.invited.push({ rid: body.roomId, userId: body.userId });
        return json({ success: true });
      }
      case "groups.kick": {
        const members = this.groupMembers.get(body.roomId) ?? new Set();
        if (!members.has(uid)) return json({ success: false, error: "error-not-allowed", errorType: "error-not-allowed" }, 403);
        members.delete(body.userId);
        this.kicked.push({ rid: body.roomId, userId: body.userId });
        return json({ success: true });
      }
      case "subscriptions.getOne": { const s = this.subs.get(uid)?.find((x) => x.rid === q("roomId")); return json({ success: true, subscription: s ?? null }); }
      case "rooms.saveNotification": {
        const s = this.subs.get(uid)?.find((x) => x.rid === body.roomId);
        if (!s) return json({ success: false, error: "not subscribed" }, 400);
        Object.assign(s, body.notifications, { _updatedAt: new Date().toISOString() });
        this.saved.push({ uid, rid: body.roomId, ...body.notifications });
        return json({ success: true });
      }
      default: return json({ success: false, error: `no route ${route}` }, 404);
    }
  }
}

const json = (d: unknown, status = 200) => new Response(JSON.stringify(d), { status, headers: { "content-type": "application/json" } });
