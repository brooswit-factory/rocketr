import type { Connection, Delivery, Frame } from "@brooswit/thatch";

/** Headers safe to show in the web app. Everything else (authorization, cookie, ...) stays in thatch. */
const SHOWN_HEADERS = ["x-agent-name", "user-agent"] as const;

export interface AgentView {
  id: string;
  name: string;
  headers: Record<string, string>;
  connectedAt: number;
  calls: number;
}

export type ActivityEvent = { seq: number; at: number } & (
  | { type: "connect"; agent: AgentView }
  | { type: "disconnect"; agentId: string; reason: string }
  | { type: "tool"; agentId: string; tool: string; args: unknown; ok: boolean; result: string; ms: number }
  | { type: "inbound"; frame: Frame }
  | { type: "push"; agentId: string; messageId: string; delivery: Delivery }
  | { type: "log"; message: string }
);

type Body<T> = T extends unknown ? Omit<T, "seq" | "at"> : never;

const RESULT_MAX = 4_000;
export const agentName = (c: Connection) => c.headers["x-agent-name"] || c.id.slice(0, 8);

/** In-memory ring of recent activity plus live subscribers (the web app's SSE streams). */
export class Activity {
  private readonly events: ActivityEvent[] = [];
  private readonly agents = new Map<string, AgentView>();
  private readonly subs = new Set<(e: ActivityEvent) => void>();
  private seq = 0;

  constructor(private readonly max = 500, private readonly now = () => Date.now()) {}

  record(body: Body<ActivityEvent>): ActivityEvent {
    const e = { ...body, seq: ++this.seq, at: this.now() } as ActivityEvent;
    if (e.type === "connect") this.agents.set(e.agent.id, e.agent);
    if (e.type === "disconnect") this.agents.delete(e.agentId);
    if (e.type === "tool") { const a = this.agents.get(e.agentId); if (a) a.calls++; }
    this.events.push(e);
    if (this.events.length > this.max) this.events.shift();
    for (const fn of this.subs) fn(e);
    return e;
  }

  connected(c: Connection) {
    const headers: Record<string, string> = {};
    for (const h of SHOWN_HEADERS) if (c.headers[h]) headers[h] = c.headers[h];
    return this.record({ type: "connect", agent: { id: c.id, name: agentName(c), headers, connectedAt: c.connectedAt, calls: 0 } });
  }

  toolCall(agentId: string, tool: string, args: unknown, ok: boolean, result: unknown, ms: number) {
    const text = typeof result === "string" ? result : JSON.stringify(result) ?? "";
    return this.record({ type: "tool", agentId, tool, args, ok, result: text.length > RESULT_MAX ? `${text.slice(0, RESULT_MAX)}…` : text, ms });
  }

  snapshot() { return { agents: [...this.agents.values()], events: [...this.events] }; }

  subscribe(fn: (e: ActivityEvent) => void) {
    this.subs.add(fn);
    return () => { this.subs.delete(fn); };
  }
}
