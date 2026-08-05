# @zeph-to/cli

[![npm](https://img.shields.io/npm/v/@zeph-to/cli.svg)](https://www.npmjs.com/package/@zeph-to/cli)
[![downloads](https://img.shields.io/npm/dm/@zeph-to/cli.svg)](https://www.npmjs.com/package/@zeph-to/cli)
[![node](https://img.shields.io/node/v/@zeph-to/cli.svg)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/@zeph-to/cli.svg)](./LICENSE)

**Your agent works, hits a decision, and asks your phone. You tap a button (or type a reply), and the answer lands back in the live session — so the agent keeps going.**

`@zeph-to/cli` is the terminal side of that round trip: a zero-dependency push SDK, a `zeph` CLI that wires up 8 AI agents in one command, and a resident listener that lets your phone **drive Claude Code / Codex / Cursor / Gemini sessions** by typing straight into named tmux sessions.

<p align="center">
  <img src="https://zeph.to/readme/demo.gif" alt="Agent asks 'Deploy to prod?' on your phone; you tap Deploy; the session ships" width="560"><br>
  <sub><em>Your agent asks on your phone → you tap <b>Deploy</b> → the session ships. No terminal.</em></sub>
</p>

- **`ZephHook` SDK** — native `fetch`, no runtime deps. Send / list / dismiss pushes.
- **`zeph` CLI** — one-command setup for 8 agents, push sending, and the resident listener for phone-driven remote control.

Part of the Zeph toolchain: [`@zeph-to/mcp-server`](https://github.com/zeph-to/mcp-server) (the MCP tools your agent calls, e.g. `zeph_ask`) · [`zeph-to/plugin`](https://github.com/zeph-to/plugin) (Claude Code plugin bundling hooks + MCP + rules) · the [Zeph app](https://zeph.to) on your phone.

## Quick Start

Install the CLI globally, then run setup:

```bash
npm install -g @zeph-to/cli
zeph install
```

`zeph install` opens a browser sign-in on a fresh machine — the web app
issues an API key + hook as a matched pair and the CLI writes them to
`~/.zeph/config.json` (no copy-paste). Then it installs rules + hooks +
MCP for every detected agent (Claude Code / Cursor / Windsurf / Gemini /
Codex / …). Safe to re-run: a saved login is reused untouched (no
prompts), so a re-run just refreshes the agent integrations. To switch
account, `zeph install --relogin` forces a fresh sign-in.

**Why global, not `npx`?** `zeph cc` (drive a session from your phone)
needs `zeph` on your `PATH`, and the agent hooks this installs are
`$(command -v zeph || npx …)` — a global binary skips an npx cold-start
on *every* notification. For notifications only, with no phone control,
`npx @zeph-to/cli install` is a lighter alternative that skips the global
binary.

Once installed, the hooks fire in **every** session of each configured
agent — `zeph cc` is the phone-control bridge, not the notification
switch. In Claude Code the routine per-turn push starts off (`quiet` is
the default); `/zeph-normal` turns it on for a project, `/zeph-loud`
pushes on every turn, `/zeph-mute` silences a project entirely, and
`/zeph-status` shows what's in effect. See
[Mute & push mode](#mute--push-mode).

`~/.zeph/config.json` is the single source of truth — the CLI, the MCP
server, the plugin hooks, and the listener all read it. You never need
`ZEPH_API_KEY`-style env vars for a normal setup; they exist as overrides
(second account, CI).

Variants:

```bash
# Headless box (no browser): paste credentials from another machine's
# ~/.zeph/config.json
zeph install --key ak_... --hook hook_...

# Skip the interactive agent picker
zeph install --only claude,cursor

# Switch account — force a fresh browser sign-in over a saved login
zeph install --relogin

# Refresh credentials only (no agent re-install) — assumes you already
# ran `zeph install` once; on its own it does NOT wire MCP into agents
zeph login
```

To **send** notifications:

```bash
zeph notify --title "Deploy done" --body "v2.1.0 shipped"
```

To **drive a Claude Code / Codex / Cursor / Gemini session from your phone**, see
[Remote Control](#remote-control) below.

## Remote Control

> Send messages from your phone *into* a live Claude Code / Codex /
> Gemini session — even after a `zeph_ask` polling window has expired.

<p align="center">
  <img src="https://zeph.to/readme/ask-phone.png" alt="A Zeph hook on the phone: a question with tappable answer buttons and a text field" width="300">
</p>

The MCP tools `zeph_ask` / `zeph_prompt` / `zeph_input` wait on a fixed
timeout (120–600 s). Once that window closes the
session becomes unaddressable from the phone, even though it's still
running. The `zeph listener` daemon fixes this by keeping a persistent
WebSocket open to Zeph and injecting matching messages into a *named*
tmux session via `tmux send-keys`.

### Architecture

```
[phone — "Active Agents" picker on Zeph app]
   │  selects session, types message
   ▼  POST /pushes/send  { type: 'agent.command',
   │                       agentSessionName: 'zeph-myapp',
   │                       body: '리팩토링 마무리해줘' }
[Zeph backend]
   │  WebSocket fan-out (push.new)
   ▼
[zeph listener — resident daemon, started by `zeph cc` automatically]
   │  tmux send-keys -l -t zeph-myapp "리팩토링 마무리해줘" + Enter
   ▼
[tmux session "zeph-myapp" running claude / codex / cursor-agent / gemini]
```

The listener polls its tmux session inventory every 5 seconds and
reports it to the server whenever something changed (new session, agent
state transition, activity) — an unchanged inventory is re-sent only as
a 30-second idle heartbeat. The phone picker stays in sync with no
manual configuration, and an idle listener costs the backend a fraction
of what a fixed 5-second report cycle would.

### Remote-origin detection (sticky REMOTE mode)

A message injected via `send-keys` is indistinguishable from typing — so
the listener also records each injection as a one-shot marker (epoch +
sha256 of the text, keyed by the pane's project dir). A prompt-submit
hook on the agent side matches the submitted prompt against that marker
and, on an exact match, tells the model the user is driving the session
from their phone — entering sticky REMOTE mode (every response ends with
an answerable `zeph_ask`).

| Agent | Hook | Installed by |
|-------|------|--------------|
| Claude Code | `UserPromptSubmit` → plugin's `zeph-remote.sh` | Zeph plugin |
| Gemini CLI | `BeforeAgent` → `zeph remote-hook gemini` | `zeph setup` |
| Codex CLI | `UserPromptSubmit` → `zeph remote-hook codex` | `zeph setup` |
| Cursor CLI | — none yet | — |

Detection is exact-match: a terminal keystroke racing a phone message
can never false-flag. Muted projects are never flagged.

`zeph cursor` has no remote-origin hook, so it never enters sticky REMOTE
mode by itself. **Just ask for it** — one line, once per session:

> I'm driving this session from my phone. End every response with
> `zeph_ask` so I can answer with a button.

Nothing else is missing: injection works, and the MCP tools are all
there, `zeph_ask` included. Check them with `cursor-agent mcp list-tools
zeph` — `mcp list` prints only the *approved* list, not what's
configured, so it reads as empty even when the server is wired up.

Why it isn't automatic: `hooks.json` is honored by the Cursor IDE but not
by `cursor-agent`, and `beforeSubmitPrompt`'s output schema is
`{continue, user_message}` — no context channel to deliver a marker match
through. Same reason the `stop`-hook auto-push `zeph setup` installs
covers the Cursor **IDE** but not `zeph cursor` panes; ask for a
`zeph_notify` when you want one.

### Setup

1. **Install tmux.** The listener uses `send-keys`; the wrapper spawns
   named sessions. `brew install tmux` on macOS, `apt install tmux` on
   Debian/Ubuntu.

2. **Add `wsUrl` to `~/.zeph/config.json`** (the WebSocket endpoint of
   your Zeph backend — CDK output `WsApiUrl`):

   ```json
   {
     "apiKey": "ak_...",
     "hookId": "hook_...",
     "wsUrl": "wss://<api-id>.execute-api.<region>.amazonaws.com/<stage>"
   }
   ```

   Alternatively set `ZEPH_WS_URL` in your shell env.

3. **Run agents through the wrapper.** That's it.

   ```bash
   zeph cc        # claude       → tmux session "zeph-<project>"
   zeph codex     # codex        → tmux session "zeph-<project>"
   zeph cursor    # cursor-agent → tmux session "zeph-<project>"
   zeph gemini    # gemini       → tmux session "zeph-<project>"
   ```

   `zeph cursor` runs **`cursor-agent`**, Cursor's terminal agent — a
   separate install from the Cursor IDE (the bare `cursor` on your PATH
   is the editor launcher, which exits immediately and can't be driven).

   The first `zeph cc` on a machine **auto-spawns a background
   listener** (singleton, PID file at `~/.zeph/listener.pid`,
   stdout/stderr at `~/.zeph/listener.log`). You never run
   `zeph listener` by hand — every `zeph cc` checks the PID file and
   skips the spawn when one is already alive, so opening a dozen
   terminals doesn't create a dozen daemons. The daemon survives
   between `zeph cc` invocations.

   Project name resolves from `CLAUDE_PROJECT_DIR` /
   `CURSOR_PROJECT_DIR` / `WINDSURF_PROJECT_DIR` if set, else the git
   repo root, else the cwd basename. Any extra args after the command
   pass through to the agent verbatim:

   ```bash
   zeph cc --resume "abc123"
   zeph cc --dangerously-skip-permissions
   zeph codex --model gpt-5-high "fix the failing test"
   ```

   **Multiple sessions in one project.** Open another terminal in the
   same folder, run `zeph cc` again, and the wrapper auto-suffixes:
   first session is `zeph-encl`, the next attached one becomes
   `zeph-encl-2`, then `zeph-encl-3`, etc. The phone picker shows them
   as `encl · Claude`, `encl · Claude #2`, `encl · Claude #3`. If
   `zeph-encl` already exists but is **detached** (no one attached),
   the wrapper reattaches to it instead of spawning a new one — close
   the terminal, come back later, pick up where you left off.

   If you're already inside a tmux session (`$TMUX` set) the wrapper
   skips the outer tmux and runs the agent in the current pane — the
   listener can't target an unnamed session that way, but you keep your
   existing multiplexer setup.

### Diagnostics

The auto-spawned listener writes to three files under `~/.zeph/`:

- `listener.pid` — the running daemon's PID. `cat ~/.zeph/listener.pid`
  + `ps -p <pid>` to confirm it's alive.
- `listener.version` — the CLI version the daemon booted from. This is
  what `zeph cc` compares against the installed package to spot a stale
  daemon (see below).
- `listener.log` — stdout + stderr from the daemon. `tail -f` to watch.

The daemon logs its version on the first line, which is the only
reliable way to tell which build a long-running process is on:

```
[xx:xx:xx] zeph listener starting — v1.26.0 — wss://ws.zeph.to
```

A healthy listener log shows one line per cycle:

```
[xx:xx:xx] reported 2 session(s): zeph-myapp, zeph-otherapp
[xx:xx:xx] ✓ server persisted 2 session(s)
```

If you see `! server rejected listener.sessions: ...` instead, the
message points at the failure (auth, missing device record, etc.) so
you can fix the actual problem instead of guessing.

To force a restart:

```bash
zeph listener --restart
```

**After upgrading `@zeph-to/cli` you normally don't have to.** `npm i -g`
replaces the package on disk but never the daemon already running from
the old build — that daemon keeps answering pushes (so agent chat looks
fine) while silently ignoring every message subtype added since it
booted. `zeph cc` compares `listener.version` against the installed
version and restarts the daemon for you when the installed one is newer
(a daemon *newer* than the `zeph cc` you ran is left alone, so several
installs on one machine don't fight over it):

```
zeph: listener 1.25.0 is stale — restarting on 1.26.0
```

If the PID file is missing (a different account started the daemon, or
it was removed by hand) the singleton guard can't see it. Find the real
process instead:

```bash
ps aux | grep '[c]li.js listener'
```

To run it in the foreground (for development of the SDK itself):

```bash
zeph listener
```

You'll get the same logs you'd otherwise tail from `listener.log`.

### Custom tmux sockets

The listener auto-discovers the tmux socket — it probes the default
location, walks per-user `$TMPDIR` paths (macOS `/var/folders/.../T/`),
falls back to `/tmp/tmux-<uid>/`, and finally finds running tmux servers
via `lsof` so stale socket files don't trip discovery. If your tmux
uses `tmux -L <name>` or a non-standard `-S <path>`, set the override
explicitly:

```bash
export ZEPH_TMUX_SOCKET=/path/to/socket
```

(The wrapper passes the env to the auto-spawned listener, so setting
it in your shell rc is enough.)

### Wire format

The listener only acts on pushes with `type='agent.command'` carrying
the tmux session name in `agentSessionName` and the message in `body`.
Other pushes (Stop-hook auto-pushes, `zeph_ask` responses, channel
broadcasts, plain notes) are ignored. End-to-end:

```
tmux send-keys -l -t <agentSessionName> "<body>"
tmux send-keys    -t <agentSessionName> Enter
```

If you need to send one from the command line (debugging, scripting),
build the structured push directly:

```bash
curl -X POST "$ZEPH_BASE_URL/pushes/send" \
  -H "X-API-Key: $ZEPH_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{
    "type": "agent.command",
    "targetDeviceId": "dev_listener_<sha8(hostname)>",
    "agentSessionName": "zeph-myapp",
    "body": "테스트 통과시키고 PR 올려줘"
  }'
```

### Defense

The listener is a remote-code-execution surface by design (it types
into a shell-adjacent pane). The defense is layered:

1. **Pane guard** — before injecting, the listener checks
   `tmux display-message -p '#{pane_current_command}'`. If the pane is
   at an interactive shell (`bash`/`zsh`/`fish`/`sh`/`dash`/`ksh`/
   `tcsh`/`csh`/`pwsh`), the inject is refused. CC/Codex/Gemini exited
   ≠ phone gets free shell access.
2. **Literal injection** — `tmux send-keys -l` takes the payload as
   data; tmux escape sequences inside a message can't drive other tmux
   commands.
3. **Session-name allowlist** — only `[A-Za-z0-9._-]+` is accepted as
   a session target, so shell metacharacters never reach the tmux argv.
4. **Per-session rate limit** — 30 injections/minute/session token
   bucket caps a runaway/compromised sender.
5. **Agent permission gate stays on** — your CC/Codex/Gemini permission
   prompt is still in front of every destructive tool call. The phone
   can *talk* but can't approve `rm -rf` for you.

The transport (WS) is currently authenticated by API key + `push:read`
scope and is **not** end-to-end encrypted in v1 — your Zeph backend
sees the message plaintext. If you self-host or trust your backend,
that's fine. If you don't, hold off until per-device E2E ships.

## CLI Usage

```bash
# Send a notification
zeph notify --title "Deploy done" --body "v2.1.0 shipped"

# Send with priority
zeph notify --title "Build failed" --priority high --url https://ci.example.com/123

# List recent pushes
zeph list
zeph list --limit 10 --type note

# Dismiss a push
zeph dismiss push_01JXY...
zeph dismiss --all

# Rename the current agent session (shows in the app's Agents list)
zeph rename "Prod deploy"
zeph rename --clear                # reset to the default name

# Test connection
zeph test

# Run an agent in a named tmux session (so the listener can reach it)
zeph cc                       # claude
zeph codex                    # codex
zeph cursor                   # cursor-agent (Cursor CLI, not the IDE)
zeph gemini                   # gemini

# Run the resident listener (foreground; background it as you like)
zeph listener
zeph listener --ws-url wss://...   # override config

# JSON output
zeph notify --title "Hello" --json
```

### Commands

| Command | Description |
|---------|-------------|
| `login` | Browser sign-in: auto-fetch API key + hook into `~/.zeph/config.json` over a localhost loopback (`--web-url`, `--timeout`). No copy-paste |
| `install` (alias: `setup`) | One-command setup: detect agents, save config, install rules + hooks + MCP. No saved config → opens browser login automatically. `--only claude,cursor,…` skips the picker |
| `uninstall` | Remove Zeph from all detected agents (`--dry-run`, `--purge`) |
| `verify` | Check installation health across detected agents (`--ping` for a live API call) |
| `check-update` | Check whether a newer Zeph version is on npm |
| `notify` | Send a push notification |
| `list` | List recent push notifications |
| `dismiss <id>` | Dismiss a push (or `--all`) |
| `rename <name>` | Set the current agent session's display name in the app — run inside a `zeph cc` session (`--clear` resets). Auto-detects the tmux session + this machine's listener device id, so the alias lands on the right device |
| `test` | Verify connection and API key |
| `cc` · `codex` · `gemini` | Run the agent in a `zeph-<project>` tmux session (auto-suffixed `-2`, `-3`, … on attached collisions). Auto-spawns the background listener on first invocation so the phone picker just works. Trailing args pass through to the agent (`zeph cc --resume "..."`) |
| `listener` | (Usually unnecessary — `zeph cc` autospawns it.) Resident daemon: subscribes via WebSocket, reports tmux session inventory every 5 s, injects `agent.command` pushes into the matching session. Run in the foreground for SDK development; otherwise let `zeph cc` manage it |

### Notify Options

| Flag | Description |
|------|-------------|
| `--title <text>` | Push title (default: `"Task done"`) |
| `--body <text>` | Push body (default: `"<project> · <branch>"` if cwd is a git repo, else `"<project>"`) |
| `--url <url>` | URL to include |
| `--type <type>` | Push type: `note`, `link`, `file`, `hook` |
| `--priority <p>` | Priority: `low`, `normal`, `high`, `urgent` |
| `--device <id>` | Target device ID |
| `--session <id>` | AI session ID so the push threads into that session's chat (or `ZEPH_SESSION_ID` env) |
| `--auto` | Apply the push gate before sending — honors the `/zeph-quiet` / `/zeph-loud` push-mode dial, per project or machine-wide (`--global`); gated-out exits silently with code 0 |
| `--pushmode-default <m>` | Mode `--auto` assumes when the project has no dial: `quiet` (built-in), `normal`, `loud`. A dial the user set always wins |
| `--marker <m>` | Push Signal marker for `--auto`: `skip`, `push`, `high` |
| `--tools <n>`, `--nonreadonly <n>` | Turn tool counts feeding `--auto`'s heuristic (defaults assume real work) |

The defaults are tuned for hook-driven invocations (e.g. Stop hooks
calling `zeph notify --title "Task done"` without a body) — you'll see
which project + branch finished without writing per-IDE wrappers. Pass
`--body ""` explicitly to suppress.

### Listener Options

| Flag | Description |
|------|-------------|
| `--ws-url <url>` | WebSocket endpoint (or set `ZEPH_WS_URL` env, or `wsUrl` in `~/.zeph/config.json`) |
| `--key <api-key>` | API key (or set `ZEPH_API_KEY` env) |
| `--base-url <url>` | REST API base URL (or set `ZEPH_BASE_URL` env, or `baseUrl` in `~/.zeph/config.json`) |
| `--stop` | Stop the running daemon and clear its PID/version stamps |
| `--restart` | Stop it and relaunch detached (logs to `~/.zeph/listener.log`) |

The listener reconnects with exponential backoff + jitter (1 s → 30 s
cap). Heartbeat is ping every 25 s with a 10 s pong timeout. On an
authentication failure close (4001/4002/4003) the listener exits with
code 3 instead of looping forever — fix the key and restart.

### List Options

| Flag | Description |
|------|-------------|
| `--limit <n>` | Number of pushes (1-20, default 5) |
| `--type <type>` | Filter by push type |

### Global Options

| Flag | Description |
|------|-------------|
| `--key <api-key>` | API key (or set `ZEPH_API_KEY` env) |
| `--base-url <url>` | API base URL (or set `ZEPH_BASE_URL` env) |
| `--json` | Output JSON format |
| `--version` | Print version |

### Mute & push mode

Both live as state files under `${XDG_STATE_HOME:-~/.local/state}/zeph`,
keyed by a `cksum` hash of the project directory. Claude Code's
`/zeph-mute` / `/zeph-quiet` / `/zeph-loud` / `/zeph-normal` write them;
the CLI reads them (mute on every `notify`, push mode on `--auto`).

Notifications are silently skipped when a mute file exists for the
current project:

```bash
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/zeph"
HASH=$(printf '%s' "$PROJECT_DIR" | cksum | cut -d' ' -f1)

# Mute (created by /zeph-mute in the Claude Code plugin)
mkdir -p "$STATE_DIR" && touch "$STATE_DIR/muted-$HASH"

# Unmute
rm -f "$STATE_DIR/muted-$HASH"
```

Push mode is a one-word file (`quiet` / `loud` / `normal`) resolved in
this order — first hit wins:

| Order | File | Set by |
|-------|------|--------|
| 1 | `$STATE_DIR/pushmode-<hash>` | `/zeph-quiet` · `/zeph-loud` · `/zeph-normal` |
| 2 | `/tmp/zeph-pushmode-<hash>` | older versions (honored only when you own the file) |
| 3 | `$STATE_DIR/pushmode-default` | the `--global` form of any dial — the machine-wide default |
| 4 | `--pushmode-default <mode>` | the calling hook (the installed ones pass `normal`) |
| 5 | *(nothing above)* | `quiet` |

**Row 5 changed**: an install with no dial anywhere used to be `normal`.
It is now `quiet`, so upgrading turns the routine per-turn push off until
you run `/zeph-normal`. Row 4 is why the hooks this CLI installs are
unaffected: they name `normal` themselves, since a hook that supplies no
turn counts also supplies no `high` marker, and `quiet` would make it
permanently silent rather than merely quieter. Row 4 sits *below* the
state files on purpose — the flag names a default, it does not override a
dial the user set.

A dial file that exists but reads empty resolves to `normal`, not to row
5: an empty file is a failed write, and resolving breakage to silence
leaves no symptom to debug.

Mute has no `-default` form on purpose: it is keyed on presence, not
content, so a global mute could never be lifted for a single project.

Legacy `/tmp/zeph-muted-<hash>` files are still honored when owned by the
current user (the state dir moved out of world-writable `/tmp`).

The CLI checks `CLAUDE_PROJECT_DIR`, `CURSOR_PROJECT_DIR`,
`WINDSURF_PROJECT_DIR`, and falls back to `cwd`.

### Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | General error |
| 2 | Quota exceeded |
| 3 | Authentication failed (also: listener auth close 4001/4002/4003) |
| 127 | A required external binary (e.g. `tmux`, `claude`) was not found on PATH |

### Environment Variables

| Variable | Description |
|----------|-------------|
| `ZEPH_API_KEY` | API key (fallback when `--key` not provided) |
| `ZEPH_BASE_URL` | API base URL (default: `https://api.zeph.to/v1`) |
| `ZEPH_WS_URL` | WebSocket endpoint for `zeph listener` (no default — required) |
| `ZEPH_TMUX_SOCKET` | Explicit tmux socket path for the listener (skips auto-discovery — use when your tmux runs with `-L <name>` or a custom `-S <path>`) |
| `ZEPH_SESSION_ID` | AI session ID (fallback when `--session` not provided) |

## SDK Usage

```typescript
import { ZephHook } from '@zeph-to/cli';

const hook = new ZephHook({ apiKey: 'ak_...' });

// Notify
const result = await hook.notify({
  title: 'Build Complete',
  body: 'Deploy succeeded',
  url: 'https://example.com/deploy/123',
  priority: 'high',
});
console.log(result.pushId); // 'push_01JXY...'

// List
const list = await hook.list({ limit: 5 });
console.log(list.pushes);

// Dismiss
await hook.dismiss('push_01JXY...');
await hook.dismissAll();
```

### Constructor Options

| Field | Type | Description |
|-------|------|-------------|
| `apiKey` | `string` | Required — API key from Zeph settings |
| `baseUrl` | `string?` | API base URL (default: `https://api.zeph.to/v1`) |
| `timeout` | `number?` | Request timeout in ms (default: 30000) |

### Notify Payload

| Field | Type | Description |
|-------|------|-------------|
| `title` | `string?` | Push title |
| `body` | `string?` | Push body |
| `url` | `string?` | URL to include |
| `type` | `'note' \| 'link' \| 'file' \| 'hook'?` | Push type (default: `hook`) |
| `priority` | `'low' \| 'normal' \| 'high' \| 'urgent'?` | Priority (default: `normal`) |
| `targetDeviceId` | `string?` | Send to specific device |

### Error Handling

```typescript
import { ZephHook, AuthenticationError, QuotaExceededError, ZephError } from '@zeph-to/cli';

try {
  await hook.notify({ title: 'Hello' });
} catch (err) {
  if (err instanceof AuthenticationError) { /* Invalid API key */ }
  if (err instanceof QuotaExceededError) { /* Monthly limit reached */ }
  if (err instanceof ZephError) { /* Other API error */ }
}
```

## Supported Agents

`zeph install` detects and configures these agents automatically:

| Agent | What gets installed |
|-------|-------------------|
| Claude Code | Plugin (hooks + MCP server) |
| Cursor | MCP server + stop hook + rules |
| Windsurf | MCP server + response hook + rules |
| Gemini CLI | MCP server + AfterAgent hook |
| Codex CLI | Stop hook + rules |
| Copilot CLI | Session end hook + rules |
| Cline | Rules file (`~/.cline/rules/zeph.md`) |
| Aider | Conventions file + `read:` directive in `~/.aider.conf.yml` |

For remote-control via `zeph listener` the per-agent setup is the same
across CC/Codex/Gemini — the wrapper just spawns them in a named tmux
session.

## Encryption

Push bodies and long-body attachments are encrypted with AES-256-GCM.
This host holds its own ECDH P-256 keypair in `~/.zeph/device-keys.json`
— generated on first use, and the private half never leaves the machine.
Each push is encrypted once, and its AES key is wrapped separately for
every device on your account using ECDH against that device's public
key.

Toggle encryption in the Zeph app (Settings → Encryption); when it is
off, the CLI sends plaintext. No configuration needed.

**Threat model:** the backend stores ciphertext plus wrapped keys it
cannot unwrap, so it never sees push contents. Two limits worth knowing:
there is no forward secrecy (the ECDH secret for a given sender/device
pair is static, so compromising either private key opens past pushes
wrapped for that pair), and nothing signs `senderPublicKey` — a
malicious server could make a push undecryptable, though not readable.

A device that has not registered a per-device public key cannot be sent
to; it is skipped, and if no device qualifies the push goes out in the
clear rather than arriving as something nothing can open.

The `zeph listener` ignores `isEncrypted` pushes for now — it does not
try to decrypt them. Stop-hook auto-pushes and `zeph_ask` responses are
not part of the `@<session>` injection path, so this doesn't affect
normal use.

## Requirements

- **Node.js >= 18** (uses native `fetch`).
- **tmux** — required for `zeph cc` / `codex` / `gemini` and `zeph listener`.
- The `ZephHook` SDK has no runtime dependencies. The CLI depends on
  `@inquirer/prompts` for the interactive `zeph install` picker and on
  `ws` for the listener's WebSocket subscription.

## License

Apache-2.0
