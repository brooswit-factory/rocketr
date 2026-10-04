import { mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { z, type Connection, type ToolDef } from "@brooswit/thatch";
import { NOTIFY_LEVELS, type Attachment, type Message, type NotifyLevel, type RocketChat, type Room, type User } from "./rocketchat.js";
import { levelOf } from "./watcher.js";
import type { Activity } from "./activity.js";
import { attachmentAllowed, DEFAULT_ATTACHMENT_TYPES } from "./attachment-types.js";

export { attachmentAllowed, DEFAULT_ATTACHMENT_TYPES as ATTACHMENT_TYPES } from "./attachment-types.js";

/**
 * `download_attachment`'s "remote" mode returns base64 bytes in the MCP tool result rather than
 * saving to this machine's disk — the only mode useful to an agent that runs on a different
 * machine from rocketr. Capped well under typical MCP result-size limits even after base64's ~4/3
 * inflation (10 MiB raw → ~13.3 MiB encoded).
 */
export const REMOTE_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;

/** Infers handler args from the zod shape, then erases to the registry's type. */
const tool = <S extends z.ZodRawShape>(def: ToolDef<S>): ToolDef<any> => def as ToolDef<any>;

const THREAD_GUIDANCE = "Reply in the originating room and topic thread: use the event's thread_id when present, otherwise its message_id as thread_id to start a thread. Keep progress and completion replies in that thread; use a new top-level message only for a new topic or when requested. ";
const REACTION_GUIDANCE = "Acknowledge each message you read from the operator or collaborating agents promptly with eyes on that message_id (for a batch, each ID in message_ids). Receipt does not imply authorization or completion. For authorized work, add wrench to the original request when starting and send a concise threaded update. Add white_check_mark to the original request only when all requested work is complete, with a concise threaded completion reply. Remove white_check_mark with add=false if work reopens. A reaction alone is sufficient when no reply is needed; avoid duplicate acknowledgements and agent reply loops. ";

const ROOM = z.string().min(1).describe('Room: an id (e.g. the room_id from a <channel source="rocketr"> tag), "#channel", or "@username" for a DM');
const USERNAME = z.string().min(1).describe("Username, without the @");

export interface AttachmentOptions { dir: string; maxBytes: number; allowedTypes?: string[] }

const attachmentView = (a: Attachment, index: number) => ({
  index, title: a.title ?? null,
  type: a.image_type ?? a.audio_type ?? a.video_type ?? a.type ?? null,
  size: a.image_size ?? a.audio_size ?? a.video_size ?? a.size ?? null,
  downloadable: !!a.title_link,
});

export const view = (m: Message) => ({
  id: m._id,
  ts: m.ts,
  sender: m.u.username,
  text: m.msg,
  ...(m.t ? { system: m.t } : {}),
  ...(m.tmid ? { thread_id: m.tmid } : {}),
  ...(m.tcount ? { replies: m.tcount } : {}),
  ...(m.attachments?.some((a) => a.title_link) ? { attachments: m.attachments.map(attachmentView) } : {}),
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

export function buildTools(accountOf: (c: Connection) => AccountHandle, url: string, fallback: NotifyLevel, onNotificationChange?: NotificationChange, attachments?: AttachmentOptions): Record<string, ToolDef<any>> {
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
    download_attachment: tool({
      description:
        "Fetch a file attached to a Rocket.Chat message. Use the message id from read_messages (its `attachments` list shows what is " +
        "there). Images (png/jpeg/gif/webp), audio, PDF and plain text only, up to a size cap. `mode: \"remote\"` (default) returns the " +
        "file's bytes directly in the result (base64), capped lower than local saves to stay under typical MCP result-size limits — use " +
        "this unless your agent runs on the same machine as rocketr. `mode: \"local\"` saves to rocketr's own disk (one folder per " +
        "account) and returns the absolute path instead — only useful to a same-host agent, since nothing else can read that path.",
      input: {
        message_id: z.string().min(1).describe("The message that carries the attachment"),
        index: z.number().int().min(0).max(49).optional().describe("Which attachment, from the message's attachments list (default 0)"),
        mode: z.enum(["remote", "local"]).optional().describe('"remote" (default): return base64 bytes in the result. "local": save to rocketr\'s own disk and return the path (same-host agents only).'),
      },
      handler: async ({ message_id, index = 0, mode = "remote" }, c) => {
        if (!attachments) throw new Error("Attachment downloads are not configured");
        const { rc, self } = accountOf(c);
        const m = await rc.message(message_id);
        const a = m.attachments?.[index];
        if (!a?.title_link) throw new Error(`Message ${message_id} has no downloadable attachment at index ${index}`);
        const declared = attachmentView(a, index);
        // Remote mode's bytes travel inside the MCP result, so it clamps to a smaller effective cap
        // regardless of the configured ROCKETR_ATTACHMENT_MAX_BYTES — see REMOTE_ATTACHMENT_MAX_BYTES.
        const effectiveMax = mode === "remote" ? Math.min(attachments.maxBytes, REMOTE_ATTACHMENT_MAX_BYTES) : attachments.maxBytes;
        if (declared.size !== null && declared.size > effectiveMax) throw new Error(`Attachment is ${declared.size} bytes; the limit is ${effectiveMax}`);
        const res = await rc.fetchUpload(a.title_link);
        // Content-Type is set by whoever uploaded the file, not sniffed from its bytes — this allowlist is a
        // policy filter on the declared type, not a content-sniffing guarantee about what the bytes actually are.
        const mime = (res.headers.get("content-type") ?? declared.type ?? "").split(";")[0]!.trim().toLowerCase();
        if (!attachmentAllowed(mime, attachments.allowedTypes)) throw new Error(`Attachment type "${mime || "unknown"}" is not allowed`);
        const length = Number(res.headers.get("content-length") ?? 0);
        if (length > effectiveMax) throw new Error(`Attachment is ${length} bytes; the limit is ${effectiveMax}`);
        // The size header is advisory: count what actually arrives and stop at the cap.
        const chunks: Uint8Array[] = [];
        let total = 0;
        const reader = res.body!.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.length;
          if (total > effectiveMax) { await reader.cancel(); throw new Error(`Attachment exceeds the ${effectiveMax}-byte limit`); }
          chunks.push(value);
        }
        // Nit (FACTORY-593 #1): the filename component is the server-returned message id, not the raw tool input.
        if (mode === "remote") {
          return { message_id: m._id, index, mime_type: mime, size: total, data_base64: Buffer.concat(chunks.map((ch) => Buffer.from(ch))).toString("base64") };
        }
        const safe = (a.title ?? "attachment").replace(/[^A-Za-z0-9._-]+/g, "_").replace(/\.{2,}/g, "_").replace(/^\.+/, "").slice(-100) || "attachment";
        const dir = join(attachments.dir, self.username.replace(/[^A-Za-z0-9._-]/g, "_"));
        await mkdir(dir, { recursive: true, mode: 0o700 });
        const path = join(dir, `${m._id}-${index}-${safe}`);
        // Nit (FACTORY-593 #3): a unique tmp name per download, not a shared `.part` two concurrent downloads could collide on.
        const tmp = `${path}.part-${crypto.randomUUID()}`;
        try { await Bun.write(tmp, new Blob(chunks)); await rename(tmp, path); } catch (e) { await rm(tmp, { force: true }); throw e; }
        return { path, mime_type: mime, size: total, message_id: m._id, index };
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
    add_member: tool({
      description:
        "Add a user to a channel or private group. This account must already be a member of a private group to " +
        "add someone else to it (Rocket.Chat's own rule) — it fails with error-not-allowed otherwise.",
      input: { room: ROOM, username: USERNAME },
      handler: async ({ room, username }, c) => {
        const { rc } = accountOf(c);
        const r = await resolveRoom(rc, room);
        const u = await rc.userByUsername(username);
        await rc.addMember(r, u._id);
        return { room_id: r._id, username, added: true };
      },
    }),
    remove_member: tool({
      description: "Remove a user from a channel or private group.",
      input: { room: ROOM, username: USERNAME },
      handler: async ({ room, username }, c) => {
        const { rc } = accountOf(c);
        const r = await resolveRoom(rc, room);
        const u = await rc.userByUsername(username);
        await rc.removeMember(r, u._id);
        return { room_id: r._id, username, removed: true };
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
