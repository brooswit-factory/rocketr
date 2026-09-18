import { describe, expect, test } from "bun:test";
import { Batcher, Watcher, classify, levelOf, toFrame, type InboundEvent } from "../../src/watcher.js";
import type { Message, Subscription, User } from "../../src/rocketchat.js";

const self: User = { _id: "bot1", username: "claude" };
const boss: User = { _id: "u-boss", username: "boss" };
const peer: User = { _id: "bot2", username: "lead" };
const at = "2030-01-01T00:00:01.000Z";
const dm: Subscription = { rid: "dm1", name: "boss", t: "d", unread: 1, userMentions: 0, _updatedAt: at };
const chan: Subscription = { rid: "c1", name: "general", t: "c", unread: 1, userMentions: 1, _updatedAt: at };
let n = 0;
const msg = (u: User, text: string, extra: Partial<Message> = {}): Message =>
  ({ _id: `m${++n}`, rid: "x", msg: text, ts: at, _updatedAt: at, u, ...extra });
const me = { mentions: [{ _id: "bot1" }] };

describe("levelOf", () => {
  test("the room's saved level wins", () => expect(levelOf({ ...chan, desktopNotifications: "mentions" }, "all")).toBe("mentions"));
  test("unsaved or reset rooms use the fallback", () => {
    expect(levelOf(chan, "all")).toBe("all");
    expect(levelOf({ ...chan, desktopNotifications: "default" }, "mentions")).toBe("mentions");
  });
  test("mute all beats everything", () => expect(levelOf({ ...chan, desktopNotifications: "all", disableNotifications: true }, "all")).toBe("nothing"));
});

describe("classify", () => {
  const kind = (m: Message, sub: Subscription, fallback: "all" | "mentions" | "nothing" = "all") => classify(m, sub, self, fallback)?.kind ?? null;

  test("any sender: an agent-to-agent DM is pushed", () => expect(kind(msg(peer, "hi"), dm)).toBe("dm"));
  test("level all: plain channel messages and thread replies are pushed", () => {
    expect(kind(msg(boss, "lunch?"), chan)).toBe("channel");
    expect(kind(msg(boss, "reply", { tmid: "t1" }), chan)).toBe("thread");
  });
  test("a mention outranks a thread", () => expect(kind(msg(boss, "@claude", { tmid: "t1", ...me }), chan)).toBe("mention"));

  describe("level mentions", () => {
    const quiet = { ...chan, desktopNotifications: "mentions" as const };
    test("drops plain messages and unfollowed thread replies", () => {
      expect(kind(msg(boss, "lunch?"), quiet)).toBeNull();
      expect(kind(msg(boss, "reply", { tmid: "t1" }), quiet)).toBeNull();
    });
    test("keeps @mentions, DMs and followed threads", () => {
      expect(kind(msg(boss, "@claude hi", me), quiet)).toBe("mention");
      expect(kind(msg(boss, "hi"), { ...dm, desktopNotifications: "mentions" })).toBe("dm");
      expect(kind(msg(boss, "reply", { tmid: "t1" }), { ...quiet, tunread: ["t1"] })).toBe("thread");
    });
    test("@all counts unless group mentions are muted", () => {
      const all = msg(boss, "@all standup", { mentions: [{ _id: "all" }] });
      expect(kind(all, quiet)).toBe("mention");
      expect(kind(all, { ...quiet, muteGroupMentions: true })).toBeNull();
    });
  });

  test("level nothing drops even DMs", () => expect(kind(msg(boss, "hi"), { ...dm, desktopNotifications: "nothing" })).toBeNull());
  test("the fallback applies to rooms with no saved level", () => expect(kind(msg(boss, "lunch?"), chan, "mentions")).toBeNull());
  test("never its own messages", () => expect(kind(msg(self, "echo"), dm)).toBeNull());
  test("never system messages", () => expect(kind(msg(boss, "boss", { t: "uj" }), dm)).toBeNull());
  test("never ignored users", () => expect(kind(msg(boss, "hi"), { ...dm, ignored: ["u-boss"] })).toBeNull());
});

describe("toFrame", () => {
  const ev = (m: Message, k: InboundEvent["kind"] = "channel"): InboundEvent => ({ kind: k, room: { id: "c1", name: "general", type: "c" }, message: m });

  test("one message: plain text, every meta value a string, thread and attachments carried", () => {
    const f = toFrame([ev(msg(boss, "look", { tmid: "t1", attachments: [{ title: "a.png", title_link: "/f/a.png" }] }), "mention")]);
    expect(f.content).toBe("look\n[attachment: a.png]");
    expect(f.meta).toMatchObject({ kind: "mention", room_id: "c1", room_name: "general", sender: "boss", thread_id: "t1" });
    expect(f.meta.count).toBeUndefined();
    expect(Object.values(f.meta).every((v) => typeof v === "string")).toBe(true);
  });

  test("a burst: one line per message, strongest kind, all senders and ids", () => {
    const a = msg(boss, "one"), b = msg(peer, "@claude two", me);
    const f = toFrame([ev(a), ev(b, "mention")]);
    expect(f.content).toBe("@boss: one\n@lead: @claude two");
    expect(f.meta).toMatchObject({ kind: "mention", sender: "boss,lead", message_id: b._id, message_ids: `${a._id},${b._id}`, count: "2" });
  });

  test("an empty message still has content", () => expect(toFrame([ev(msg(boss, ""), "dm")]).content).toBe("(empty message)"));
});

describe("Batcher", () => {
  const ev = (text: string) => ({ kind: "channel", room: { id: "c1", name: "general", type: "c" }, message: msg(boss, text) }) as InboundEvent;

  test("a burst in one key becomes one flush once it goes quiet; other keys stay separate", async () => {
    const out: string[][] = [];
    const b = new Batcher({ quietMs: 30, maxMs: 1000, flush: async (es) => { out.push(es.map((e) => e.message.msg)); } });
    await b.add("r1", ev("a"));
    await Bun.sleep(10);
    await b.add("r1", ev("b"));
    await b.add("r2", ev("x"));
    expect(out).toEqual([]);
    await Bun.sleep(80);
    expect(out.sort()).toEqual([["a", "b"], ["x"]]);
  });

  test("a room that never goes quiet still flushes after maxMs", async () => {
    const out: number[] = [];
    const b = new Batcher({ quietMs: 30, maxMs: 60, flush: async (es) => { out.push(es.length); } });
    for (let i = 0; i < 6; i++) { await b.add("r", ev(String(i))); await Bun.sleep(15); }
    await b.flushAll();
    expect(out.length).toBeGreaterThan(1);
    expect(out.reduce((x, y) => x + y)).toBe(6);
  });

  test("quietMs 0 flushes each event at once", async () => {
    const out: number[] = [];
    const b = new Batcher({ quietMs: 0, maxMs: 0, flush: async (es) => { out.push(es.length); } });
    await b.add("r", ev("a"));
    expect(out).toEqual([1]);
  });
});

describe("Watcher.tick", () => {
  const start = new Date("2030-01-01T00:00:00.000Z");
  const source = (subs: Subscription[], byRoom: Record<string, Message[]>) => ({
    subscriptions: async () => subs,
    syncMessages: async (rid: string) => byRoom[rid] ?? [],
  });

  test("emits events once, skips messages from before start, dedupes repeats across polls", async () => {
    const old = msg(boss, "before start", { ts: "2029-12-31T23:59:59.000Z" });
    const fresh = msg(boss, "hello");
    const got: InboundEvent[] = [];
    const w = new Watcher(source([dm], { dm1: [fresh, old] }), { self, fallback: "all", pollMs: 10, now: () => start, onEvent: async (e) => { got.push(e); } });
    await w.tick();
    await w.tick(); // the overlap window re-reads the same message
    expect(got.map((e) => e.message.msg)).toEqual(["hello"]);
  });

  test("onSubscription sees each changed room first and can change its level", async () => {
    const sub = { ...chan };
    const got: InboundEvent[] = [];
    const w = new Watcher(source([sub], { c1: [msg(boss, "chatter")] }), {
      self, fallback: "all", pollMs: 10, now: () => start,
      onSubscription: async (s) => { s.desktopNotifications = "mentions"; },
      onEvent: async (e) => { got.push(e); },
    });
    await w.tick();
    expect(got).toEqual([]);
  });

  test("start/stop survive a failing source and log it", async () => {
    const logs: string[] = [];
    const w = new Watcher({ subscriptions: async () => { throw new Error("down"); }, syncMessages: async () => [] },
      { self, fallback: "all", pollMs: 5, onEvent: async () => {}, log: (m) => logs.push(m) });
    w.start(); w.start();
    await Bun.sleep(30);
    w.stop();
    expect(logs[0]).toContain("poll failed (1x): down");
  });
});
