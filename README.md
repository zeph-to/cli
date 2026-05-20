# @zeph-to/hook-sdk

Push notification SDK + CLI for [Zeph](https://zeph.to). Zero dependencies — uses native `fetch`.

## Installation

```bash
npm install @zeph-to/hook-sdk
# or
npx @zeph-to/hook-sdk notify --title "Hello"
```

## Quick Start

```bash
# Interactive — detects agents, saves config, installs plugins
npx @zeph-to/hook-sdk install

# Non-interactive (one line from Zeph app)
npx @zeph-to/hook-sdk install --key ak_... --hook hook_...
```

Saves to `~/.zeph/config.json`. All Zeph tools (CLI, MCP server, plugin hooks) read this file.

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

# JSON output
zeph notify --title "Hello" --json
```

### Commands

| Command | Description |
|---------|-------------|
| `install` | One-command setup: detect agents, save config, install plugins |
| `notify` | Send a push notification |
| `list` | List recent push notifications |
| `dismiss <id>` | Dismiss a push (or `--all`) |
| `test` | Verify connection and API key |

### Notify Options

| Flag | Description |
|------|-------------|
| `--title <text>` | Push title (default: `"Task done"`) |
| `--body <text>` | Push body (default: `"<project> · <branch>"` if cwd is a git repo, else `"<project>"`) |
| `--url <url>` | URL to include |
| `--type <type>` | Push type: `note`, `link`, `file`, `hook` |
| `--priority <p>` | Priority: `low`, `normal`, `high`, `urgent` |
| `--device <id>` | Target device ID |

The defaults are tuned for hook-driven invocations (e.g. Stop hooks calling `zeph notify --title "Task done"` without a body) — you'll see which project + branch finished without writing per-IDE wrappers. Pass `--body ""` explicitly to suppress.

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

Mute is project-scoped (uses project directory hash). Created by Claude Code `/zeph-mute` command.

Notifications are silently skipped when a mute file exists for the current project:

```bash
# Mute (created by /zeph-mute in Claude Code plugin)
HASH=$(echo -n "$PROJECT_DIR" | cksum | cut -d' ' -f1)
touch /tmp/zeph-muted-$HASH

# Unmute
rm /tmp/zeph-muted-$HASH
```

The CLI checks `CLAUDE_PROJECT_DIR`, `CURSOR_PROJECT_DIR`, `WINDSURF_PROJECT_DIR`, and falls back to `cwd`.

### Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | General error |
| 2 | Quota exceeded |
| 3 | Authentication failed |

### Environment Variables

| Variable | Description |
|----------|-------------|
| `ZEPH_API_KEY` | API key (fallback when `--key` not provided) |
| `ZEPH_BASE_URL` | API base URL (default: `https://api.zeph.to/v1`) |

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

## Encryption

Push bodies are encrypted with AES-256-GCM. The wrapping key is derived via ECDH P-256 and synced across your own devices on first run so every device can read the same push. Toggle encryption in the Zeph app (Settings → Encryption); when disabled, the CLI sends plaintext. No configuration needed.

**Threat model honesty:** keys are persisted on the Zeph backend to enable cross-device sync, so this is *device-shared* encryption — not true end-to-end. It protects push contents from passive network observers and from a leaked database snapshot taken without the key store, but it does **not** protect against the Zeph backend itself (it has the keys it serves to your devices). A true E2E mode (per-device keypairs, server stores only public keys, no key escrow) is on the roadmap.

## Requirements

- Node.js >= 18 (uses native `fetch`)
- Zero runtime dependencies

## License

Apache-2.0
