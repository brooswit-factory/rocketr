import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { FakeConnection } from "@brooswit/thatch/testing";
import { createRocketr, type Rocketr } from "../../src/app.js";
import type { Config } from "../../src/config.js";
import { FakeRocketChat } from "./fake-rocketchat.js";

let rcServer: FakeRocketChat, r: Rocketr, base: string;
const conns: FakeConnection[] = [];
const ON = { "x-rocketr-channel": "on" };
const CLAUDE = { "x-rocketr-account": "claude" };
const LEAD = { "x-rocketr-account": "lead" };
/** Connects as @claude unless the headers name another account. */
const connect = async (headers: Record<string, string> = {}) => { const c = await FakeConnection.connect(base, { headers: { ...CLAUDE, ...headers } }); conns.push(c); return c; };

beforeEach(async () => {
  rcServer = new FakeRocketChat().start();
  const cfg: Config = {
    url: rcServer.url, defaultNotifications: "all", batchMs: 0, pollMs: 20, host: "127.0.0.1", port: 0,
    accounts: [{ name: "claude", userId: "bot1", token: "tok" }, { name: "lead", userId: "bot2", token: "tok2" }],
  };
  r = await createRocketr(cfg);
  base = `http://127.0.0.1:${(await r.listen()).port}`;
});

afterEach(async () => {
  for (const c of conns.splice(0)) await c.disconnect().catch(() => {});
  await r.stop();
  rcServer.stop();
});

describe("tools", () => {
  test("lists the tools", async () => {
    const c = await connect();
    expect((await c.listTools()).map((t) => t.name).sort())
      .toEqual(["get_notifications", "list_rooms", "read_messages", "send_message", "set_notifications", "whoami"]);
  });

  test("get_notifications and set_notifications read and write the room's own preference", async () => {
    const c = await connect();
    expect(await c.callTool("get_notifications", { room: "#general" })).toMatchObject({ room_id: "GENERAL", level: "all", muted: false });
    expect(await c.callTool("set_notifications", { room: "#general", level: "mentions" })).toEqual({ room_id: "GENERAL", level: "mentions" });
    expect(await c.callTool("get_notifications", { room: "GENERAL" })).toMatchObject({ level: "mentions", saved: "mentions" });
    await expect(c.callTool("set_notifications", { room: "#general", level: "loud" })).rejects.toThrow();
  });

  test("whoami and list_rooms", async () => {
    const c = await connect();
    expect(await c.callTool("whoami")).toMatchObject({ username: "claude", user_id: "bot1" });
    expect((await c.callTool("list_rooms")).map((x: any) => x.name)).toEqual(["general", "boss", "lead"]);
  });

  test("send_message resolves @user, #channel and raw ids, and threads", async () => {
    const c = await connect();
    await c.callTool("send_message", { room: "@boss", text: "hi boss" });
    await c.callTool("send_message", { room: "#general", text: "hi all" });
    await c.callTool("send_message", { room: "GENERAL", text: "in thread", thread_id: "t1" });
    expect(rcServer.sent).toEqual([{ rid: "dm-boss", msg: "hi boss" }, { rid: "GENERAL", msg: "hi all" }, { rid: "GENERAL", msg: "in thread", tmid: "t1" }]);
  });

  test("read_messages returns oldest first", async () => {
    rcServer.post("GENERAL", "boss", "one");
    rcServer.post("GENERAL", "rando", "two");
    const c = await connect();
    expect((await c.callTool("read_messages", { room: "general" })).map((m: any) => m.text)).toEqual(["one", "two"]);
  });

  test("a failing tool is reported as an error and logged", async () => {
    const c = await connect();
    await expect(c.callTool("read_messages", { room: "#nowhere" })).rejects.toThrow("rooms.info: not found");
    expect(r.activity.snapshot().events.find((e) => e.type === "tool")).toMatchObject({ tool: "read_messages", ok: false });
  });
});

describe("channel", () => {
  test("a DM is pushed into the session and the room marked read", async () => {
    const c = await connect({ "x-agent-name": "main", ...ON });
    await Bun.sleep(50); // let the notification stream attach
    rcServer.post("dm-boss", "boss", "you there?");
    const f = await c.nextFrame(3000);
    expect(f.content).toBe("you there?");
    expect(f.meta).toMatchObject({ kind: "dm", room_id: "dm-boss", sender: "boss" });
    await Bun.sleep(30);
    expect(rcServer.reads).toContain("dm-boss");
  });

  test("any sender, any message: an agent's DM, a plain channel message and a thread reply all land", async () => {
    const c = await connect(ON);
    await Bun.sleep(50);
    rcServer.post("dm-agents", "lead", "psst");
    expect((await c.nextFrame(3000)).meta).toMatchObject({ kind: "dm", sender: "lead", room_id: "dm-agents" });
    rcServer.post("GENERAL", "rando", "lunch?");
    expect((await c.nextFrame(3000)).meta).toMatchObject({ kind: "channel", sender: "rando", room_id: "GENERAL" });
    rcServer.post("GENERAL", "boss", "in the thread", { tmid: "t1" });
    expect((await c.nextFrame(3000)).meta).toMatchObject({ kind: "thread", thread_id: "t1" });
  });

  test("after set_notifications mentions, plain messages stop but an @mention still lands", async () => {
    const c = await connect(ON);
    await c.callTool("set_notifications", { room: "#general", level: "mentions" });
    await Bun.sleep(50);
    rcServer.post("GENERAL", "boss", "chatter");
    rcServer.post("GENERAL", "boss", "@claude you", { mentions: [{ _id: "bot1" }] });
    const f = await c.nextFrame(3000);
    expect(f.content).toBe("@claude you");
    expect(f.meta.kind).toBe("mention");
  });

  test("never its own messages, but other agents in the room hear them", async () => {
    await connect(ON);
    rcServer.post("GENERAL", "claude", "talking to myself");
    await Bun.sleep(100);
    expect(r.pending.map((p) => p.account)).toEqual(["lead"]);
  });

  test("a message that arrives with nobody connected waits, then lands on the next session", async () => {
    rcServer.post("dm-boss", "boss", "while you were out");
    await Bun.sleep(100);
    expect(r.pending.length).toBe(1);
    const c = await connect(ON);
    expect((await c.nextFrame(3000)).content).toBe("while you were out");
    await Bun.sleep(30);
    expect(r.pending.length).toBe(0);
  });

  test("a reconnect supersedes an older channel session for exactly-once delivery", async () => {
    await connect(ON);
    const current = await connect(ON);
    await Bun.sleep(50);
    rcServer.post("dm-boss", "boss", "one live turn only");
    expect((await current.nextFrame(3000)).content).toBe("one live turn only");
    await Bun.sleep(30);
    expect(r.activity.snapshot().events.filter((event) => event.type === "push")).toHaveLength(1);
  });

  test("pushes are opt-in: a tools-only session never swallows a message", async () => {
    await connect({ "x-agent-name": "tools-only" });
    rcServer.post("dm-boss", "boss", "anyone?");
    await Bun.sleep(150);
    expect(r.pending.length).toBe(1);
  });

  test("startup saves the default level on every room that has none, for every account", () => {
    expect(rcServer.saved.map((s) => `${s.uid}:${s.rid}:${s.desktopNotifications}:${s.mobilePushNotifications}`).sort()).toEqual([
      "bot1:GENERAL:all:all", "bot1:dm-agents:all:all", "bot1:dm-boss:all:all",
      "bot2:GENERAL:all:all", "bot2:dm-agents:all:all", "bot2:dm-boss-lead:all:all",
    ]);
  });

  test("a room joined later gets the default too, and a saved level is never overwritten", async () => {
    const at = new Date().toISOString();
    rcServer.subs.get("bot1")!.push({ rid: "new-room", name: "new", t: "c", unread: 0, userMentions: 0, _updatedAt: at });
    rcServer.subs.get("bot1")!.push({ rid: "chosen", name: "chosen", t: "c", unread: 0, userMentions: 0, _updatedAt: at, desktopNotifications: "nothing" });
    await Bun.sleep(100);
    expect(rcServer.saved.filter((s) => s.rid === "new-room")).toHaveLength(1);
    expect(rcServer.saved.some((s) => s.rid === "chosen")).toBe(false);
  });
});

describe("accounts", () => {
  test("no fallback: a client that names no account is refused at connect", async () => {
    await expect(FakeConnection.connect(base, { headers: {} })).rejects.toThrow();
  });

  test("an unknown account is refused at connect", async () => {
    await expect(FakeConnection.connect(base, { headers: { "x-rocketr-account": "nobody" } })).rejects.toThrow();
  });

  test("each session speaks as its own account", async () => {
    const a = await connect();
    const b = await connect(LEAD);
    expect((await a.callTool("whoami")).username).toBe("claude");
    expect((await b.callTool("whoami")).username).toBe("lead");
    await b.callTool("send_message", { room: "@boss", text: "from lead" });
    expect(rcServer.sent.at(-1)).toEqual({ rid: "dm-boss-lead", msg: "from lead" });
  });

  test("a DM to one account reaches only that account's sessions", async () => {
    const claude = await connect(ON);
    const lead = await connect({ ...LEAD, ...ON });
    await Bun.sleep(50);
    rcServer.post("dm-boss-lead", "boss", "for the lead");
    const f = await lead.nextFrame(3000);
    expect(f.meta).toMatchObject({ account: "lead", room_id: "dm-boss-lead", sender: "boss" });
    rcServer.post("dm-boss", "boss", "for claude");
    expect((await claude.nextFrame(3000)).content).toBe("for claude"); // not "for the lead"
  });

  test("a message for an account with no session waits for that account, not another", async () => {
    await connect(ON); // claude is listening
    rcServer.post("dm-boss-lead", "boss", "lead is away");
    await Bun.sleep(150);
    expect(r.pending.map((p) => p.account)).toEqual(["lead"]);
    const lead = await connect({ ...LEAD, ...ON });
    expect((await lead.nextFrame(3000)).content).toBe("lead is away");
  });

  test("the queue is capped per account: a busy account with no session can't evict another's message", async () => {
    rcServer.post("dm-boss", "boss", "for claude, queued first");
    await Bun.sleep(60);
    for (let i = 0; i < 60; i++) rcServer.post("dm-boss-lead", "boss", `lead ${i}`);
    await Bun.sleep(150);
    expect(r.pending.filter((p) => p.account === "lead")).toHaveLength(50);
    expect(r.pending.filter((p) => p.account === "lead")[0]!.frame.content).toBe("lead 10"); // oldest of lead's own dropped
    const c = await connect(ON);
    expect((await c.nextFrame(3000)).content).toBe("for claude, queued first");
  });

  test("an account whose token signs in as someone else is rejected at startup", async () => {
    const bad: Config = { url: rcServer.url, defaultNotifications: "all", batchMs: 0, pollMs: 20, host: "127.0.0.1", port: 0, accounts: [{ name: "claude", userId: "bot2", token: "tok2" }] };
    await expect(createRocketr(bad)).rejects.toThrow('account "claude" signs in as @lead');
  });
});

describe("web app", () => {
  test("serves the page", async () => {
    const res = await fetch(base + "/");
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("Connected agents");
  });

  test("snapshot shows agents by name and never leaks auth headers", async () => {
    const c = await connect({ "x-agent-name": "main", authorization: "Bearer secret" });
    await c.callTool("whoami");
    const s = await (await fetch(base + "/api/snapshot")).json() as any;
    expect(s.agents).toHaveLength(1);
    expect(s.agents[0]).toMatchObject({ name: "main", calls: 1, headers: { "x-rocketr-account": "claude" } });
    expect(s.accounts.map((a: any) => a.username)).toEqual(["claude", "lead"]);
    expect(JSON.stringify(s)).not.toContain("secret");
  });

  test("snapshot reports pending counts by account without message content", async () => {
    rcServer.post("dm-boss-lead", "boss", "queued");
    await Bun.sleep(100);
    const s = await (await fetch(base + "/api/snapshot")).json() as any;
    expect(s.pendingByAccount).toEqual({ lead: 1 });
    expect(JSON.stringify(s.pendingByAccount)).not.toContain("queued");
  });

  test("the stream carries tool calls live", async () => {
    const res = await fetch(base + "/api/stream");
    const reader = res.body!.getReader();
    const c = await connect({ "x-agent-name": "streamer" });
    await c.callTool("whoami");
    let buf = "";
    const dec = new TextDecoder();
    while (!buf.includes('"type":"tool"')) buf += dec.decode((await reader.read()).value);
    await reader.cancel();
    expect(buf).toContain('"tool":"whoami"');
  });
});
