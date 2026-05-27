# @zeph-to/hook-sdk

Push notification SDK + CLI for [Zeph](https://zeph.to), with an optional
resident listener that **drives Claude Code / Codex / Gemini sessions
from your phone** by injecting messages into named tmux sessions.

- `ZephHook` SDK — native `fetch`, no runtime deps. Send/list/dismiss pushes.
- `zeph` CLI — install Zeph plugins, send pushes, run agents under tmux,
  and listen for inbound messages from your phone.

## Installation

```bash
npm install -g @zeph-to/hook-sdk
# or for one-off use
npx @zeph-to/hook-sdk notify --title "Hello"
```

## Quick Start

```bash
# Interactive — detects agents, saves config, installs plugins
npx @zeph-to/hook-sdk install

# Non-interactive (one line from Zeph app)
npx @zeph-to/hook-sdk install --key ak_... --hook hook_...
```

Saves to `~/.zeph/config.json`. All Zeph tools (CLI, MCP server, plugin
hooks, listener) read this file.

To **send** notifications:

```bash
zeph notify --title "Deploy done" --body "v2.1.0 shipped"
```

To **drive a Claude Code / Codex / Gemini session from your phone**, see
[Remote Control](#remote-control) below.

## Remote Control

> Send messages from your phone *into* a live Claude Code / Codex /
> Gemini session — even after a `zeph_ask` polling window has expired.

The MCP tools `zeph_ask` / `zeph_prompt` / `zeph_input` open a polling
loop on a fixed timeout (120–600 s). Once that window closes the
session becomes unaddressable from the phone, even though it's still
running. The `zeph listener` daemon fixes this by keeping a persistent
WebSocket open to Zeph and injecting matching messages into a *named*
tmux session via `tmux send-keys`.

### Architecture

```
[phone]
   │  push body: "@zeph-myapp 리팩토링 마무리해줘"
   ▼
[Zeph backend]
   │  WebSocket fan-out (push.new)
   ▼
[zeph listener (resident daemon)]
   │  tmux send-keys -l -t zeph-myapp "리팩토링 마무리해줘" + Enter
   ▼
[tmux session "zeph-myapp" running claude / codex / gemini]
```

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

   Alternatively set `ZEPH_WS_URL` in your shell env, or pass
   `--ws-url` to the listener.

3. **Run agents through the wrapper** so they end up in a named tmux
   session the listener can address:

   ```bash
   zeph cc        # claude  → tmux session "zeph-<project>"
   zeph codex     # codex   → tmux session "zeph-<project>"
   zeph gemini    # gemini  → tmux session "zeph-<project>"
   ```

   The project name is resolved from `CLAUDE_PROJECT_DIR` /
   `CURSOR_PROJECT_DIR` / `WINDSURF_PROJECT_DIR` if set, else the git
   repo root, else the cwd basename. If you're already inside a tmux
   session (`$TMUX` is set) the wrapper skips the nested tmux and runs
   the agent in the current pane — the listener can't target that
   session by name, but you keep your existing multiplexer setup.

4. **Run the listener** (once per machine; backgrounded or under
   launchd/systemd):

   ```bash
   zeph listener &
   ```

### Wire format

Any push whose body matches `@<session> <text>` is treated as an
injection. The session name must be `[A-Za-z0-9._-]+` (shell-safe);
text is everything after the first whitespace, trimmed. Other pushes
(Stop-hook auto-pushes, `zeph_ask` responses, channel broadcasts) are
ignored — the listener only acts on the `@` prefix.

From the phone, send a push with body:

```
@zeph-myapp 테스트 다 통과시키고 PR 올려줘
```

The listener picks it up over WS, runs:

```
tmux send-keys -l -t zeph-myapp "테스트 다 통과시키고 PR 올려줘"
tmux send-keys    -t zeph-myapp Enter
```

…and the message lands in your CC/Codex/Gemini prompt.

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

# Test connection
zeph test

# Run an agent in a named tmux session (so the listener can reach it)
zeph cc                       # claude
zeph codex                    # codex
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
| `install` | One-command setup: detect agents, save config, install rules + hooks + MCP |
| `uninstall` | Remove Zeph from all detected agents (`--dry-run`, `--purge`) |
| `verify` | Check installation health across detected agents (`--ping` for a live API call) |
| `check-update` | Check whether a newer Zeph version is on npm |
| `notify` | Send a push notification |
| `list` | List recent push notifications |
| `dismiss <id>` | Dismiss a push (or `--all`) |
| `test` | Verify connection and API key |
| `cc` · `codex` · `gemini` | Run the agent in a `zeph-<project>` tmux session so the listener can address it |
| `listener` | Resident daemon: subscribes via WebSocket and injects `@<session> <text>` pushes into matching tmux sessions |

### Notify Options

| Flag | Description |
|------|-------------|
| `--title <text>` | Push title (default: `"Task done"`) |
| `--body <text>` | Push body (default: `"<project> · <branch>"` if cwd is a git repo, else `"<project>"`) |
| `--url <url>` | URL to include |
| `--type <type>` | Push type: `note`, `link`, `file`, `hook` |
| `--priority <p>` | Priority: `low`, `normal`, `high`, `urgent` |
| `--device <id>` | Target device ID |

The defaults are tuned for hook-driven invocations (e.g. Stop hooks
calling `zeph notify --title "Task done"` without a body) — you'll see
which project + branch finished without writing per-IDE wrappers. Pass
`--body ""` explicitly to suppress.

### Listener Options

| Flag | Description |
|------|-------------|
| `--ws-url <url>` | WebSocket endpoint (or set `ZEPH_WS_URL` env, or `wsUrl` in `~/.zeph/config.json`) |
| `--key <api-key>` | API key (or set `ZEPH_API_KEY` env) |

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

### Mute

Mute is project-scoped (uses project directory hash). Created by Claude
Code `/zeph-mute` command.

Notifications are silently skipped when a mute file exists for the
current project:

```bash
# Mute (created by /zeph-mute in Claude Code plugin)
HASH=$(echo -n "$PROJECT_DIR" | cksum | cut -d' ' -f1)
touch /tmp/zeph-muted-$HASH

# Unmute
rm /tmp/zeph-muted-$HASH
```

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
| `ZEPH_SESSION_ID` | AI session ID (fallback when `--session` not provided) |

## SDK Usage

```typescript
import { ZephHook } from '@zeph-to/hook-sdk';

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
import { ZephHook, AuthenticationError, QuotaExceededError, ZephError } from '@zeph-to/hook-sdk';

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
| Windsurf | MCP server + response hook |
| Gemini CLI | MCP server + AfterAgent hook |
| Codex CLI | Stop hook |
| Copilot CLI | Session end hook |
| Cline | Rules file |

For remote-control via `zeph listener` the per-agent setup is the same
across CC/Codex/Gemini — the wrapper just spawns them in a named tmux
session.

## Encryption

Push bodies are encrypted with AES-256-GCM. The wrapping key is derived
via ECDH P-256 and synced across your own devices on first run so every
device can read the same push. Toggle encryption in the Zeph app
(Settings → Encryption); when disabled, the CLI sends plaintext. No
configuration needed.

**Threat model honesty:** keys are persisted on the Zeph backend to
enable cross-device sync, so this is *device-shared* encryption — not
true end-to-end. It protects push contents from passive network
observers and from a leaked database snapshot taken without the key
store, but it does **not** protect against the Zeph backend itself (it
has the keys it serves to your devices). A true E2E mode (per-device
keypairs, server stores only public keys, no key escrow) is on the
roadmap.

The `zeph listener` ignores `isEncrypted` pushes for now — it has no
per-device key to decrypt them. Stop-hook auto-pushes and `zeph_ask`
responses are not part of the `@<session>` injection path, so this
doesn't affect normal use.

## Requirements

- **Node.js >= 18** (uses native `fetch`).
- **tmux** — required for `zeph cc` / `codex` / `gemini` and `zeph listener`.
- The `ZephHook` SDK has no runtime dependencies. The CLI depends on
  `@inquirer/prompts` for the interactive `zeph install` picker and on
  `ws` for the listener's WebSocket subscription.

## License

Apache-2.0
