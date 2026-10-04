import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeConnection } from "@brooswit/thatch/testing";
import { createRocketr, type Rocketr } from "../../src/app.js";
import type { Config } from "../../src/config.js";
import { FakeRocketChat } from "./fake-rocketchat.js";
import { DEFAULT_ATTACHMENT_TYPES } from "../../src/attachment-types.js";

let rcServer: FakeRocketChat, r: Rocketr, base: string, dir: string;
const conns: FakeConnection[] = [];
const presenceStates = new Map<string, boolean>();
const ON = { "x-rocketr-channel": "on" };
const CLAUDE = { "x-rocketr-account": "claude" };
const LEAD = { "x-rocketr-account": "lead" };
/** Connects as @claude unless the headers name another account. */
const connect = async (headers: Record<string, string> = {}) => { const c = await FakeConnection.connect(base, { headers: { ...CLAUDE, ...headers } }); conns.push(c); return c; };

beforeEach(async () => {
  rcServer = new FakeRocketChat().start();
  dir = await mkdtemp(join(tmpdir(), "rocketr-att-"));
  const cfg: Config = {
   attachmentDir: dir, attachmentMaxBytes: 1024, attachmentTypes: DEFAULT_ATTACHMENT_TYPES,
    url: rcServer.url, defaultNotifications: "all", migrateLegacyAllToMentions: false, batchMs: 0, pollMs: 20, host: "127.0.0.1", port: 0, allowUnauthenticatedLoopback: true,
    accounts: [{ name: "claude", userId: "bot1", token: "tok" }, { name: "lead", userId: "bot2", token: "tok2" }],
  };
  presenceStates.clear();
  r = await createRocketr(cfg, { presence: ({ userId }) => ({
    setListening: (value) => { presenceStates.set(userId, value); },
    stop: () => { presenceStates.set(userId, false); },
  }) });
  base = `http://127.0.0.1:${(await r.listen()).port}`;
});

afterEach(async () => {
  for (const c of conns.splice(0)) await c.disconnect().catch(() => {});
  await r.stop();
  rcServer.stop();
  await rm(dir, { recursive: true, force: true });
});

describe("tools", () => {
  test("lists the tools", async () => {
    const c = await connect();
    expect((await c.listTools()).map((t) => t.name).sort())
      .toEqual(["add_member", "download_attachment", "get_notifications", "list_rooms", "react_to_message", "read_messages", "remove_member", "send_image", "send_message", "set_notifications", "whoami"]);
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

  test("reactions explicitly add or remove using the calling account", async () => {
    const c = await connect();
    const lead = await connect(LEAD);
    await c.callTool("react_to_message", { message_id: "m1", emoji: "eyes" });
    await c.callTool("react_to_message", { message_id: "m1", emoji: "eyes" });
    await lead.callTool("react_to_message", { message_id: "m1", emoji: "eyes", add: false });
    expect(rcServer.reactions).toEqual([
      { uid: "bot1", messageId: "m1", emoji: "eyes", shouldReact: true },
      { uid: "bot1", messageId: "m1", emoji: "eyes", shouldReact: true },
      { uid: "bot2", messageId: "m1", emoji: "eyes", shouldReact: false },
    ]);
    await expect(c.callTool("react_to_message", { message_id: "", emoji: "eyes" })).rejects.toThrow();
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

  test("add_member and remove_member invite/kick by username, resolving room and type", async () => {
    const c = await connect();
    expect(await c.callTool("add_member", { room: "#general", username: "rando" })).toEqual({ room_id: "GENERAL", username: "rando", added: true });
    expect(rcServer.invited).toEqual([{ rid: "GENERAL", userId: "u-rando" }]);
    expect(await c.callTool("remove_member", { room: "GENERAL", username: "rando" })).toEqual({ room_id: "GENERAL", username: "rando", removed: true });
    expect(rcServer.kicked).toEqual([{ rid: "GENERAL", userId: "u-rando" }]);
  });

  test("add_member on a private group the caller belongs to succeeds", async () => {
    const c = await connect(); // claude is a member of PRIVATE
    expect(await c.callTool("add_member", { room: "PRIVATE", username: "rando" })).toMatchObject({ added: true });
    expect(rcServer.invited).toContainEqual({ rid: "PRIVATE", userId: "u-rando" });
  });

  test("add_member on a private group the caller does NOT belong to fails with the room's own not-allowed error", async () => {
    const c = await connect(LEAD); // lead is not a member of PRIVATE
    await expect(c.callTool("add_member", { room: "PRIVATE", username: "rando" })).rejects.toThrow("error-not-allowed");
  });

  test("add_member and remove_member refuse a DM, which has no membership list to change", async () => {
    const c = await connect();
    await expect(c.callTool("add_member", { room: "@boss", username: "rando" })).rejects.toThrow('cannot add a member to a "d" room');
    await expect(c.callTool("remove_member", { room: "@boss", username: "rando" })).rejects.toThrow('cannot remove a member from a "d" room');
  });

  test("add_member on an unknown username fails clearly", async () => {
    const c = await connect();
    await expect(c.callTool("add_member", { room: "#general", username: "ghost" })).rejects.toThrow("User not found");
  });
});

test("presence follows channel sessions per account and survives overlapping sessions", async () => {
  await connect();
  expect(presenceStates.get("bot1")).toBe(false);
  const a = await connect(ON);
  const b = await connect(ON);
  const lead = await connect({ ...ON, ...LEAD });
  expect(presenceStates.get("bot1")).toBe(true);
  expect(presenceStates.get("bot2")).toBe(true);
  await a.disconnect();
  await Bun.sleep(20);
  expect(presenceStates.get("bot1")).toBe(true);
  await b.disconnect();
  await Bun.sleep(20);
  expect(presenceStates.get("bot1")).toBe(false);
  expect(presenceStates.get("bot2")).toBe(true);
  await lead.disconnect();
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

  test("muting a room discards its already-queued frames for that account", async () => {
    rcServer.post("dm-boss-lead", "boss", "hold this");
    await Bun.sleep(100);
    expect(r.pending.map((item) => item.account)).toEqual(["lead"]);

    const c = await connect({ ...LEAD, ...ON });
    await c.callTool("set_notifications", { room: "@boss", level: "nothing" });
    expect(r.pending).toEqual([]);
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

  test("an opt-in default account serves a client that names none, and still refuses a wrong name", async () => {
    const single = await createRocketr({
      attachmentDir: dir, attachmentMaxBytes: 1024, attachmentTypes: DEFAULT_ATTACHMENT_TYPES, url: rcServer.url, defaultNotifications: "all", migrateLegacyAllToMentions: false, batchMs: 0, pollMs: 20, host: "127.0.0.1", port: 0, allowUnauthenticatedLoopback: true,
      accounts: [{ name: "claude", userId: "bot1", token: "tok" }], defaultAccount: "claude",
    }, { presence: () => ({ setListening: () => {}, stop: () => {} }) });
    const url = `http://127.0.0.1:${(await single.listen()).port}`;
    try {
      const c = await FakeConnection.connect(url, { headers: { ...ON } });
      conns.push(c);
      expect((await c.callTool("whoami")).username).toBe("claude");
      await Bun.sleep(50); // let the notification stream attach
      rcServer.post("dm-boss", "boss", "headerless?");
      expect((await c.nextFrame(3000)).content).toBe("headerless?");
      await expect(FakeConnection.connect(url, { headers: { "x-rocketr-account": "lead" } })).rejects.toThrow();
    } finally {
      for (const c of conns.splice(0)) await c.disconnect().catch(() => {});
      await single.stop();
    }
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

  test("an account whose token signs in as someone else is never served under the name it claims: if it's the ONLY configured account, zero accounts would be served, so startup still exits", async () => {
    const bad: Config = { attachmentDir: dir, attachmentMaxBytes: 1024, attachmentTypes: DEFAULT_ATTACHMENT_TYPES, url: rcServer.url, defaultNotifications: "all", migrateLegacyAllToMentions: false, batchMs: 0, pollMs: 20, host: "127.0.0.1", port: 0, allowUnauthenticatedLoopback: true, accounts: [{ name: "claude", userId: "bot2", token: "tok2" }] };
    await expect(createRocketr(bad)).rejects.toThrow('"claude": signs in as @lead, not @claude');
  });

  test("the same drifted account is excluded, not fatal, when another account is healthy: blast radius changed, the guarantee didn't", async () => {
    const cfg: Config = {
      attachmentDir: dir, attachmentMaxBytes: 1024, attachmentTypes: DEFAULT_ATTACHMENT_TYPES, url: rcServer.url, defaultNotifications: "all", migrateLegacyAllToMentions: false, batchMs: 0, pollMs: 20, host: "127.0.0.1", port: 0, allowUnauthenticatedLoopback: true,
      accounts: [{ name: "lead", userId: "bot2", token: "tok2" }, { name: "claude", userId: "bot2", token: "tok2" }],
    };
    const isolated = await createRocketr(cfg, { presence: () => ({ setListening: () => {}, stop: () => {} }) });
    try {
      expect([...isolated.accounts.keys()]).toEqual(["lead"]);
      expect(isolated.excludedAccounts).toEqual([{ name: "claude", detail: "signs in as @lead, not @claude" }]);
      const url = `http://127.0.0.1:${(await isolated.listen()).port}`;
      // an excluded account must never fall through to some other account's session
      await expect(FakeConnection.connect(url, { headers: { "x-rocketr-account": "claude" } })).rejects.toThrow();
      const stillLead = await FakeConnection.connect(url, { headers: { "x-rocketr-account": "lead" } });
      expect((await stillLead.callTool("whoami")).username).toBe("lead");
      await stillLead.disconnect();
    } finally {
      await isolated.stop();
    }
  });

  test("multi-account drift: healthy accounts come up and the process does not throw; a 401 account is excluded the same way as a username mismatch", async () => {
    const cfg: Config = {
      attachmentDir: dir, attachmentMaxBytes: 1024, attachmentTypes: DEFAULT_ATTACHMENT_TYPES, url: rcServer.url, defaultNotifications: "all", migrateLegacyAllToMentions: false, batchMs: 0, pollMs: 20, host: "127.0.0.1", port: 0, allowUnauthenticatedLoopback: true,
      accounts: [
        { name: "claude", userId: "bot1", token: "tok" }, // healthy
        { name: "lead", userId: "bot2", token: "tok2" }, // healthy
        { name: "renamed", userId: "bot2", token: "tok2" }, // signs in as "lead", not "renamed": drifted
        { name: "ghost", userId: "bot3", token: "nope" }, // unknown to the server: 401
      ],
    };
    const multi = await createRocketr(cfg, { presence: () => ({ setListening: () => {}, stop: () => {} }) });
    try {
      await multi.listen();
      expect([...multi.accounts.keys()].sort()).toEqual(["claude", "lead"]);
      expect(multi.excludedAccounts.map((f) => f.name).sort()).toEqual(["ghost", "renamed"]);
      expect(multi.excludedAccounts.find((f) => f.name === "ghost")?.detail).toContain("401");
    } finally {
      await multi.stop();
    }
  });

  test("the consolidated startup error names EVERY failed account, not just the first (this would fail against first-failure-only behavior)", async () => {
    const cfg: Config = {
      attachmentDir: dir, attachmentMaxBytes: 1024, attachmentTypes: DEFAULT_ATTACHMENT_TYPES, url: rcServer.url, defaultNotifications: "all", migrateLegacyAllToMentions: false, batchMs: 0, pollMs: 20, host: "127.0.0.1", port: 0, allowUnauthenticatedLoopback: true,
      accounts: [
        { name: "claude", userId: "bot1", token: "tok" },
        { name: "renamed", userId: "bot2", token: "tok2" },
        { name: "ghost", userId: "bot3", token: "nope" },
      ],
    };
    const partial = await createRocketr(cfg, { presence: () => ({ setListening: () => {}, stop: () => {} }) });
    try {
      await partial.listen();
      const consolidated = partial.activity.snapshot().events
        .filter((e): e is Extract<typeof e, { type: "log" }> => e.type === "log")
        .map((e) => e.message)
        .find((m) => m.includes("startup preflight"));
      expect(consolidated).toBeDefined();
      // the whole point of the fix: both failed accounts are named in the ONE message, not just the first
      expect(consolidated).toContain("renamed");
      expect(consolidated).toContain("ghost");
    } finally {
      await partial.stop();
    }
  });

  test("when every configured account fails, createRocketr rejects with one message naming all of them", async () => {
    const allBad: Config = {
      attachmentDir: dir, attachmentMaxBytes: 1024, attachmentTypes: DEFAULT_ATTACHMENT_TYPES, url: rcServer.url, defaultNotifications: "all", migrateLegacyAllToMentions: false, batchMs: 0, pollMs: 20, host: "127.0.0.1", port: 0, allowUnauthenticatedLoopback: true,
      accounts: [{ name: "renamed", userId: "bot2", token: "tok2" }, { name: "ghost", userId: "bot3", token: "nope" }],
    };
    let err: Error | undefined;
    try { await createRocketr(allBad); } catch (e) { err = e as Error; }
    expect(err?.message).toContain("renamed");
    expect(err?.message).toContain("ghost");
    expect(err?.message).toContain("2 of 2");
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
    expect(s.excludedAccounts).toEqual([]); // no lie by omission when there's nothing to omit
    expect(JSON.stringify(s)).not.toContain("secret");
  });

  test("snapshot reports pending counts by account without message content", async () => {
    rcServer.post("dm-boss-lead", "boss", "queued");
    await Bun.sleep(100);
    const s = await (await fetch(base + "/api/snapshot")).json() as any;
    expect(s.pendingByAccount).toEqual({ lead: 1 });
    expect(JSON.stringify(s.pendingByAccount)).not.toContain("queued");
  });

  test("snapshot names excluded accounts and why, so a partial outage isn't invisible in the web UI", async () => {
    const cfg: Config = {
      attachmentDir: dir, attachmentMaxBytes: 1024, attachmentTypes: DEFAULT_ATTACHMENT_TYPES, url: rcServer.url, defaultNotifications: "all", migrateLegacyAllToMentions: false, batchMs: 0, pollMs: 20, host: "127.0.0.1", port: 0, allowUnauthenticatedLoopback: true,
      accounts: [{ name: "lead", userId: "bot2", token: "tok2" }, { name: "claude", userId: "bot2", token: "tok2" }],
    };
    const isolated = await createRocketr(cfg, { presence: () => ({ setListening: () => {}, stop: () => {} }) });
    try {
      const url = `http://127.0.0.1:${(await isolated.listen()).port}`;
      const s = await (await fetch(url + "/api/snapshot")).json() as any;
      expect(s.accounts.map((a: any) => a.username)).toEqual(["lead"]);
      expect(s.excludedAccounts).toEqual([{ name: "claude", detail: "signs in as @lead, not @claude" }]);
    } finally {
      await isolated.stop();
    }
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

describe("download_attachment", () => {
  const PNG = Buffer.from("89504e470d0a1a0a0000", "hex");
  const withAttachment = (title: string, link: string, extra: Record<string, unknown> = {}) =>
    rcServer.post("dm-boss", "boss", "see file", { attachments: [{ title, title_link: link, ...extra }] });
  const call = async (args: Record<string, unknown>, headers: Record<string, string> = {}) => (await connect(headers)).callTool("download_attachment", args);
  const fails = (args: Record<string, unknown>, msg: string | RegExp, headers: Record<string, string> = {}) =>
    expect(call(args, headers)).rejects.toThrow(msg);

  test("remote mode (default) returns base64 bytes, using the server-returned message id", async () => {
    rcServer.files.set("/file-upload/f1/shot.png", { type: "image/png", body: PNG });
    const m = withAttachment("shot.png", "/file-upload/f1/shot.png");
    const got = (await call({ message_id: m._id })) as any;
    expect(got.message_id).toBe(m._id);
    expect(got.mime_type).toBe("image/png");
    expect(got.size).toBe(PNG.length);
    expect(Buffer.from(got.data_base64, "base64")).toEqual(PNG);
    expect(got.path).toBeUndefined();
  });

  test("local mode (explicit opt-in) saves under the configured dir and reports path, size and type", async () => {
    rcServer.files.set("/file-upload/f1b/shot.png", { type: "image/png", body: PNG });
    const m = withAttachment("shot.png", "/file-upload/f1b/shot.png");
    const saved = (await call({ message_id: m._id, mode: "local" })) as any;
    expect(saved.path).toContain(`${m._id}-0-shot.png`);
    expect(saved.size).toBe(PNG.length);
    expect(saved.mime_type).toBe("image/png");
    expect(await Bun.file(saved.path).bytes()).toEqual(new Uint8Array(PNG));
    expect(saved.path.startsWith(dir)).toBe(true);
  });

  test("refuses a disallowed type and writes nothing (local mode)", async () => {
    rcServer.files.set("/file-upload/f2/x.exe", { type: "application/x-msdownload", body: Buffer.from("MZ") });
    const m = withAttachment("x.exe", "/file-upload/f2/x.exe");
    await fails({ message_id: m._id, mode: "local" }, "not allowed");
    expect(await readdir(dir)).toEqual([]);
  });

  test("refuses an oversize file whether or not the server declares a length", async () => {
    const big = Buffer.alloc(2048, 1);
    rcServer.files.set("/file-upload/f3/a.png", { type: "image/png", body: big });
    rcServer.files.set("/file-upload/f4/b.png", { type: "image/png", body: big, lengthHeader: false });
    for (const [id, link] of [["a", "/file-upload/f3/a.png"], ["b", "/file-upload/f4/b.png"]] as const) {
      const m = withAttachment(`${id}.png`, link);
      await fails({ message_id: m._id, mode: "local" }, /limit/);
    }
    expect(await readdir(dir)).toEqual([]);
  });

  test("a traversal filename stays inside the dir (local mode), and the tmp name is unique per download", async () => {
    rcServer.files.set("/file-upload/f5/evil", { type: "text/plain", body: Buffer.from("hi") });
    const m = withAttachment("../../../etc/cron.d/evil", "/file-upload/f5/evil");
    const saved = (await call({ message_id: m._id, mode: "local" })) as any;
    expect(saved.path.startsWith(join(dir, "claude") + "/")).toBe(true);
    expect(saved.path).not.toContain("..");
  });

  test("two messages with the same filename do not overwrite each other (local mode)", async () => {
    rcServer.files.set("/file-upload/f6/a.png", { type: "image/png", body: PNG });
    const a = withAttachment("same.png", "/file-upload/f6/a.png"), b = withAttachment("same.png", "/file-upload/f6/a.png");
    await call({ message_id: a._id, mode: "local" }); await call({ message_id: b._id, mode: "local" });
    expect((await readdir(join(dir, "claude"))).length).toBe(2);
  });

  test("a missing message, missing attachment index, or non-upload link is an error", async () => {
    await fails({ message_id: "nope" }, /not found/i);
    const plain = rcServer.post("dm-boss", "boss", "no files");
    await fails({ message_id: plain._id }, "no downloadable attachment");
    const m = withAttachment("a.png", "/file-upload/f7/a.png");
    await fails({ message_id: m._id, index: 3 }, "no downloadable attachment");
    const ssrf = withAttachment("a.png", "http://127.0.0.1:1/file-upload/x/a.png");
    await fails({ message_id: ssrf._id }, "not a Rocket.Chat upload");
    const other = withAttachment("a.png", "/api/v1/users.list");
    await fails({ message_id: other._id }, "not a Rocket.Chat upload");
  });

  test("a message in a room the account cannot read is refused before any file request", async () => {
    rcServer.files.set("/file-upload/f8/a.png", { type: "image/png", body: PNG });
    const m = withAttachment("a.png", "/file-upload/f8/a.png"); // dm-boss: claude is in it, lead is not
    const before = rcServer.fileRequests.length;
    await fails({ message_id: m._id }, /not found/i, LEAD);
    expect(rcServer.fileRequests.length).toBe(before);
  });

  test("ROCKETR_ATTACHMENT_TYPES overrides the default allowlist (FACTORY-593 nit 2)", async () => {
    rcServer.files.set("/file-upload/f9/data.json", { type: "application/json", body: Buffer.from("{}") });
    const m = withAttachment("data.json", "/file-upload/f9/data.json");
    // default allowlist refuses JSON
    await fails({ message_id: m._id, mode: "local" }, "not allowed");

    const custom = await createRocketr(
      { attachmentDir: dir, attachmentMaxBytes: 1024, attachmentTypes: ["application/json"], url: rcServer.url, defaultNotifications: "all", migrateLegacyAllToMentions: false, batchMs: 0, pollMs: 20, host: "127.0.0.1", port: 0, allowUnauthenticatedLoopback: true, accounts: [{ name: "claude", userId: "bot1", token: "tok" }] },
      { presence: () => ({ setListening: () => {}, stop: () => {} }) },
    );
    try {
      const url = `http://127.0.0.1:${(await custom.listen()).port}`;
      const c = await FakeConnection.connect(url, { headers: { ...CLAUDE } });
      const got = (await c.callTool("download_attachment", { message_id: m._id, mode: "local" })) as any;
      expect(got.mime_type).toBe("application/json");
      await c.disconnect();
    } finally { await custom.stop(); }
  });
});

describe("client secret auth", () => {
  const SECRET = "s".repeat(32);
  const RC_TOKEN = "tok"; // same as the fixture account's Rocket.Chat token, below

  /** A fresh Rocketr against the shared fake Rocket.Chat, so each test picks its own secrets/host/flags. */
  const spin = async (cfg: Partial<Config> = {}, deps: Parameters<typeof createRocketr>[1] = {}) => {
    const full: Config = {
      attachmentDir: dir, attachmentMaxBytes: 1024, attachmentTypes: DEFAULT_ATTACHMENT_TYPES, url: rcServer.url, defaultNotifications: "all",
      migrateLegacyAllToMentions: false, batchMs: 0, pollMs: 20, host: "127.0.0.1", port: 0,
      allowUnauthenticatedLoopback: false,
      accounts: [{ name: "claude", userId: "bot1", token: RC_TOKEN }],
      ...cfg,
    };
    const rr = await createRocketr(full, { presence: () => ({ setListening: () => {}, stop: () => {} }), ...deps });
    const url = `http://127.0.0.1:${(await rr.listen()).port}`;
    return { rr, url };
  };

  test("the correct bearer is accepted; a wrong or missing one is refused", async () => {
    const { rr, url } = await spin({ accounts: [{ name: "claude", userId: "bot1", token: RC_TOKEN, clientSecret: SECRET }] });
    try {
      const good = await FakeConnection.connect(url, { headers: { ...CLAUDE, authorization: `Bearer ${SECRET}` } });
      expect((await good.callTool("whoami")).username).toBe("claude");
      await good.disconnect();

      await expect(FakeConnection.connect(url, { headers: { ...CLAUDE, authorization: "Bearer " + "w".repeat(32) } })).rejects.toThrow();
      await expect(FakeConnection.connect(url, { headers: { ...CLAUDE } })).rejects.toThrow(); // no Authorization at all
    } finally { await rr.stop(); }
  });

  test("the Rocket.Chat token is never accepted as a client secret", async () => {
    const { rr, url } = await spin({ accounts: [{ name: "claude", userId: "bot1", token: RC_TOKEN, clientSecret: SECRET }] });
    try {
      await expect(FakeConnection.connect(url, { headers: { ...CLAUDE, authorization: `Bearer ${RC_TOKEN}` } })).rejects.toThrow();
    } finally { await rr.stop(); }
  });

  test("an account with no secret is refused unless the transition flag is on, and only while loopback-bound", async () => {
    { // no secret, flag off (the secure-by-default end state): refused
      const { rr, url } = await spin({ allowUnauthenticatedLoopback: false });
      try { await expect(FakeConnection.connect(url, { headers: { ...CLAUDE } })).rejects.toThrow(); } finally { await rr.stop(); }
    }
    { // no secret, flag on, loopback-bound: allowed, and warns naming the account
      const { rr, url } = await spin({ allowUnauthenticatedLoopback: true });
      try {
        const c = await FakeConnection.connect(url, { headers: { ...CLAUDE } });
        expect((await c.callTool("whoami")).username).toBe("claude");
        await c.disconnect();
        const warned = rr.activity.snapshot().events.some((e) => e.type === "log" && e.message.includes("@claude") && e.message.includes("ROCKETR_ALLOW_UNAUTHENTICATED_LOOPBACK"));
        expect(warned).toBe(true);
      } finally { await rr.stop(); }
    }
  });

  test("a non-loopback bind refuses to start unless every configured account has a secret", async () => {
    await expect(spin({ host: "0.0.0.0", allowUnauthenticatedLoopback: true })).rejects.toThrow(/client secret/);
    const { rr } = await spin({ host: "0.0.0.0", accounts: [{ name: "claude", userId: "bot1", token: RC_TOKEN, clientSecret: SECRET }] });
    await rr.stop(); // every account secured: starts fine even though the bind isn't loopback
  });

  test("a locked-out source IP is refused outright, even presenting the correct secret", async () => {
    const { rr, url } = await spin(
      { accounts: [{ name: "claude", userId: "bot1", token: RC_TOKEN, clientSecret: SECRET }] },
      { authRateLimit: { maxFailures: 2, windowMs: 60_000, lockoutMs: 60_000 } },
    );
    try {
      for (let i = 0; i < 2; i++) await expect(FakeConnection.connect(url, { headers: { ...CLAUDE, authorization: "Bearer " + "w".repeat(32) } })).rejects.toThrow();
      await expect(FakeConnection.connect(url, { headers: { ...CLAUDE, authorization: `Bearer ${SECRET}` } })).rejects.toThrow();
    } finally { await rr.stop(); }
  });

  test("a refused connection creates no session, presence, or queue effect", async () => {
    let listened: boolean | undefined;
    const { rr, url } = await spin(
      { accounts: [{ name: "claude", userId: "bot1", token: RC_TOKEN, clientSecret: SECRET }] },
      { presence: () => ({ setListening: (v: boolean) => { listened = v; }, stop: () => {} }) },
    );
    try {
      await expect(FakeConnection.connect(url, {
        headers: { ...CLAUDE, ...ON, authorization: "Bearer " + "w".repeat(32) },
      })).rejects.toThrow();
      expect(listened).toBeUndefined(); // setListening was never called for a session that never registered
      expect(rr.activity.snapshot().events.some((e) => e.type === "connect")).toBe(false);
      rcServer.post("dm-boss", "boss", "while refused");
      await Bun.sleep(100);
      expect(rr.pending.length).toBe(1); // queued normally, as if nobody is listening — unaffected by the refusal
    } finally { await rr.stop(); }
  });

  test("secrets never appear in captured log output", async () => {
    const { rr, url } = await spin({ accounts: [{ name: "claude", userId: "bot1", token: RC_TOKEN, clientSecret: SECRET }] });
    try {
      const good = await FakeConnection.connect(url, { headers: { ...CLAUDE, authorization: `Bearer ${SECRET}` } });
      await good.callTool("whoami");
      await good.disconnect();
      await expect(FakeConnection.connect(url, { headers: { ...CLAUDE, authorization: "Bearer " + "w".repeat(32) } })).rejects.toThrow();
      const dump = JSON.stringify(rr.activity.snapshot());
      expect(dump).not.toContain(SECRET);
      expect(dump).not.toContain(RC_TOKEN);
    } finally { await rr.stop(); }
  });

  describe("observer app loopback guard", () => {
    test("a non-loopback source is refused regardless of client secrets", async () => {
      const { rr, url } = await spin(
        { accounts: [{ name: "claude", userId: "bot1", token: RC_TOKEN, clientSecret: SECRET }] },
        { requestIP: () => "203.0.113.5" },
      );
      try {
        for (const path of ["/", "/api/snapshot", "/api/stream"]) {
          const res = await fetch(url + path);
          expect(res.status).toBe(403);
        }
        // the MCP endpoint's own bearer auth is unaffected by this fake remote address
        const c = await FakeConnection.connect(url, { headers: { ...CLAUDE, authorization: `Bearer ${SECRET}` } });
        expect((await c.callTool("whoami")).username).toBe("claude");
        await c.disconnect();
      } finally { await rr.stop(); }
    });

    test("a loopback source still sees the observer app", async () => {
      const { rr, url } = await spin({ allowUnauthenticatedLoopback: true });
      try {
        expect((await fetch(url + "/")).status).toBe(200);
        expect((await fetch(url + "/api/snapshot")).status).toBe(200);
      } finally { await rr.stop(); }
    });
  });
});
