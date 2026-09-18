# rocketr

A daemon that puts Claude Code on Rocket.Chat. It is a [thatch](https://github.com/brooswit-factory/thatch)
MCP server: Claude Code sessions connect to it over HTTP, get chat tools, and — through a
**channel** — have DMs and @mentions pushed straight into the running session, so Claude can
answer people in Rocket.Chat as they write. A small web app shows every connected agent and
each tool call it makes, live.

```
Rocket.Chat ──poll──▶ rocketr ──channel push──▶ Claude Code session(s)
     ▲                  │  ▲
     └──send_message────┘  └── http://127.0.0.1:8790/  (observer web app)
```

## Tools

| Tool | What it does |
|---|---|
| `whoami` | The Rocket.Chat account rocketr is signed in as |
| `list_rooms` | Rooms it is in, with unread and mention counts |
| `read_messages` | Recent messages in a room or one thread, oldest first |
| `send_message` | Post to a room, DM, or thread. The reply tool for channel events |

A room is an id, `#channel`, or `@username` (a DM, created on first use).

## The channel

Every poll (3s by default) rocketr asks Rocket.Chat which subscriptions changed, reads the new
messages, and pushes a `<channel source="rocketr" …>` event for:

- any DM to its account, and
- any channel message that @mentions it,

**from an allowed sender only** (`ROCKETR_ALLOW`). The check is on the sender's user id, never
the room — anyone can post in a shared channel, and an ungated channel is a prompt-injection
path into your session. Usernames are resolved to ids at startup, so a renamed account
cannot slip in by taking an allowed name.

Tag attributes: `kind` (`dm`|`mention`), `room_id`, `room_name`, `room_type`, `sender`,
`message_id`, `ts`, and `thread_id` when the message is in a thread. Reply by calling
`send_message` with the tag's `room_id` (and `thread_id`).

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

The account should be a dedicated **bot** user with a personal access token, not an admin:
it can only see rooms it has been added to.

## Connect Claude Code

Tools only, in any session:

```bash
claude mcp add --scope user --transport http rocketr http://127.0.0.1:8790/mcp \
  --header "x-agent-name: tools"
```

To also **receive** DMs and @mentions, the session must opt in twice: the connection sends
`x-rocketr-channel: on`, and Claude Code is launched with rocketr as a development channel.
Put the server in the directory's `.mcp.json` (machine-local, git-ignored):

```json
{ "mcpServers": { "rocketr": { "type": "http", "url": "http://127.0.0.1:8790/mcp",
  "headers": { "x-agent-name": "main", "x-rocketr-channel": "on" } } } }
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
every push, and `x-agent-name` labels the session in the web app.

## Web app

Open <http://127.0.0.1:8790/>. Left: connected agents (click one to filter). Right: a live
feed of tool calls (click to see arguments and result), inbound Rocket.Chat messages, pushes
and their delivery result, connects and disconnects. Only `x-agent-name` and `user-agent` are
shown; other headers such as `authorization` never leave the process.

The server binds to `127.0.0.1` by default. Anything that can reach the port can use the
tools as the bot, so don't expose it.

## Configuration

| Variable | Default | |
|---|---|---|
| `ROCKETR_URL` | `ROCKETCHAT_URL` | Rocket.Chat base URL |
| `ROCKETR_USER_ID`, `ROCKETR_TOKEN` | — | Bot personal access token |
| `ROCKETR_ALLOW` | *(empty: push nothing)* | Comma-separated usernames whose DMs/mentions are pushed |
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
