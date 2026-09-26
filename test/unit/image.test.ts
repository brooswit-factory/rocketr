import { expect, test } from "bun:test";
import { RocketChat } from "../../src/rocketchat.js";
import { buildTools, instrument } from "../../src/tools.js";
import { Activity } from "../../src/activity.js";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aC1sAAAAASUVORK5CYII=";

test("image tool uploads multipart bytes then publishes caption and thread with account credentials", async () => {
  const calls: string[] = [];
  const rc = new RocketChat({ url: "https://chat.example", userId: "bot", token: "token", fetch: (async (url: URL, init: RequestInit) => {
    calls.push(url.pathname);
    expect(new Headers(init.headers).get("X-User-Id")).toBe("bot");
    expect(new Headers(init.headers).get("X-Auth-Token")).toBe("token");
    if (url.pathname.endsWith("rooms.info")) return Response.json({ room: { _id: "room", t: "p" } });
    if (url.pathname.endsWith("rooms.media/room")) {
      expect(new Headers(init.headers).has("Content-Type")).toBe(false);
      const file = (init.body as FormData).get("file") as File;
      expect(file.name).toBe("screen.png");
      expect(file.type).toBe("image/png");
      expect(Buffer.from(await file.arrayBuffer()).toString("base64")).toBe(png);
      return Response.json({ file: { _id: "file" }, success: true });
    }
    expect(JSON.parse(init.body as string)).toEqual({ msg: "screen", tmid: "thread" });
    return Response.json({ message: { _id: "sent" }, success: true });
  }) as unknown as typeof fetch });
  const activity = new Activity();
  const tools = instrument(buildTools(() => ({ rc, self: { _id: "bot", username: "bot" } }), "https://chat.example", "all"), activity);
  const args = { room: "room", filename: "screen.png", mime_type: "image/png", data_base64: png, text: "screen", thread_id: "thread" };
  const connection = { id: "test" } as any;
  expect(await tools.send_image!.handler(args, connection)).toEqual({ sent: true, message_id: "sent", room_id: "room" });
  expect(calls).toEqual(["/api/v1/rooms.info", "/api/v1/rooms.media/room", "/api/v1/rooms.mediaConfirm/room/file"]);
  expect(JSON.stringify(activity.snapshot())).not.toContain(png);
  for (const data_base64 of ["bad!", Buffer.from("not an image").toString("base64")]) {
    await expect(tools.send_image!.handler({ ...args, data_base64 }, connection)).rejects.toThrow();
  }
  expect(calls).toHaveLength(3);
});

test("upload errors stop before publication", async () => {
  let calls = 0;
  const rc = new RocketChat({ url: "https://chat.example", userId: "bot", token: "token", fetch: (async () => {
    calls++;
    return Response.json({ success: false, error: "too large" }, { status: 413 });
  }) as unknown as typeof fetch });
  await expect(rc.sendImage("room", Buffer.from(png, "base64"), "screen.png", "image/png")).rejects.toThrow("too large");
  expect(calls).toBe(1);
});
