import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeConnection } from "@brooswit/thatch/testing";
import { createRocketr, type Rocketr, type CreateRocketrDeps } from "../../src/app.js";
import type { Config } from "../../src/config.js";
import { FakeRocketChat } from "./fake-rocketchat.js";
import { DEFAULT_ATTACHMENT_TYPES } from "../../src/attachment-types.js";

let rcServer: FakeRocketChat, r: Rocketr, dir: string, base: string;
const conns: FakeConnection[] = [];
const presenceStates = new Map<string, boolean>();

/** The header set's URL is https:// (so header validation is exercised honestly); this test-only
 * fetch override rewrites it back to the fake server's real http:// transport. Never used in production. */
const toHttp = ((url: string | URL | Request, init?: RequestInit) => fetch(String(url).replace(/^https:\/\//, "http://"), init)) as typeof fetch;

const httpsUrl = () => rcServer.url.replace(/^http:\/\//, "https://");
const ON = { "x-rocketr-channel": "on" };
const CLAUDE = () => ({ "x-rocketr-url": httpsUrl(), "x-rocketr-user-id": "bot1", "x-rocketr-token": "tok", "x-rocketr-notify": "all", "x-rocketr-batch-ms": "0" });
const LEAD = () => ({ "x-rocketr-url": httpsUrl(), "x-rocketr-user-id": "bot2", "x-rocketr-token": "tok2", "x-rocketr-notify": "all", "x-rocketr-batch-ms": "0" });

/** Connects as @claude unless the headers name another credential. */
const connect = async (headers: Record<string, string> = {}) => { const c = await FakeConnection.connect(base, { headers: { ...CLAUDE(), ...headers } }); conns.push(c); return c; };

const baseConfig = (): Config => ({ host: "127.0.0.1", port: 0, attachmentDir: dir, attachmentMaxBytes: 1024, attachmentTypes: DEFAULT_ATTACHMENT_TYPES });

async function spin(deps: CreateRocketrDeps = {}, cfg: Partial<Config> = {}) {
  const rr = await createRocketr({ ...baseConfig(), ...cfg }, {
    fetch: toHttp,
    presence: ({ userId }) => ({
      setListening: (value) => presenceStates.set(userId, value),
      stop: () => presenceStates.set(userId, false),
    }),
    gracePeriodMs: 30,
    ...deps,
  });
  const url = `http://127.0.0.1:${(await rr.listen()).port}`;
  return { rr, url };
}

beforeEach(async () => {
  rcServer = new FakeRocketChat().start();
  dir = await mkdtemp(join(tmpdir(), "rocketr-att-"));
  presenceStates.clear();
  const spun = await spin();
  r = spun.rr;
  base = spun.url;
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

  test("whoami reports the identity /me resolved to, and the proxied server URL", async () => {
    const c = await connect();
    expect(await c.callTool("whoami")).toMatchObject({ username: "claude", user_id: "bot1", server: httpsUrl() });
  });

  test("list_rooms", async () => {
    const c = await connect();
    expect((await c.callTool("list_rooms")).map((x: any) => x.name)).toEqual(["general", "boss", "lead"]);
  });

  test("send_message resolves @user, #channel and raw ids, and threads", async () => {
    const c = await connect();
    await c.callTool("send_message", { room: "@boss", text: "hi boss" });
    await c.callTool("send_message", { room: "#general", text: "hi all" });
    await c.callTool("send_message", { room: "GENERAL", text: "in thread", thread_id: "t1" });
    expect(rcServer.sent).toEqual([{ rid: "dm-boss", msg: "hi boss" }, { rid: "GENERAL", msg: "hi all" }, { rid: "GENERAL", msg: "in thread", tmid: "t1" }]);
  });

  test("reactions explicitly add or remove using the calling credential's own identity", async () => {
    const c = await connect();
    const lead = await connect(LEAD());
    await c.callTool("react_to_message", { message_id: "m1", emoji: "eyes" });
    await lead.callTool("react_to_message", { message_id: "m1", emoji: "eyes", add: false });
    expect(rcServer.reactions).toEqual([
      { uid: "bot1", messageId: "m1", emoji: "eyes", shouldReact: true },
      { uid: "bot2", messageId: "m1", emoji: "eyes", shouldReact: false },
    ]);
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

  test("add_member on a private group the caller does NOT belong to fails with the room's own not-allowed error", async () => {
    const c = await connect(LEAD()); // lead is not a member of PRIVATE
    await expect(c.callTool("add_member", { room: "PRIVATE", username: "rando" })).rejects.toThrow("error-not-allowed");
  });
});

describe("stateless credential sessions", () => {
  test("every required header is mandatory: missing any one refuses the connection", async () => {
    const full = CLAUDE();
    for (const field of ["x-rocketr-url", "x-rocketr-user-id", "x-rocketr-token"] as const) {
      const headers = { ...full };
      delete (headers as Record<string, string>)[field];
      await expect(FakeConnection.connect(base, { headers })).rejects.toThrow();
    }
  });

  test("http:// (not https://) is refused", async () => {
    await expect(FakeConnection.connect(base, { headers: { ...CLAUDE(), "x-rocketr-url": rcServer.url } })).rejects.toThrow();
  });

  test("an invalid Rocket.Chat credential (401) is refused, with no account name ever involved", async () => {
    await expect(FakeConnection.connect(base, { headers: { ...CLAUDE(), "x-rocketr-token": "wrong" } })).rejects.toThrow();
  });

  test("two connections with the identical credential share one session/identity", async () => {
    const a = await connect();
    const b = await connect();
    expect((await a.callTool("whoami")).user_id).toBe((await b.callTool("whoami")).user_id);
    expect(r.sessions()).toHaveLength(1);
  });

  test("two different credentials get two different sessions, each speaking as its own identity", async () => {
    const a = await connect();
    const b = await connect(LEAD());
    expect((await a.callTool("whoami")).username).toBe("claude");
    expect((await b.callTool("whoami")).username).toBe("lead");
    expect(r.sessions()).toHaveLength(2);
  });

  test("a session is torn down after its last connection disconnects, plus the grace period", async () => {
    const c = await connect();
    await c.callTool("whoami");
    expect(r.sessions()).toHaveLength(1);
    await c.disconnect();
    conns.splice(conns.indexOf(c), 1);
    await Bun.sleep(80); // past the 30ms test grace period
    expect(r.sessions()).toHaveLength(0);
  });
});

test("presence follows channel sessions per credential key and survives overlapping sessions", async () => {
  await connect();
  expect(presenceStates.get("bot1")).toBe(false);
  const a = await connect(ON);
  const b = await connect(ON);
  const lead = await connect({ ...ON, ...LEAD() });
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
    await Bun.sleep(80); // let the notification stream attach
    rcServer.post("dm-boss", "boss", "you there?");
    const f = await c.nextFrame(5000);
    expect(f.content).toBe("you there?");
    expect(f.meta).toMatchObject({ kind: "dm", room_id: "dm-boss", sender: "boss" });
    await Bun.sleep(60);
    expect(rcServer.reads).toContain("dm-boss");
  }, 10_000);

  test("any sender, any message: a DM, a plain channel message and a thread reply all land", async () => {
    const c = await connect(ON);
    await Bun.sleep(80);
    rcServer.post("GENERAL", "rando", "lunch?");
    expect((await c.nextFrame(5000)).meta).toMatchObject({ kind: "channel", sender: "rando", room_id: "GENERAL" });
    rcServer.post("GENERAL", "boss", "in the thread", { tmid: "t1" });
    expect((await c.nextFrame(5000)).meta).toMatchObject({ kind: "thread", thread_id: "t1" });
  }, 10_000);

  test("a message that arrives with a tools-only (non-channel) session keeping the session alive waits, then lands once a channel session connects", async () => {
    // The session (and its watcher) only exists while at least one connection for its credential is
    // open — a tools-only connection is enough to keep polling going, even though it isn't itself
    // opted into the channel. See the "restart / lookback" tests below for the no-connection-at-all case.
    const tools = await connect({ "x-agent-name": "tools-only" });
    rcServer.post("dm-boss", "boss", "while you were out");
    await Bun.sleep(3300);
    expect(r.pending.length).toBe(1);
    const c = await connect(ON);
    expect((await c.nextFrame(5000)).content).toBe("while you were out");
    await Bun.sleep(60);
    expect(r.pending.length).toBe(0);
    await tools.disconnect();
  }, 10_000);

  test("pushes are opt-in: a tools-only session never swallows a message", async () => {
    const tools = await connect({ "x-agent-name": "tools-only" });
    rcServer.post("dm-boss", "boss", "anyone?");
    await Bun.sleep(3300);
    expect(r.pending.length).toBe(1);
    await tools.disconnect();
  }, 10_000);

  test("a DM to one credential reaches only that credential's sessions", async () => {
    const claude = await connect(ON);
    const lead = await connect({ ...LEAD(), ...ON });
    await Bun.sleep(80);
    rcServer.post("dm-boss-lead", "boss", "for the lead");
    const f = await lead.nextFrame(5000);
    expect(f.meta).toMatchObject({ account: "lead", room_id: "dm-boss-lead", sender: "boss" });
    rcServer.post("dm-boss", "boss", "for claude");
    expect((await claude.nextFrame(5000)).content).toBe("for claude"); // not "for the lead"
  }, 10_000);
});

describe("web app", () => {
  test("serves the page", async () => {
    const res = await fetch(base + "/");
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("Connected agents");
  });

  test("snapshot shows sessions by username and NEVER leaks the credential headers or authorization", async () => {
    const c = await connect({ "x-agent-name": "main", authorization: "Bearer unrelated-secret" });
    await c.callTool("whoami");
    const s = await (await fetch(base + "/api/snapshot")).json() as any;
    expect(s.agents).toHaveLength(1);
    expect(s.agents[0]).toMatchObject({ name: "main", calls: 1, username: "claude" });
    expect(s.sessions.map((x: any) => x.username)).toEqual(["claude"]);
    expect(JSON.stringify(s)).not.toContain("unrelated-secret");
    expect(JSON.stringify(s)).not.toContain("tok"); // the RocketChat token substring
  });

  test("snapshot exposes per-session stream health (FACTORY-644 item 3)", async () => {
    const c = await connect();
    await c.callTool("whoami");
    const s = await (await fetch(base + "/api/snapshot")).json() as any;
    expect(s.sessions[0].health).toMatchObject({ running: true, consecutiveFailures: 0 });
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

  describe("observer app loopback guard", () => {
    test("a non-loopback source is refused regardless of the MCP endpoint", async () => {
      const { rr, url } = await spin({ requestIP: () => "203.0.113.5" });
      try {
        for (const path of ["/", "/api/snapshot", "/api/stream"]) expect((await fetch(url + path)).status).toBe(403);
      } finally { await rr.stop(); }
    });
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
    const ssrf = withAttachment("a.png", "http://127.0.0.1:1/file-upload/x/a.png");
    await fails({ message_id: ssrf._id }, "not a Rocket.Chat upload");
  });
});

describe("checkAccess, limits, counters, and redaction (FACTORY-656)", () => {
  test("checkAccess denies the connection: nothing reaches Rocket.Chat and the refusal is logged without secrets", async () => {
    let calls = 0;
    const { rr, url } = await spin({ checkAccess: () => { calls++; return { allow: false, reason: "policy test" }; } });
    try {
      await expect(FakeConnection.connect(url, { headers: CLAUDE() })).rejects.toThrow();
      expect(calls).toBe(1);
      const logs = rr.activity.snapshot().events.filter((e): e is Extract<typeof e, { type: "log" }> => e.type === "log").map((e) => e.message);
      expect(logs.some((m) => m.includes("checkAccess denied") && m.includes("policy test"))).toBe(true);
      expect(logs.join("\n")).not.toContain("tok");
    } finally { await rr.stop(); }
  });

  test("checkAccess is called once per connection, and again only for a BRAND NEW credential key", async () => {
    const events: string[] = [];
    const { rr, url } = await spin({ checkAccess: (ctx) => { events.push(ctx.event); return { allow: true }; } });
    try {
      const a = await FakeConnection.connect(url, { headers: CLAUDE() });
      const b = await FakeConnection.connect(url, { headers: CLAUDE() }); // same credential — connection event only, no new-key
      expect(events).toEqual(["connection", "new-key", "connection"]);
      await a.disconnect(); await b.disconnect();
    } finally { await rr.stop(); }
  });

  test("a denied new-key check blocks the session even though the connection check allowed it", async () => {
    const { rr, url } = await spin({ checkAccess: (ctx) => ctx.event === "new-key" ? { allow: false, reason: "no new keys" } : { allow: true } });
    try {
      await expect(FakeConnection.connect(url, { headers: CLAUDE() })).rejects.toThrow();
    } finally { await rr.stop(); }
  });

  test("a stub that denies blocks all outbound calls — no RocketChat traffic happens at all", async () => {
    const before = rcServer.fileRequests.length;
    const { rr, url } = await spin({ checkAccess: () => ({ allow: false, reason: "deny everything" }) });
    try {
      await expect(FakeConnection.connect(url, { headers: CLAUDE() })).rejects.toThrow();
      expect(rcServer.fileRequests.length).toBe(before);
    } finally { await rr.stop(); }
  });

  test("per-source-IP connection limit refuses further connections from that IP", async () => {
    const { rr, url } = await spin({ limits: { maxConnectionsPerIP: 1 } });
    try {
      const a = await FakeConnection.connect(url, { headers: CLAUDE() });
      await expect(FakeConnection.connect(url, { headers: LEAD() })).rejects.toThrow();
      await a.disconnect();
    } finally { await rr.stop(); }
  });

  test("per-source-IP distinct-credential-key limit refuses a brand-new key once hit, but an already-used key still works", async () => {
    const { rr, url } = await spin({ limits: { maxKeysPerIP: 1 } });
    try {
      const a = await FakeConnection.connect(url, { headers: CLAUDE() });
      await expect(FakeConnection.connect(url, { headers: LEAD() })).rejects.toThrow();
      const again = await FakeConnection.connect(url, { headers: CLAUDE() }); // same key as `a` — fine
      await a.disconnect(); await again.disconnect();
    } finally { await rr.stop(); }
  });

  test("the tool-call rate limit refuses further calls once a connection exceeds it", async () => {
    const { rr, url } = await spin({ limits: { toolCallsPerMinutePerConnection: 2 } });
    try {
      const c = await FakeConnection.connect(url, { headers: CLAUDE() });
      await c.callTool("whoami");
      await c.callTool("whoami");
      await expect(c.callTool("whoami")).rejects.toThrow(/rate limit/);
      await c.disconnect();
    } finally { await rr.stop(); }
  });

  test("X-Forwarded-For is trusted ONLY from the loopback peer (Caddy); a non-loopback peer's header is ignored", async () => {
    const seen: string[] = [];
    const { rr, url } = await spin({ requestIP: () => "127.0.0.1", checkAccess: (ctx) => { seen.push(ctx.sourceIP); return { allow: true }; } });
    try {
      const c = await FakeConnection.connect(url, { headers: { ...CLAUDE(), "x-forwarded-for": "203.0.113.9" } });
      // checkAccess fires for both the "connection" and "new-key" events on a fresh key — every one should see the trusted forwarded IP.
      expect(seen.length).toBeGreaterThan(0);
      expect(seen.every((ip) => ip === "203.0.113.9")).toBe(true);
      await c.disconnect();
    } finally { await rr.stop(); }

    const seen2: string[] = [];
    const { rr: rr2, url: url2 } = await spin({ requestIP: () => "198.51.100.1", checkAccess: (ctx) => { seen2.push(ctx.sourceIP); return { allow: true }; } });
    try {
      const c = await FakeConnection.connect(url2, { headers: { ...CLAUDE(), "x-forwarded-for": "203.0.113.9" } }); // spoofed — peer is NOT loopback
      expect(seen2.length).toBeGreaterThan(0);
      expect(seen2.every((ip) => ip === "198.51.100.1")).toBe(true); // the spoofed header is ignored outright
      await c.disconnect();
    } finally { await rr2.stop(); }
  });

  test("the credential headers are redacted in what checkAccess receives too", async () => {
    let headers: Record<string, string> = {};
    const { rr, url } = await spin({ checkAccess: (ctx) => { headers = ctx.headers; return { allow: true }; } });
    try {
      const c = await FakeConnection.connect(url, { headers: CLAUDE() });
      expect(headers["x-rocketr-url"]).toBe("[redacted]");
      expect(headers["x-rocketr-user-id"]).toBe("[redacted]");
      expect(headers["x-rocketr-token"]).toBe("[redacted]");
      await c.disconnect();
    } finally { await rr.stop(); }
  });
});

describe("restart / lookback behavior (FACTORY-644 item 2)", () => {
  test("lookbackSec: 0 (the header's default-absent case mapped through the manager's chosen default of 120) still never replays something from before connection by default in this harness — explicit 0 proves no-replay", async () => {
    rcServer.post("GENERAL", "boss", "already there before anyone connected");
    const c = await connect({ ...ON, "x-rocketr-lookback-sec": "0" });
    await Bun.sleep(3300);
    // nothing should have been pushed for a message that predates the session with no lookback
    const pushed = r.activity.snapshot().events.filter((e) => e.type === "push");
    expect(pushed).toHaveLength(0);
  }, 10_000);

  test("a non-zero lookback replays a message that happened just before the session started", async () => {
    rcServer.post("GENERAL", "boss", "@claude just before you connected", { mentions: [{ _id: "bot1" }] });
    const c = await connect({ ...ON, "x-rocketr-notify": "mentions", "x-rocketr-lookback-sec": "30" });
    const f = await c.nextFrame(5000);
    expect(f.content).toContain("just before you connected");
  }, 10_000);
});
