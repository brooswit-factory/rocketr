import type { Message, Room, Subscription, User } from "../../src/rocketchat.js";

/** An in-memory Rocket.Chat that speaks the REST slice rocketr uses. */
export class FakeRocketChat {
  readonly bot: User = { _id: "bot1", username: "claude", name: "Claude" };
  readonly users: User[] = [this.bot, { _id: "u-boss", username: "boss" }, { _id: "u-rando", username: "rando" }];
  readonly rooms: Room[] = [{ _id: "GENERAL", t: "c", name: "general" }, { _id: "dm-boss", t: "d" }];
  readonly subs: Subscription[] = [];
  readonly messages: Message[] = [];
  readonly sent: Array<{ rid: string; msg: string; tmid?: string }> = [];
  readonly reads: string[] = [];
  readonly token = "tok";
  private n = 0;
  server!: ReturnType<typeof Bun.serve>;

  constructor() {
    const now = new Date(0).toISOString();
    this.subs.push({ rid: "GENERAL", name: "general", t: "c", unread: 0, userMentions: 0, _updatedAt: now });
    this.subs.push({ rid: "dm-boss", name: "boss", t: "d", unread: 0, userMentions: 0, _updatedAt: now });
  }

  get url() { return `http://127.0.0.1:${this.server.port}`; }

  /** Someone posts; bumps the room's subscription like the real server does. */
  post(rid: string, username: string, msg: string, extra: Partial<Message> = {}) {
    const u = this.users.find((x) => x.username === username)!;
    const ts = new Date().toISOString();
    const m: Message = { _id: `m${++this.n}`, rid, msg, ts, _updatedAt: ts, u, ...extra };
    this.messages.push(m);
    const s = this.subs.find((x) => x.rid === rid)!;
    s.unread++; s._updatedAt = ts;
    return m;
  }

  start() {
    this.server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => this.handle(req) });
    return this;
  }
  stop() { this.server.stop(true); }

  private async handle(req: Request): Promise<Response> {
    if (req.headers.get("x-auth-token") !== this.token || req.headers.get("x-user-id") !== this.bot._id) return json({ success: false, error: "You must be logged in to do this." }, 401);
    const url = new URL(req.url);
    const q = (k: string) => url.searchParams.get(k);
    const body = req.method === "POST" ? await req.json() as any : {};
    const route = url.pathname.replace("/api/v1/", "");
    const room = (id: string | null) => this.rooms.find((r) => r._id === id || r.name === id);
    switch (route) {
      case "me": return json({ success: true, ...this.bot });
      case "users.info": { const u = this.users.find((x) => x.username === q("username")); return u ? json({ success: true, user: u }) : json({ success: false, error: "User not found." }, 400); }
      case "subscriptions.get": { const since = q("updatedSince"); return json({ success: true, update: this.subs.filter((s) => !since || s._updatedAt > since) }); }
      case "chat.syncMessages": return json({ success: true, result: { updated: this.messages.filter((m) => m.rid === q("roomId") && m._updatedAt > q("lastUpdate")!), deleted: [] } });
      case "channels.history": case "im.history": case "groups.history":
        return json({ success: true, messages: this.messages.filter((m) => m.rid === q("roomId")).reverse().slice(0, Number(q("count"))) });
      case "chat.getThreadMessages": return json({ success: true, messages: this.messages.filter((m) => m.tmid === q("tmid")).reverse() });
      case "rooms.info": { const r = room(q("roomId") ?? q("roomName")); return r ? json({ success: true, room: r }) : json({ success: false, error: "not found" }, 400); }
      case "im.create": return json({ success: true, room: { _id: body.username === "boss" ? "dm-boss" : "dm-x", rid: body.username === "boss" ? "dm-boss" : "dm-x" } });
      case "chat.sendMessage": {
        this.sent.push(body.message);
        const ts = new Date().toISOString();
        const m: Message = { _id: `s${++this.n}`, rid: body.message.rid, msg: body.message.msg, ts, _updatedAt: ts, u: this.bot, ...(body.message.tmid ? { tmid: body.message.tmid } : {}) };
        this.messages.push(m);
        return json({ success: true, message: m });
      }
      case "subscriptions.read": this.reads.push(body.rid); return json({ success: true });
      default: return json({ success: false, error: `no route ${route}` }, 404);
    }
  }
}

const json = (d: unknown, status = 200) => new Response(JSON.stringify(d), { status, headers: { "content-type": "application/json" } });
