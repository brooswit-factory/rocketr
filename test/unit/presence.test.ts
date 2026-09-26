import { afterEach, expect, test } from "bun:test";
import { Presence } from "../../src/presence.js";
class Socket {
  readyState = WebSocket.OPEN;
  onopen?: () => void;
  onmessage?: (event: { data: string }) => void;
  onclose?: () => void;
  onerror?: () => void;
  sent: any[] = [];
  closed = false;
  send(data: string) { this.sent.push(JSON.parse(data)); }
  close() { this.closed = true; this.onclose?.(); }
  receive(data: unknown) { this.onmessage?.({ data: JSON.stringify(data) }); }
}
const active: Presence[] = [];
afterEach(() => { active.splice(0).forEach(p => p.stop()); });
function setup(extra: { heartbeatMs?: number; timeoutMs?: number } = {}) {
  const sockets: Socket[] = [];
  const logs: string[] = [];
  const p = new Presence({ url: "https://chat.example/sub", userId: "bot", token: "secret", log: s => logs.push(s), retryMs: 5, ...extra,
    socket: url => { expect(url).toBe("wss://chat.example/sub/websocket"); const s = new Socket(); sockets.push(s); return s as unknown as WebSocket; },
  });
  active.push(p);
  return { p, sockets, logs };
}
function login(s: Socket) {
  s.onopen?.(); s.receive({ msg: "connected" }); s.receive({ msg: "result", id: "login", result: { id: "bot" } });
}
test("authenticates, answers pings, and closes without revoking the shared token", () => {
  const { p, sockets } = setup();
  expect(sockets).toHaveLength(0);
  p.setListening(true); p.setListening(true);
  expect(sockets).toHaveLength(1);
  const s = sockets[0]!; login(s);
  expect(s.sent[1]).toMatchObject({ method: "login", params: [{ resume: "secret" }] });
  expect(s.sent[2].method).toBe("UserPresence:online");
  s.receive({ msg: "ping", id: "server" });
  expect(s.sent.at(-1)).toEqual({ msg: "pong", id: "server" });
  p.setListening(false);
  expect(s.closed).toBe(true);
  expect(s.sent.some(m => m.method === "logout")).toBe(false);
});
test("reconnects while listening, but cancels retries and ignores old socket events on stop", async () => {
  const { p, sockets } = setup();
  p.setListening(true); const first = sockets[0]!; login(first); first.close();
  await Bun.sleep(15); expect(sockets).toHaveLength(2);
  first.receive({ msg: "connected" }); expect(first.sent).toHaveLength(3);
  p.stop(); await Bun.sleep(15); expect(sockets).toHaveLength(2); expect(sockets[1]!.closed).toBe(true);
});
test("identity mismatch and authentication failure never mark the user online or log tokens", () => {
  const { p, sockets, logs } = setup(); p.setListening(true);
  const s = sockets[0]!; s.receive({ msg: "result", id: "login", result: { id: "wrong" } });
  expect(s.closed).toBe(true); expect(s.sent).toHaveLength(0);
  expect(logs.join()).not.toContain("secret");
});
test("a silent or stalled connection is closed and retried", async () => {
  const { p, sockets } = setup({ heartbeatMs: 5, timeoutMs: 15 }); p.setListening(true);
  await Bun.sleep(30); expect(sockets[0]!.closed).toBe(true); expect(sockets.length).toBeGreaterThan(1);
  login(sockets.at(-1)!); await Bun.sleep(30); expect(sockets[1]!.closed).toBe(true);
});
