import { z, type Connection, type ToolDef } from "@brooswit/thatch";
import { NOTIFY_LEVELS, type Message, type NotifyLevel, type RocketChat, type Room, type User } from "./rocketchat.js";
import { levelOf } from "./watcher.js";
import type { Activity } from "./activity.js";

/** Infers handler args from the zod shape, then erases to the registry's type. */
const tool = <S extends z.ZodRawShape>(def: ToolDef<S>): ToolDef<any> => def as ToolDef<any>;

const ROOM = z.string().min(1).describe('Room: an id (e.g. the room_id from a <channel source="rocketr"> tag), "#channel", or "@username" for a DM');

export const view = (m: Message) => ({
  id: m._id,
  ts: m.ts,
  sender: m.u.username,
  text: m.msg,
  ...(m.t ? { system: m.t } : {}),
  ...(m.tmid ? { thread_id: m.tmid } : {}),
  ...(m.tcount ? { replies: m.tcount } : {}),
});

/** "@user" → that DM; "#name" or a bare name → the room by name; anything else is tried as an id first. */
export async function resolveRoom(rc: RocketChat, ref: string): Promise<Room> {
  if (ref.startsWith("@")) return rc.dm(ref.slice(1));
  if (ref.startsWith("#")) return rc.roomByName(ref.slice(1));
  try { return await rc.roomById(ref); } catch { return rc.roomByName(ref); }
}

/** What a tool needs from the account a connection is bound to. */
export interface AccountHandle { rc: RocketChat; self: User }

export function buildTools(accountOf: (c: Connection) => AccountHandle, url: string, fallback: NotifyLevel): Record<string, ToolDef<any>> {
  return {
    whoami: tool({
      description: "The Rocket.Chat account this session speaks as (chosen by its x-rocketr-account header).",
      input: {},
      handler: (_a, c) => { const { self } = accountOf(c); return { user_id: self._id, username: self.username, server: url }; },
    }),
    list_rooms: tool({
      description: "Rooms this session's account is in, with unread and mention counts.",
      input: {},
      handler: async (_a, c) => (await accountOf(c).rc.subscriptions()).map((s) => ({
        room_id: s.rid, name: s.fname || s.name, type: s.t, unread: s.unread, mentions: s.userMentions,
      })),
    }),
    read_messages: tool({
      description: "Recent messages in a room (oldest first), or in one thread when thread_id is given.",
      input: {
        room: ROOM,
        count: z.number().int().min(1).max(100).optional().describe("How many, default 20"),
        thread_id: z.string().optional().describe("Read this thread instead of the room's main timeline"),
      },
      handler: async ({ room, count = 20, thread_id }, c) => {
        const { rc } = accountOf(c);
        const msgs = thread_id ? await rc.threadMessages(thread_id, count) : await rc.history(await resolveRoom(rc, room), count);
        // Rocket.Chat answers newest-first; reverse, then a stable sort keeps same-millisecond messages in order
        return msgs.map(view).reverse().sort((a, b) => a.ts.localeCompare(b.ts));
      },
    }),
    send_message: tool({
      description:
        'Post a message to Rocket.Chat. This is the reply tool for <channel source="rocketr"> events: pass the tag\'s room_id as room, ' +
        "and its thread_id (if present) to answer inside that thread. Markdown is supported.",
      input: {
        room: ROOM,
        text: z.string().min(1).describe("Message text"),
        thread_id: z.string().optional().describe("Reply inside this thread"),
      },
      handler: async ({ room, text, thread_id }, c) => {
        const { rc } = accountOf(c);
        const r = await resolveRoom(rc, room);
        const m = await rc.send(r._id, text, thread_id);
        return { sent: true, message_id: m._id, room_id: r._id };
      },
    }),
    get_notifications: tool({
      description:
        "This account's notification level for a room, which decides what rocketr pushes into your session: " +
        "all = every message; mentions = DMs, @mentions and replies in threads you follow; nothing = none.",
      input: { room: ROOM },
      handler: async ({ room }, c) => {
        const { rc } = accountOf(c);
        const sub = await rc.subscription((await resolveRoom(rc, room))._id);
        return { room_id: sub.rid, name: sub.fname || sub.name, level: levelOf(sub, fallback), saved: sub.desktopNotifications ?? null, muted: !!sub.disableNotifications };
      },
    }),
    set_notifications: tool({
      description:
        "Set this account's notification level for a room (Rocket.Chat's own per-room preference). Use `mentions` or " +
        "`nothing` to quiet a noisy room; `all` to hear every message again.",
      input: { room: ROOM, level: z.enum(NOTIFY_LEVELS).describe("all | mentions | nothing") },
      handler: async ({ room, level }, c) => {
        const { rc } = accountOf(c);
        const r = await resolveRoom(rc, room);
        await rc.saveNotification(r._id, level);
        return { room_id: r._id, level };
      },
    }),
  };
}

/** Wrap every handler so each call lands in the activity log against the calling agent. */
export function instrument(tools: Record<string, ToolDef<any>>, activity: Activity): Record<string, ToolDef<any>> {
  return Object.fromEntries(Object.entries(tools).map(([name, def]) => [name, {
    ...def,
    handler: async (args: unknown, c: Connection) => {
      const t0 = performance.now();
      try {
        const out = await def.handler(args as never, c);
        activity.toolCall(c.id, name, args, true, out, Math.round(performance.now() - t0));
        return out;
      } catch (err) {
        activity.toolCall(c.id, name, args, false, (err as Error).message, Math.round(performance.now() - t0));
        throw err;
      }
    },
  } satisfies ToolDef<any>]));
}
