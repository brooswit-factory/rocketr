/** The observer page: connected agents and a live feed of their tool calls and channel pushes. No build step. */
export const page = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>rocketr</title>
<style>
  :root { --bg:#f7f7f5; --panel:#fff; --ink:#1d1d1f; --muted:#6b6b70; --line:#e4e4e0; --accent:#e0245e;
          --tool:#2563eb; --push:#16a34a; --inbound:#c026d3; --conn:#0891b2; --warn:#d97706; --err:#dc2626; }
  @media (prefers-color-scheme: dark) { :root { --bg:#111113; --panel:#1b1b1e; --ink:#ececef; --muted:#9a9aa2; --line:#2c2c31;
          --tool:#60a5fa; --push:#4ade80; --inbound:#e879f9; --conn:#22d3ee; --warn:#fbbf24; --err:#f87171; } }
  * { box-sizing:border-box } body { margin:0; background:var(--bg); color:var(--ink); font:14px/1.45 ui-sans-serif,system-ui,sans-serif }
  header { display:flex; gap:12px; align-items:baseline; flex-wrap:wrap; padding:14px 20px; border-bottom:1px solid var(--line); background:var(--panel) }
  header h1 { margin:0; font-size:18px; letter-spacing:-.01em } header h1 b { color:var(--accent) }
  .meta { color:var(--muted) } .warn { color:var(--warn); font-weight:600 } .dot { display:inline-block; width:8px; height:8px; border-radius:50%; background:var(--err); margin-right:6px }
  .dot.live { background:var(--push) }
  main { display:grid; grid-template-columns: 260px 1fr; min-height:calc(100vh - 54px) }
  @media (max-width: 760px) { main { grid-template-columns: 1fr } aside { border-right:0; border-bottom:1px solid var(--line) } }
  aside { border-right:1px solid var(--line); padding:14px }
  h2 { font-size:12px; text-transform:uppercase; letter-spacing:.06em; color:var(--muted); margin:0 0 10px }
  .agent { display:block; width:100%; text-align:left; background:var(--panel); color:inherit; border:1px solid var(--line); border-radius:8px; padding:9px 11px; margin-bottom:8px; cursor:pointer; font:inherit }
  .agent.sel { border-color:var(--accent); box-shadow:0 0 0 1px var(--accent) } .agent .n { font-weight:600 } .agent .s { color:var(--muted); font-size:12px }
  .empty { color:var(--muted); font-size:13px }
  section { padding:14px 20px; min-width:0 }
  .bar { display:flex; gap:10px; align-items:center; margin-bottom:10px; flex-wrap:wrap }
  .bar label { color:var(--muted); font-size:13px }
  .ev { background:var(--panel); border:1px solid var(--line); border-radius:8px; margin-bottom:6px; overflow:hidden }
  .ev > .row { display:grid; grid-template-columns: 72px 84px minmax(0,130px) 1fr auto; gap:10px; padding:7px 11px; align-items:baseline; cursor:pointer }
  @media (max-width: 760px) { .ev > .row { grid-template-columns: 64px 76px 1fr; } .ev .who, .ev .ms { display:none } }
  .t { color:var(--muted); font:12px ui-monospace,monospace } .who { font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap }
  .sum { overflow:hidden; text-overflow:ellipsis; white-space:nowrap } .ms { color:var(--muted); font-size:12px }
  .badge { font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:.04em }
  .tool { color:var(--tool) } .push { color:var(--push) } .inbound { color:var(--inbound) } .connect,.disconnect { color:var(--conn) } .log { color:var(--warn) } .fail { color:var(--err) }
  pre { margin:0; padding:10px 12px; border-top:1px solid var(--line); background:var(--bg); font:12px/1.5 ui-monospace,monospace; white-space:pre-wrap; word-break:break-word; max-height:360px; overflow:auto }
</style>
</head>
<body>
<header>
  <h1><b>rocket</b>r</h1>
  <span class="meta" id="who">connecting…</span>
  <span class="warn" id="excluded"></span>
  <span class="meta" style="margin-left:auto"><span class="dot" id="dot"></span><span id="state">offline</span> · <span id="pending">0</span> queued</span>
</header>
<main>
  <aside>
    <h2>Connected agents</h2>
    <div id="agents"><p class="empty">No agents connected.</p></div>
  </aside>
  <section>
    <div class="bar">
      <h2 style="margin:0">Activity</h2>
      <label><input type="checkbox" id="onlyTools"> tool calls only</label>
      <span class="meta" id="filterNote"></span>
    </div>
    <div id="feed"></div>
  </section>
</main>
<script>
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
const time = (ms) => new Date(ms).toLocaleTimeString([], { hour12:false });
let agents = new Map(), names = new Map(), events = [], selected = null, open = new Set();

function nameOf(id) { return names.get(id) || (id ? id.slice(0, 8) : "—"); }
function pretty(v) { if (typeof v !== "string") return JSON.stringify(v, null, 2); try { return JSON.stringify(JSON.parse(v), null, 2); } catch { return v; } }

function describe(e) {
  switch (e.type) {
    case "tool": return { who: nameOf(e.agentId), badge: e.ok ? "tool" : "tool ✕", cls: e.ok ? "tool" : "fail",
      sum: e.tool + " " + JSON.stringify(e.args), ms: e.ms + " ms", detail: "args\\n" + pretty(e.args) + "\\n\\n" + (e.ok ? "result" : "error") + "\\n" + pretty(e.result) };
    case "push": return { who: nameOf(e.agentId), badge: "push", cls: e.delivery.claim === "C2" ? "push" : "fail",
      sum: "message " + e.messageId + " → " + (e.delivery.claim === "C2" ? "delivered to stream" : "refused: " + e.delivery.reason), detail: pretty(e.delivery) };
    case "inbound": return { who: "@" + (e.frame.meta.sender || "?"), badge: e.frame.meta.kind || "in", cls: "inbound",
      sum: (e.frame.meta.room_name ? e.frame.meta.room_name + ": " : "") + e.frame.content, detail: pretty(e.frame) };
    case "connect": return { who: e.agent.name, badge: "connect", cls: "connect", sum: "connected " + JSON.stringify(e.agent.headers), detail: pretty(e.agent) };
    case "disconnect": return { who: nameOf(e.agentId), badge: "left", cls: "disconnect", sum: "disconnected (" + e.reason + ")" };
    default: return { who: "rocketr", badge: "log", cls: "log", sum: e.message };
  }
}

function concerns(e) {
  if (!selected) return true;
  return e.agentId === selected || (e.type === "connect" && e.agent.id === selected);
}

function renderFeed() {
  const onlyTools = $("onlyTools").checked;
  const shown = events.filter((e) => concerns(e) && (!onlyTools || e.type === "tool")).slice(-300).reverse();
  $("filterNote").textContent = selected ? "showing " + nameOf(selected) + " — click it again to clear" : "";
  $("feed").innerHTML = shown.length ? shown.map((e) => {
    const d = describe(e);
    return '<div class="ev" data-seq="' + e.seq + '"><div class="row"><span class="t">' + time(e.at) + '</span><span class="badge ' + d.cls + '">' + esc(d.badge) +
      '</span><span class="who">' + esc(d.who) + '</span><span class="sum">' + esc(d.sum) + '</span><span class="ms">' + esc(d.ms || "") + '</span></div>' +
      (open.has(e.seq) && d.detail ? "<pre>" + esc(d.detail) + "</pre>" : "") + "</div>";
  }).join("") : '<p class="empty">Nothing yet. Tool calls and Rocket.Chat pushes show up here live.</p>';
}

function renderAgents() {
  const list = [...agents.values()].sort((a, b) => a.connectedAt - b.connectedAt);
  $("agents").innerHTML = list.length ? list.map((a) =>
    '<button class="agent' + (a.id === selected ? " sel" : "") + '" data-id="' + esc(a.id) + '"><div class="n">' + esc(a.name) + '</div><div class="s">' +
    esc("@" + (a.username || "?")) + " · " + esc(a.id.slice(0, 8)) + " · since " + time(a.connectedAt) + " · " + a.calls + " call" + (a.calls === 1 ? "" : "s") + "</div></button>").join("")
    : '<p class="empty">No agents connected.</p>';
}

function apply(e) {
  events.push(e); if (events.length > 1000) events.shift();
  if (e.type === "connect") { agents.set(e.agent.id, e.agent); names.set(e.agent.id, e.agent.name); }
  if (e.type === "disconnect") { agents.delete(e.agentId); if (selected === e.agentId) selected = null; }
  if (e.type === "tool" && agents.has(e.agentId)) agents.get(e.agentId).calls++;
}

async function load() {
  const s = await (await fetch("api/snapshot")).json();
  $("who").textContent = s.sessions.length + " active session(s) · v" + s.version;
  const unhealthy = (s.sessions || []).filter((x) => x.health && !x.health.running);
  $("excluded").textContent = unhealthy.length
    ? "⚠ " + unhealthy.length + " session(s) with a stopped watcher: " + unhealthy.map((x) => "@" + x.username).join(", ")
    : "";
  $("pending").textContent = s.pending;
  agents = new Map(s.agents.map((a) => [a.id, a])); events = s.events;
  for (const e of events) { if (e.type === "connect") names.set(e.agent.id, e.agent.name); }
  for (const a of s.agents) names.set(a.id, a.name);
  renderAgents(); renderFeed();
}

function connect() {
  const es = new EventSource("api/stream");
  es.onopen = () => { $("dot").classList.add("live"); $("state").textContent = "live"; load(); };
  es.onerror = () => { $("dot").classList.remove("live"); $("state").textContent = "reconnecting"; };
  es.onmessage = (m) => { apply(JSON.parse(m.data)); renderAgents(); renderFeed();
    fetch("api/snapshot").then((r) => r.json()).then((s) => { $("pending").textContent = s.pending; }).catch(() => {}); };
}

$("agents").addEventListener("click", (ev) => { const b = ev.target.closest(".agent"); if (!b) return;
  selected = selected === b.dataset.id ? null : b.dataset.id; renderAgents(); renderFeed(); });
$("feed").addEventListener("click", (ev) => { const r = ev.target.closest(".ev"); if (!r) return;
  const s = Number(r.dataset.seq); open.has(s) ? open.delete(s) : open.add(s); renderFeed(); });
$("onlyTools").addEventListener("change", renderFeed);
connect();
</script>
</body>
</html>`;
