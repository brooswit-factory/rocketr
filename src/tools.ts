import { z, type Connection, type ToolDef } from "@brooswit/thatch";
import { NOTIFY_LEVELS, type Message, type NotifyLevel, type RocketChat, type Room, type User } from "./rocketchat.js";
import { levelOf } from "./watcher.js";
import type { Activity } from "./activity.js";

/** Infers handler args from the zod shape, then erases to the registry's type. */
const tool = <S extends z.ZodRawShape>(def: ToolDef<S>): ToolDef<any> => def as ToolDef<any>;

const THREAD_GUIDANCE = "Reply in the originating room and topic thread: use the event's thread_id when present, otherwise its message_id as thread_id to start a thread. Keep progress and completion replies in that thread; use a new top-level message only for a new topic or when requested. ";
const REACTION_GUIDANCE = "Acknowledge each message you read from the operator or collaborating agents promptly with eyes on that message_id (for a batch, each ID in message_ids). Receipt does not imply authorization or completion. For authorized work, add wrench to the original request when starting and send a concise threaded update. Add white_check_mark to the original request only when all requested work is complete, with a concise threaded completion reply. Remove white_check_mark with add=false if work reopens. A reaction alone is sufficient when no reply is needed; avoid duplicate acknowledgements and agent reply loops. ";

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

export type NotificationChange = (account: string, roomId: string, level: NotifyLevel) => void;

export function buildTools(accountOf: (c: Connection) => AccountHandle, url: string, fallback: NotifyLevel, onNotificationChange?: NotificationChange): Record<string, ToolDef<any>> {
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
      description: "Recent messages in a room (oldest first), or in one thread when thread_id is given. " + REACTION_GUIDANCE,
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
    react_to_message: tool({
      description: "Add or remove your account's emoji reaction to a message. Use the channel event's message_id (not its thread_id) to acknowledge that message. Repeated adds keep the reaction present. " + REACTION_GUIDANCE,
      input: {
        message_id: z.string().min(1).describe("Message to react to"),
        emoji: z.string().min(1).describe("Rocket.Chat emoji name, e.g. eyes or white_check_mark"),
        add: z.boolean().optional().describe("Default true; false removes your reaction"),
      },
      handler: async ({ message_id, emoji, add = true }, c) => {
        await accountOf(c).rc.react(message_id, emoji, add);
        return { message_id, emoji, added: add };
      },
    }),
    send_message: tool({
      description:
        'Post a message to Rocket.Chat. This is the reply tool for <channel source="rocketr"> events: pass the tag\'s room_id as room, ' +
        "and use threaded replies. Markdown is supported. " + THREAD_GUIDANCE + REACTION_GUIDANCE,
      input: {
        room: ROOM,
        text: z.string().min(1).describe("Message text"),
        thread_id: z.string().optional().describe("Topic thread root: event.thread_id, or event.message_id for a new reply thread"),
      },
      handler: async ({ room, text, thread_id }, c) => {
        const { rc } = accountOf(c);
        const r = await resolveRoom(rc, room);
        const m = await rc.send(r._id, text, thread_id);
        return { sent: true, message_id: m._id, room_id: r._id };
      },
    }),
    send_image: tool({
      description: "Upload and post a PNG, JPEG, GIF or WebP image to Rocket.Chat, optionally with a caption or in a thread. Supply base64 file bytes from the caller's machine (not a local path or data URL). Maximum decoded size: 10 MiB. " + THREAD_GUIDANCE,
      input: {
        room: ROOM,
        data_base64: z.string().min(4).max(13981016).describe("Base64-encoded image file bytes"),
        filename: z.string().min(1).max(255).regex(/^[^/\\\x00-\x1f]+$/).describe("Image filename, e.g. screenshot.png"),
        mime_type: z.enum(["image/png", "image/jpeg", "image/gif", "image/webp"]),
        text: z.string().optional().describe("Optional caption"),
        thread_id: z.string().optional().describe("Topic thread root: event.thread_id, or event.message_id for a new reply thread"),
      },
      handler: async ({ room, data_base64, filename, mime_type, text, thread_id }, c) => {
        if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data_base64)) throw new Error("Invalid base64 image data");
        const bytes = Buffer.from(data_base64, "base64");
        if (!bytes.length || bytes.length > 10 * 1024 * 1024) throw new Error("Image must be between 1 byte and 10 MiB");
        const signatures: Record<string, boolean> = {
          "image/png": bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
          "image/jpeg": bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255,
          "image/gif": ["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString()),
          "image/webp": bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP",
        };
        if (!signatures[mime_type]) throw new Error("Image signature does not match mime_type");
        const { rc } = accountOf(c);
        const r = await resolveRoom(rc, room);
        const m = await rc.sendImage(r._id, bytes, filename, mime_type, text, thread_id);
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
        const { rc, self } = accountOf(c);
        const r = await resolveRoom(rc, room);
        await rc.saveNotification(r._id, level);
        onNotificationChange?.(self.username, r._id, level);
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
      const loggedArgs = name === "send_image" ? { ...(args as Record<string, unknown>), data_base64: "[omitted]" } : args;
      try {
        const out = await def.handler(args as never, c);
        activity.toolCall(c.id, name, loggedArgs, true, out, Math.round(performance.now() - t0));
        return out;
      } catch (err) {
        activity.toolCall(c.id, name, loggedArgs, false, (err as Error).message, Math.round(performance.now() - t0));
        throw err;
      }
    },
  } satisfies ToolDef<any>]));
}
