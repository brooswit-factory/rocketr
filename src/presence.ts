/** A real Rocket.Chat presence connection, held only while an agent listens.
 * Socket loss lets the server expire presence even if the bridge is killed.
 * Never logout: that would revoke the account's shared REST token.
 */
export class Presence {
  private wanted = false;
  private socket: WebSocket | undefined;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private pulse: ReturnType<typeof setInterval> | undefined;
  private deadline: ReturnType<typeof setTimeout> | undefined;
  private backoff = 1000;

  constructor(private readonly o: {
    url: string; userId: string; token: string; log: (message: string) => void;
    socket?: (url: string) => WebSocket;
    heartbeatMs?: number; timeoutMs?: number; retryMs?: number;
  }) {}

  setListening(listening: boolean) {
    if (this.wanted === listening) return;
    this.wanted = listening;
    if (listening) this.connect();
    else this.stopSocket();
  }

  stop() { this.wanted = false; this.stopSocket(); }

  private stopSocket() {
    clearTimeout(this.retry); this.retry = undefined;
    clearTimeout(this.deadline); this.deadline = undefined;
    clearInterval(this.pulse); this.pulse = undefined;
    const socket = this.socket;
    this.socket = undefined;
    socket?.close();
  }

  private connect() {
    if (!this.wanted || this.socket) return;
    const url = new URL(this.o.url.replace(/\/$/, '') + '/websocket');
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    let socket: WebSocket;
    try { socket = (this.o.socket ?? ((u) => new WebSocket(u)))(url.href); }
    catch { this.scheduleRetry(); return; }
    this.socket = socket;
    let authenticated = false;
    let lastSeen = Date.now();
    const current = () => this.socket === socket && this.wanted;
    const send = (data: unknown) => { if (current() && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(data)); };
    const failed = () => {
      if (!current()) return;
      this.stopSocket();
      this.scheduleRetry();
    };
    this.deadline = setTimeout(failed, this.o.timeoutMs ?? 15000);
    socket.onopen = () => send({ msg: 'connect', version: '1', support: ['1'] });
    socket.onmessage = (event) => {
      if (!current()) return;
      let data: any;
      try { data = JSON.parse(String(event.data)); } catch { return; }
      lastSeen = Date.now();
      if (data.msg === 'ping') send({ msg: 'pong', ...(data.id ? { id: data.id } : {}) });
      if (data.msg === 'connected') send({ msg: 'method', method: 'login', id: 'login', params: [{ resume: this.o.token }] });
      if (data.msg === 'failed' || data.msg === 'error' || (data.msg === 'result' && data.error)) {
        this.o.log('presence handshake or update rejected; retrying'); failed(); return;
      }
      if (data.msg === 'result' && data.id === 'login') {
        if (data.result?.id !== this.o.userId) { this.o.log('presence identity mismatch'); failed(); return; }
        authenticated = true;
        clearTimeout(this.deadline); this.deadline = undefined;
        this.backoff = 1000;
        send({ msg: 'method', method: 'UserPresence:online', id: 'online', params: [] });
        this.pulse = setInterval(() => {
          if (!current() || !authenticated) return;
          if (Date.now() - lastSeen > (this.o.timeoutMs ?? 90000)) { failed(); return; }
          send({ msg: 'ping', id: 'presence' });
          send({ msg: 'method', method: 'UserPresence:online', id: 'online', params: [] });
        }, this.o.heartbeatMs ?? 30000);
      }
    };
    socket.onclose = failed;
    socket.onerror = failed;
  }

  private scheduleRetry() {
    if (!this.wanted || this.retry) return;
    const delay = this.o.retryMs ?? this.backoff;
    this.backoff = Math.min(this.backoff * 2, 30000);
    this.retry = setTimeout(() => { this.retry = undefined; this.connect(); }, delay);
  }
}
