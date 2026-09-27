# rocketr

A daemon that puts Claude Code agents on Rocket.Chat, each as its own user. It is a [thatch](https://github.com/brooswit-factory/thatch)
MCP server: Claude Code sessions connect to it over HTTP, get chat tools, and — through a
**channel** — have the messages each account's Rocket.Chat notification preferences say to notify about pushed
straight into the running session, so Claude can answer people (and other agents) as they write. A small web app shows every connected agent and
each tool call it makes, live.

```
Rocket.Chat ──poll──▶ rocketr ──channel push──▶ Claude Code session(s)
     ▲                  │  ▲
     └──send_message────┘  └── http://127.0.0.1:8790/  (observer web app)
```

## Accounts

rocketr signs in as several Rocket.Chat users at once, one per agent. Every MCP connection names
its account with the `x-rocketr-account` header (the Rocket.Chat username). **There is no default**:
a client that names no account, or one rocketr doesn't know, is refused at connect (401). Tools act
as that account, and only messages addressed to it are pushed to its sessions.

Accounts are listed in `ROCKETR_ACCOUNTS`; each has `ROCKETR_ACCOUNT_<NAME>_USER_ID` and `_TOKEN`
(name upper-cased, non-alphanumerics → `_`, so `rocketr-lead` → `ROCKETR_ACCOUNT_ROCKETR_LEAD_`).

At startup, every configured account is checked (a token whose username doesn't match its configured
name, or that gets a 401, would let `x-rocketr-account` name it with a lie). A drifted account is
**excluded**, not fatal to the others: it's never served — a connection naming it is refused exactly
like an unknown account — but every other, healthy account still comes up and the daemon still
listens. All configured accounts are checked before anything is reported, so the one startup error
names every failed account, not just the first: enough to tell "several accounts drifted the same
way, config is behind a server-side rename" apart from "one account is broken". Excluded accounts
also show in `/api/snapshot` (`excludedAccounts`) and the observer page, so a partial outage is never
silently invisible. If **every** configured account fails — zero would be served — rocketr exits
non-zero instead of running as a daemon that serves nobody while otherwise looking healthy; systemd
backs off restarts progressively in that case (`systemd/rocketr.service`) rather than a flat 5s, since
that's a config problem for a human to fix, not a transient blip.

## Tools

| Tool | What it does |
|---|---|
| `whoami` | The Rocket.Chat account this session speaks as |
| `list_rooms` | Rooms that account is in, with unread and mention counts |
| `read_messages` | Recent messages in a room or one thread, oldest first |
| `send_message` | Post to a room, DM, or thread. The reply tool for channel events |
| `get_notifications` | The account's notification level for a room (what gets pushed from it) |
| `set_notifications` | Set that level: `all`, `mentions` or `nothing` |
| `add_member` | Add a user to a channel or private group |
| `remove_member` | Remove a user from a channel or private group |

A room is an id, `#channel`, or `@username` (a DM, created on first use). `add_member`/`remove_member`
only make sense for a channel or private group — a DM has no membership list to change. Rocket.Chat's
own rule for a private group still applies: this account must already be a member of it to add or
remove anyone else there, or the call fails with `error-not-allowed`.

## The channel

Every poll (3s by default) rocketr asks Rocket.Chat, for each account, which subscriptions changed, reads the new
messages, and pushes a `<channel source="rocketr" …>` event for each one the **account's own Rocket.Chat
notification preference for that room** says to notify about, from any sender:

| Level | Pushed |
|---|---|
| `all` | every message, including replies in every thread |
| `mentions` | DMs, @mentions of the account, @all/@here (unless group mentions are muted), replies in threads it follows |
| `nothing` | nothing (so does "mute all") |

The level is the room's desktop notification preference — the same one a person sets under a room's
"Notification Preferences" — and agents change it with `set_notifications`. Rooms that never had one saved get
`ROCKETR_DEFAULT_NOTIFICATIONS` (`mentions`), at startup and when the account joins them; a room someone reset to
"default" is left alone and treated as that level. The account's own messages, system messages and users it
ignores are never pushed.

**There is no sender allowlist.** Anyone who can post in a room an agent belongs to can put text in front of
it, so keep public or untrusted rooms at `mentions` or `nothing`. Agents replying to each other in a shared
room can ping-pong; the `sender` attribute is there so they only answer when addressed or useful.

Bursts are batched: messages in the same room and thread within `ROCKETR_BATCH_MS` (2s) of each other become
one event, flushed when the room goes quiet (or after 5 windows in a room that never does). A batch's content
has one `@sender: text` line per message.

Tag attributes: `kind` (`dm`|`mention`|`thread`|`channel`, the strongest in a batch), `room_id`, `room_name`,
`room_type`, `sender` (comma-separated in a batch), `message_id` (the last one), `ts`, `account` (who was
addressed), `thread_id` when the messages are in a thread, and `count` and `message_ids` for a batch. Reply by
calling `send_message` with the tag's `room_id` (and `thread_id`).

Only messages created after the daemon started are pushed; restarts never replay history.
A message that arrives while no session is connected is queued (up to 50) and delivered
to the next session that connects. A delivered message marks its room read.

## Install

```bash
bun install
./scripts/install.sh              # systemd --user unit, enabled at boot (linger), not started
systemctl --user start rocketr
journalctl --user -u rocketr -f
```

Credentials live in `~/.config/rocketchat/secrets.env` (see `.env.example`); set
`ROCKETR_ENV_FILE` to use another file. Environment variables win over the file.

Each account should be a dedicated **bot** user with a personal access token, not an admin:
it can only see rooms it has been added to.

## Connect Claude Code

Tools only, in any session:

```bash
claude mcp add --scope local --transport http rocketr http://127.0.0.1:8790/mcp \
  --header "x-rocketr-account: <username>" --header "x-agent-name: tools"
```

To also **receive** messages, the session must opt in twice: the connection sends
`x-rocketr-channel: on`, and Claude Code is launched with rocketr as a development channel.
Put the server in the directory's `.mcp.json` (machine-local, git-ignored):

```json
{ "mcpServers": { "rocketr": { "type": "http", "url": "http://127.0.0.1:8790/mcp",
  "headers": { "x-rocketr-account": "<username>", "x-agent-name": "main", "x-rocketr-channel": "on" } } } }
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

Open <http://127.0.0.1:8790/>. Left: connected agents (click one to filter). Right: a live
feed of tool calls (click to see arguments and result), each agent tagged with its account, inbound Rocket.Chat messages, pushes
and their delivery result, connects and disconnects. Only `x-agent-name` and `user-agent` are
shown; other headers such as `authorization` never leave the process.

The server binds to `127.0.0.1` by default. Anything that can reach the port can use the
tools as the bot, so don't expose it.

## Configuration

| Variable | Default | |
|---|---|---|
| `ROCKETR_URL` | `ROCKETCHAT_URL` | Rocket.Chat base URL |
| `ROCKETR_ACCOUNTS` | — | Comma-separated usernames rocketr signs in as (required) |
| `ROCKETR_ACCOUNT_<NAME>_USER_ID`, `_TOKEN` | — | Each account's personal access token |
| `ROCKETR_DEFAULT_NOTIFICATIONS` | `mentions` | Level saved on rooms with no notification preference yet |
| `ROCKETR_MIGRATE_LEGACY_ALL_TO_MENTIONS` | `false` | One startup only: convert saved `all` preferences to `mentions`; reversible per room |
| `ROCKETR_BATCH_MS` | `2000` | Burst window per room and thread; `0` pushes every message on its own |
| `ROCKETR_POLL_MS` | `3000` | Poll interval; backs off to 60s while Rocket.Chat is unreachable |
| `ROCKETR_HOST` / `ROCKETR_PORT` | `127.0.0.1` / `8790` | Listen address |
| `ROCKETR_ENV_FILE` | `~/.config/rocketchat/secrets.env` | Credentials file |

## Development

```bash
bun run check     # typecheck + unit tests
bun run start     # run in the foreground
```

The unit tests run the real daemon against an in-memory Rocket.Chat and connect to it with
thatch's `FakeConnection`, the same way Claude Code does: tools, pushes, gating, the queue,
and the web app are all exercised over HTTP.

## Known gaps

- thatch does not yet let a server set MCP `instructions`, which the channel docs recommend
  for telling Claude how to reply. rocketr puts that guidance in `send_message`'s
  description instead.
- Polling, not Rocket.Chat's realtime API: a push lands within one poll interval.

### Posting screenshots

Use `send_image` with `room`, `filename`, `mime_type`, and `data_base64` (base64
file bytes, without a data URL prefix). Optional `text` adds a caption and
`thread_id` posts in a thread. PNG, JPEG, GIF and WebP are supported up to 10 MiB;
the Rocket.Chat server may impose a lower limit. Image bytes travel from the
caller, so the bridge does not need access to Zippy's screenshot paths. Image
payloads are omitted from the activity log.

The bridge uses Rocket.Chat's [media upload API](https://developer.rocket.chat/apidocs/upload-media-files-to-a-room)
and [media confirmation API](https://developer.rocket.chat/apidocs/check-uploaded-file).
Both endpoints must be available on the server. Upload and publication errors
are returned without automatic retries, to avoid duplicate posts.

### Agent online status

An account appears online in Rocket.Chat while at least one MCP session for that
account has `x-rocketr-channel: on`. Tools-only sessions do not mark an agent
online. Multiple channel sessions share one presence connection; closing the last
one closes it. This indicates a connected agent runtime, not whether a model is
currently working or its provider is available.

The bridge uses Rocket.Chat's [authenticated realtime connection](https://developer.rocket.chat/apidocs/login-realtime)
and `UserPresence:online`, answering server pings and sending a heartbeat every
30 seconds. Presence reconnects after network failures. Closing the bridge's
socket lets Rocket.Chat clear presence after its normal disconnect timeout,
including when the bridge crashes. Abrupt MCP disconnects are detected by
thatch's stale-session cleanup (normally up to 75 seconds after stream detach).
No persistent manual status is set and the shared account token is never logged
out or revoked. Dedicated agent accounts should use the normal Online default;
a manually selected Invisible status can override automatic presence.

### Message reactions

`react_to_message` accepts `message_id`, `emoji` (for example `eyes`), and optional
`add` (defaults to true; false removes your reaction). It uses the calling
account and [chat.react](https://developer.rocket.chat/apidocs/react-to-message)
with an explicit add/remove flag, so repeating an acknowledgement does not toggle it off.
