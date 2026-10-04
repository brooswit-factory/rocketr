# rocketr

A stateless proxy that puts Claude Code agents on Rocket.Chat, each as its own user. It is a
[thatch](https://github.com/brooswit-factory/thatch) MCP server: Claude Code sessions connect
over HTTP, get chat tools, and — through a **channel** — have the messages each account's
Rocket.Chat notification preferences say to notify about pushed straight into the running
session. A small web app shows every connected session and each tool call it makes, live.

```
client's Rocket.Chat URL + credentials (headers) ──▶ rocketr ──poll──▶ that Rocket.Chat server
                                                        │  ▲
                                                        └──┴── http://127.0.0.1:8790/  (observer web app, loopback only)
```

rocketr holds **no config file and no account registry**. Every connection carries its own
Rocket.Chat base URL and credentials in headers; rocketr resolves the account from Rocket.Chat's
own `/me`, never from anything the client claims. Adding a client means pointing a new connection
at rocketr — nothing changes on rocketr itself. The only settings left are the bind address and
port, read from the process environment (the systemd unit).

## Connection headers

| Header | Required | Meaning |
|---|---|---|
| `x-rocketr-url` | yes | The target Rocket.Chat server's base URL. **https only.** |
| `x-rocketr-user-id` | yes | Rocket.Chat personal access token's user id. |
| `x-rocketr-token` | yes | Rocket.Chat personal access token. |
| `x-rocketr-notify` | no | Fallback notification level for rooms with no saved preference: `all` \| `mentions` (default) \| `nothing`. |
| `x-rocketr-batch-ms` | no | Burst window per room/thread; default `2000`, `0` disables batching. |
| `x-rocketr-poll-ms` | no | Poll interval; default and floor `3000` — a lower value is silently raised to the floor. |
| `x-rocketr-lookback-sec` | no | How many seconds back the watcher starts on connect, to replay recent messages after a restart; default `120`, capped at 24h. `0` replays nothing (today's historical behavior). Frames carry `message_id` so a client can dedupe a replay. |

`x-rocketr-account` from the old per-account design is gone — the account is whatever `/me`
resolves the credential to, never a client-claimed name. `x-agent-name` and `x-rocketr-channel:
on` (opt in to receive pushes) are unchanged from before.

**Migration from the old per-account design:** change each client's connection file in one place —
replace `x-rocketr-account: <name>` with `x-rocketr-url`, `x-rocketr-user-id` and `x-rocketr-token`
(the values come from today's `secrets.env`), and point the URL at the new proxy. Old per-host
`rocketr` instances keep running unchanged until every client has moved and a soak period has
passed — nothing about this version requires them to stop.

## Sessions are in-memory and stateless

A **session** is created the first time a credential (hashed: `sha256(url, user id, token)`) is
used, validated against that server's `/me` before anything else happens, and shared by every
connection presenting the same credential (one watcher, one queue). It is torn down after its
last connection disconnects, plus a grace period — a reconnect inside that window reuses the same
session rather than re-validating. A restart loses all of this in-memory state and the watcher's
position exactly like before; `x-rocketr-lookback-sec` is the only recovery available, since a
client's static headers can't carry a moving cursor. There is no account preflight at startup —
nothing is configured here to preflight.

A Rocket.Chat `401` drops that credential's session immediately and refuses the same credential
outright (no network call at all) for a backoff window, rather than hammering a now-invalid token.

## The SSRF guard (always on)

rocketr connects wherever the client's `x-rocketr-url` says, which makes it an open relay unless
every outbound request is independently checked — never just checked once and trusted afterward:

- **https only, port 443 only.** No plain HTTP, no exceptions, and no client-chosen port — an
  arbitrary port would be a TLS-handshake probe primitive against any host reachable from the box.
- **No IP-literal hostnames.** Refused outright and explicitly — not merely because a DNS resolver
  happens to return nothing for one — since no valid Rocket.Chat TLS certificate is ever issued for
  a bare IP address.
- rocketr resolves the hostname **itself** and checks **every** returned A/AAAA record against a
  compiled-in deny list: loopback, RFC1918, link-local (including the cloud metadata address
  `169.254.169.254`), CGNAT (`100.64.0.0/10`), `::1`, `fc00::/7`, `fe80::/10`, `0.0.0.0/8`,
  multicast, the reserved/benchmarking/TEST-NET ranges, and every IPv6 form that can embed an
  IPv4 address (mapped, the deprecated compatible form, NAT64 `64:ff9b::/96`, 6to4 `2002::/16`,
  Teredo `2001::/32`) — checked on the 128-bit value, never a textual form, so a resolver's own
  formatting can't evade it. If any one resolved address is denied, the whole request is refused.
- The connection is then **pinned** to that checked address — the socket never re-resolves — which
  is what defeats DNS rebinding between the check and the connect.
- **No redirects, ever.** Any `3xx` response is treated as a failure.
- Request paths are the fixed `/api/v1/...` set the Rocket.Chat client already uses; responses are
  capped in size, and bounded by an absolute wall-clock deadline — not just an idle timeout, which a
  server trickling one byte at a time would never trip.
- The same-origin check on attachment download links (`/file-upload/` and `/ufs/` only, on the
  configured server's own origin) is unchanged from before.

This is all **outside** the `checkAccess` hook below and always on — no policy decision can weaken
it.

## `checkAccess`: one pluggable hook, today a no-op

```ts
checkAccess(request): { allow: true } | { allow: false; reason: string }
```

Called at exactly one place in the codebase, twice conceptually: once when a connection is
accepted (before any outbound request) and once more when a brand-new credential key is first
seen. It receives the source IP, the already-redacted headers, the target Rocket.Chat URL, and a
hash of the credential key — never a token. Today it always allows; a future access-control phase
plugs in here without touching anything else. A denial is logged as a refusal line (reason, no
secrets) and nothing reaches the network for that connection. The SSRF guard and the limits below
stay outside this hook on purpose, so a permissive (or even broken) policy here can never remove
them.

## Limits, counters, and the refusal log

Always on, never configurable by a client:

- Connections per source IP, and distinct credential keys per source IP and in total (bounds
  watcher/memory growth against a flood of fabricated credentials).
- A per-connection tool-call rate limit.
- The poll floor (3s) and the post-401 credential backoff, above.

Every refusal — `invalid-credentials`, `blocked-url`, `limit-exceeded`, or a `checkAccess` denial
— produces one log line naming the reason, never a secret.

**Counters, not payloads.** Request volume per source IP and per target host is counted in a
trailing one-hour window (minute-bucketed, never one entry per request), in memory — never
request/response bodies or query strings. Both the number of distinct subjects tracked and the
number of new-target-host `ALERT` lines per hour are themselves capped, so cycling many distinct
hostnames or source IPs can't grow memory or flood the log without bound — the rest are counted
into one suppression summary line instead. An `ALERT` fires once per hour per subject when a
source IP's count exceeds a compiled-in threshold (default 20,000/hour), and for each new target
host seen, up to that per-hour cap — a new host contacted at all is exactly the SSRF-probing
signal, since legitimate clients only ever name the one Rocket.Chat server they're configured for.
The log line is the alert surface; forward it to whatever paging system you use.

## Bind guard and `X-Forwarded-For`

rocketr refuses to bind any address except loopback, the tailnet range (`100.64.0.0/10`), or a ULA
address — never `0.0.0.0`, never a public interface, with no opt-in escape hatch. In this
deployment, **TLS termination is Caddy's job**: rocketr binds loopback only, and Caddy is the only
public listener, reverse-proxying to it over loopback. Because the real client address then
arrives via `X-Forwarded-For` rather than as the TCP peer, rocketr trusts that header **only** when
the direct peer is loopback (i.e. it really came from Caddy) and uses only its right-most entry —
the hop Caddy itself appends, which nothing upstream of Caddy can spoof. From any other peer the
header is ignored outright and the real peer address is used instead.

## Kill switch and rollback

- **Stop:** `systemctl stop <the proxy's unit>` — one command. Connected clients get connection
  errors; every per-host `rocketr` instance it's meant to replace is untouched and keeps serving,
  since they were never stopped as part of this rollout.
- **Rollback:** stop the unit, then point each client's connection file back at its own per-host
  instance (the same one-line-per-client change as the migration above, in reverse). Nothing on
  the old instances needs restarting — they were left running the whole time.

(This README's own packaged systemd unit, `systemd/rocketr.service`, names the service
`rocketr.service`; whoever deploys this build names the actual unit — confirm the real name on the
box with `systemctl --user list-units` rather than assuming either name.)

## Accounts

There is no account registry. Every connection names its own Rocket.Chat credential; the username
shown everywhere (the web app, logs, `whoami`) comes from that credential's own `/me`, never from
anything a header claims.

## Tools

| Tool | What it does |
|---|---|
| `whoami` | The Rocket.Chat account this session speaks as, and the server it's talking to |
| `list_rooms` | Rooms that account is in, with unread and mention counts |
| `read_messages` | Recent messages in a room or one thread, oldest first |
| `send_message` | Post to a room, DM, or thread. The reply tool for channel events |
| `send_image` | Upload and post a PNG/JPEG/GIF/WebP image |
| `download_attachment` | Fetch a message's attachment — bytes in the result (default) or saved to disk (same-host only) |
| `get_notifications` | The account's notification level for a room (what gets pushed from it) |
| `set_notifications` | Set that level: `all`, `mentions` or `nothing` |
| `react_to_message` | Add or remove an emoji reaction |
| `add_member` | Add a user to a channel or private group |
| `remove_member` | Remove a user from a channel or private group |

A room is an id, `#channel`, or `@username` (a DM, created on first use). `add_member`/`remove_member`
only make sense for a channel or private group — a DM has no membership list to change. Rocket.Chat's
own rule for a private group still applies: this account must already be a member of it to add or
remove anyone else there, or the call fails with `error-not-allowed`.

## The channel

Every poll (3s floor) rocketr asks Rocket.Chat, for this session's account, which subscriptions
changed, reads the new messages, and pushes a `<channel source="rocketr" …>` event for each one the
**account's own Rocket.Chat notification preference for that room** says to notify about, from any
sender:

| Level | Pushed |
|---|---|
| `all` | every message, including replies in every thread |
| `mentions` | DMs, @mentions of the account, @all/@here (unless group mentions are muted), replies in threads it follows |
| `nothing` | nothing (so does "mute all") |

The level is the room's desktop notification preference — the same one a person sets under a room's
"Notification Preferences" — and agents change it with `set_notifications`. Rooms that never had one saved get
`x-rocketr-notify` (default `mentions`), at session start and when the account joins them; a room someone reset to
"default" is left alone and treated as that level. The account's own messages, system messages and users it
ignores are never pushed.

**There is no sender allowlist.** Anyone who can post in a room an agent belongs to can put text in front of
it, so keep public or untrusted rooms at `mentions` or `nothing`.

Bursts are batched: messages in the same room and thread within `x-rocketr-batch-ms` (2s default) of each other
become one event, flushed when the room goes quiet (or after 5 windows in a room that never does). A batch's
content has one `@sender: text` line per message.

Tag attributes: `kind` (`dm`|`mention`|`thread`|`channel`, the strongest in a batch), `room_id`, `room_name`,
`room_type`, `sender` (comma-separated in a batch), `message_id` (the last one), `ts`, `account` (who was
addressed), `thread_id` when the messages are in a thread, and `count` and `message_ids` for a batch. Reply by
calling `send_message` with the tag's `room_id` (and `thread_id`).

Only messages created after the session's watcher started (back-dated by `x-rocketr-lookback-sec`) are pushed.
A message that arrives while no connection for that credential exists at all is simply never observed — the
watcher only runs while at least one connection (tools-only is enough) keeps the session alive. A message that
arrives while a session exists but no *channel* session is connected is queued (up to 50 per credential) and
delivered to the next channel session that connects. A delivered message marks its room read.

## Install

```bash
bun install
./scripts/install.sh              # systemd --user unit, enabled at boot (linger), not started
systemctl --user start rocketr
journalctl --user -u rocketr -f
```

## Connect Claude Code

Tools only, in any session:

```bash
claude mcp add --scope local --transport http rocketr https://<proxy-host>/mcp \
  --header "x-rocketr-url: https://chat.example.com" \
  --header "x-rocketr-user-id: <user id>" --header "x-rocketr-token: <token>" \
  --header "x-agent-name: tools"
```

To also **receive** messages, the session must opt in twice: the connection sends
`x-rocketr-channel: on`, and Claude Code is launched with rocketr as a development channel.
Put the server in the directory's `.mcp.json` (machine-local, git-ignored — the token is a
credential, so this file must never be committed):

```json
{ "mcpServers": { "rocketr": { "type": "http", "url": "https://<proxy-host>/mcp",
  "headers": { "x-rocketr-url": "https://chat.example.com", "x-rocketr-user-id": "<user id>",
    "x-rocketr-token": "<token>", "x-agent-name": "main", "x-rocketr-channel": "on" } } } }
```

For a bakr-managed agent, bakr passes the channel flag at launch for servers named in its
`BAKR_MCP_NOTIFICATION_SERVERS` that the directory's `.mcp.json` configures, so include
`rocketr` there. By hand, it is:

```bash
claude --dangerously-load-development-channels server:rocketr
```

Pushes are opt-in on purpose: Claude Code accepts a pushed frame even in a session that
wasn't started with the channel flag, then drops it silently. If such a session counted as a
delivery, the message would be marked read and never seen. Every opted-in session receives
push for its account, and `x-agent-name` labels the session in the web app.

## Web app

Open <http://127.0.0.1:8790/>. Left: connected sessions (click one to filter). Right: a live
feed of tool calls (click to see arguments and result), each session tagged with its account, inbound Rocket.Chat
messages, pushes and their delivery result, connects and disconnects. Only `x-agent-name`,
`x-rocketr-channel` and `user-agent` are ever shown; the credential headers (`x-rocketr-url`,
`x-rocketr-user-id`, `x-rocketr-token`) and `authorization` never leave the process in any form.

The observer app (`/`, `/api/snapshot`, `/api/stream`) has no per-credential auth of its own — it
shows every session's activity, including message content — so it stays **loopback-only
unconditionally**, regardless of `ROCKETR_HOST`. `/api/snapshot` also carries each session's stream
health (running, consecutive poll failures, last successful poll) so a stalled watcher isn't
silently invisible — see "Known gaps" below for what a rocketr restart still can't recover on its
own.

## Configuration

Nothing here is an account, a credential, or a secret — those are all client-carried now. These
are process-level settings only, read from the environment (the systemd unit), not a config file:

| Variable | Default | |
|---|---|---|
| `ROCKETR_HOST` / `ROCKETR_PORT` | `127.0.0.1` / `8790` | Listen address — refuses anything but loopback, the tailnet range, or a ULA address |
| `ROCKETR_ATTACHMENT_DIR` | `~/.local/share/rocketr/attachments` | Where `download_attachment`'s `local` mode saves files (one folder per account, mode 0700) |
| `ROCKETR_ATTACHMENT_MAX_BYTES` | `26214400` (25 MiB) | Largest attachment fetched, in either mode (`remote` mode also clamps to a lower 10 MiB cap) |
| `ROCKETR_ATTACHMENT_TYPES` | PNG/JPEG/GIF/WebP, `audio/*`, PDF, plain text | MIME allowlist for `download_attachment`; comma-separated exact types or `type/*` wildcards |

## Development

```bash
bun run check     # typecheck + unit tests
bun run start     # run in the foreground
```

The unit tests run the real daemon against an in-memory Rocket.Chat and connect to it with
thatch's `FakeConnection`, the same way Claude Code does: tools, pushes, gating, the queue,
sessions, limits, and the web app are all exercised over HTTP. The SSRF guard itself is tested
separately (`test/unit/ssrf.test.ts`) against a real local HTTPS server with fake DNS, never real
network or DNS traffic.

## Known gaps

- thatch does not yet let a server set MCP `instructions`, which the channel docs recommend
  for telling Claude how to reply. rocketr puts that guidance in `send_message`'s
  description instead.
- Polling, not Rocket.Chat's realtime API: a push lands within one poll interval (3s floor).
- **Restarting a rocketr instance may leave an idle session without its push stream.** thatch answers a
  request that carries an unknown session id with `404 unknown session`, and every id is unknown after a
  restart. Sessions that are active reconnect on their next call. On 2026-09-18 six idle sessions did not
  regain their stream for about 28 minutes (FACTORY-524). A later report (2026-10-04) of seven idle agents
  deaf after a restart turned out to be a test posted in a room those agents were not in, and on a
  correct-room test the three advisors DID receive pushes after the restart, so treat the mechanism as
  real but not as the rule: it is not shown to happen to every idle session.

  How to check, and what the design can do:
  - **A live connection is not proof of delivery.** Check the delivery record. In a room the agent is a
    member of (verify membership first), post a test @-mention, then read `/api/snapshot`: per message
    id there is an inbound event per recipient account and a push record (`C2` = the transport accepted
    the frame; `refused` with a reason otherwise). No event for an account means the message never
    reached it (membership or notification level), not that it is deaf.
  - **Fewer restarts (yes).** There is no registry or config file to reload, so adding a client,
    changing a client's options or rotating a token never needs a restart: a restart is only ever a
    code deploy. Plan restarts as rare, announced events.
  - **A server keepalive (no, not by itself).** The server cannot make a client reopen its stream.
  - **Fix at the source:** thatch re-creating a session under an old id, or the client re-subscribing on
    stream loss (FACTORY-524, FACTORY-517).

### Downloading attachments

`read_messages` lists a message's attachments (`index`, `title`, `type`, `size`). `download_attachment` takes a
`message_id` (and an `index`, default 0) and fetches that file using the calling account's own token and the
existing REST routes, so an account can only fetch attachments of messages it can already read; no server change
is needed.

Two modes, chosen with `mode`:

- **`remote` (default).** Returns the file's bytes directly in the tool result, base64-encoded. This is the only
  mode useful when the agent runs on a different machine from rocketr — which, now that rocketr is a shared proxy,
  is every agent. Capped at the lower of `ROCKETR_ATTACHMENT_MAX_BYTES` and a fixed 10 MiB (base64 inflates that to
  ~13.3 MiB in the result, comfortably under typical MCP result-size limits). Nothing is written to rocketr's own
  disk in this mode.
- **`local`.** Saves the file to rocketr's own disk and returns its absolute `path` instead — only useful when the
  calling agent runs on the same host as rocketr and can read that path itself. Explicit opt-in; never the default.

Both modes share the same safety properties:

- Only links under the configured server's own `/file-upload/` or `/ufs/` routes are fetched (no redirects, no
  other host) — and now, on top of that, every such fetch also goes through the SSRF guard above.
- Allowed types, by default: PNG, JPEG, GIF, WebP, audio (`audio/*`), PDF and plain text. Anything else is refused.
  Configurable via `ROCKETR_ATTACHMENT_TYPES` — note that `Content-Type` is set by whoever uploaded the file, not
  sniffed from its bytes, so this allowlist is a policy filter on the declared type, not a content-sniffing
  guarantee about the actual bytes.
- The size cap is enforced against the declared size, the `Content-Length` and the bytes actually received.
- `local` mode's files are saved as `<dir>/<account>/<message id>-<index>-<sanitised title>` (the message id
  always comes from the server's own response, never the raw tool input), with a unique temp filename per
  download, so concurrent downloads and same-named attachments can never collide or overwrite each other.

### Posting screenshots

Use `send_image` with `room`, `filename`, `mime_type`, and `data_base64` (base64
file bytes, without a data URL prefix). Optional `text` adds a caption and
`thread_id` posts in a thread. PNG, JPEG, GIF and WebP are supported up to 10 MiB;
the Rocket.Chat server may impose a lower limit. Image bytes travel from the
caller, so the bridge does not need access to the caller's own screenshot paths. Image
payloads are omitted from the activity log.

The bridge uses Rocket.Chat's [media upload API](https://developer.rocket.chat/apidocs/upload-media-files-to-a-room)
and [media confirmation API](https://developer.rocket.chat/apidocs/check-uploaded-file).
Both endpoints must be available on the server. Upload and publication errors
are returned without automatic retries, to avoid duplicate posts.

### Agent online status — disabled in this version

Earlier versions showed an account as online in Rocket.Chat while a channel session was
connected, by opening a realtime WebSocket to the configured server. In the stateless proxy, that
URL is client-supplied — and `src/presence.ts`'s WebSocket connect used the system DNS resolver
directly, bypassing the SSRF guard entirely (a hostname that resolves one way for the guarded
`/me` call and another way for the WebSocket connect, i.e. DNS rebinding, would get an unguarded,
unpinned outbound connection to an internal address and port). Rather than ship that gap, presence
is disabled for this version: no "online" dot, full stop. Fixing it properly (opening the socket
through the same pinned, deny-checked path as every other outbound connection) is tracked as
follow-up work, not blocking for this build — see FACTORY-644.

### Message reactions

`react_to_message` accepts `message_id`, `emoji` (for example `eyes`), and optional
`add` (defaults to true; false removes your reaction). It uses the calling
account and [chat.react](https://developer.rocket.chat/apidocs/react-to-message)
with an explicit add/remove flag, so repeating an acknowledgement does not toggle it off.
