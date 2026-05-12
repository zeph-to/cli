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
| `test` | Send a test notification to verify setup |

### Notify Options

| Flag | Description |
|------|-------------|
| `--title <text>` | Push title |
| `--body <text>` | Push body |
| `--url <url>` | URL to include |
| `--type <type>` | Push type: `note`, `link`, `file` |
| `--priority <p>` | Priority: `low`, `normal`, `high`, `urgent` |
| `--device <id>` | Target device ID |

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
| `type` | `'note' \| 'link' \| 'file'?` | Push type (default: `note`) |
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

## Requirements

- Node.js >= 18 (uses native `fetch`)
- Zero runtime dependencies

## License

Apache-2.0
