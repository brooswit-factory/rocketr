import type { Message, Room, Subscription, User } from "../../src/rocketchat.js";

/** An in-memory Rocket.Chat that speaks the REST slice rocketr uses, for two bot accounts. */
export class FakeRocketChat {
  readonly bot: User = { _id: "bot1", username: "claude", name: "Claude" };
  readonly lead: User = { _id: "bot2", username: "lead", name: "Lead" };
  readonly users: User[] = [this.bot, this.lead, { _id: "u-boss", username: "boss" }, { _id: "u-rando", username: "rando" }];
  readonly tokens = new Map([["bot1", "tok"], ["bot2", "tok2"]]);
  readonly rooms: Room[] = [{ _id: "GENERAL", t: "c", name: "general" }, { _id: "dm-boss", t: "d" }, { _id: "dm-boss-lead", t: "d" }, { _id: "dm-agents", t: "d" }];
  /** Each bot's DM room with a given user. */
  private readonly dms: Record<string, Record<string, string>> = { bot1: { boss: "dm-boss", lead: "dm-agents" }, bot2: { boss: "dm-boss-lead", claude: "dm-agents" } };
  readonly subs = new Map<string, Subscription[]>();
  readonly messages: Message[] = [];
  readonly sent: Array<{ rid: string; msg: string; tmid?: string }> = [];
  readonly reactions: Array<{ uid: string; messageId: string; emoji: string; shouldReact: boolean }> = [];
  readonly reads: string[] = [];
  readonly saved: Array<{ uid: string; rid: string; desktopNotifications?: string; mobilePushNotifications?: string }> = [];
  private n = 0;
  server!: ReturnType<typeof Bun.serve>;

  constructor() {
    const at = new Date(0).toISOString();
    const sub = (rid: string, name: string, t: Subscription["t"]): Subscription => ({ rid, name, t, unread: 0, userMentions: 0, _updatedAt: at });
    this.subs.set("bot1", [sub("GENERAL", "general", "c"), sub("dm-boss", "boss", "d"), sub("dm-agents", "lead", "d")]);
    this.subs.set("bot2", [sub("GENERAL", "general", "c"), sub("dm-boss-lead", "boss", "d"), sub("dm-agents", "claude", "d")]);
  }

  get url() { return `http://127.0.0.1:${this.server.port}`; }

  /** Someone posts; bumps every member's subscription like the real server does. */
  post(rid: string, username: string, msg: string, extra: Partial<Message> = {}) {
    const u = this.users.find((x) => x.username === username)!;
    const ts = new Date().toISOString();
    const m: Message = { _id: `m${++this.n}`, rid, msg, ts, _updatedAt: ts, u, ...extra };
    this.messages.push(m);
    for (const list of this.subs.values()) for (const s of list) if (s.rid === rid) { s.unread++; s._updatedAt = ts; }
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
    const q = (k: string) => url.searchParams.get(k);
    const body = req.method === "POST" ? await req.json() as any : {};
    const route = url.pathname.replace("/api/v1/", "");
    const room = (id: string | null) => this.rooms.find((r) => r._id === id || r.name === id);
    switch (route) {
      case "me": return json({ success: true, ...me });
      case "users.info": { const u = this.users.find((x) => x.username === q("username")); return u ? json({ success: true, user: u }) : json({ success: false, error: "User not found." }, 400); }
      case "subscriptions.get": { const since = q("updatedSince"); return json({ success: true, update: (this.subs.get(uid) ?? []).filter((s) => !since || s._updatedAt > since) }); }
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
      case "chat.react": this.reactions.push({ uid, ...body }); return json({ success: true });
      case "subscriptions.read": this.reads.push(body.rid); return json({ success: true });
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
