/**
 * `zeph listener` — resident daemon that watches the user's Zeph feed
 * over a persistent WebSocket and injects matching messages into a
 * named tmux session via `tmux send-keys`.
 *
 * Solves the MCP polling-window problem: an `zeph_ask` polling cycle
 * times out (120–600 s) and the CC/Codex session becomes unaddressable
 * from the phone. The listener stays subscribed indefinitely and can
 * deliver to any named tmux session at any time.
 *
 * Wire format: any push whose body starts with `@<tmux-session>` followed
 * by whitespace and text is treated as an injection. Other pushes (hook
 * notifications, zeph_ask responses, etc.) are ignored. From the phone:
 *
 *   @zeph-myapp 리팩토링 마무리해줘
 *
 * Transport: WebSocket against the Zeph $connect endpoint with
 * `?apiKey=<key>`. The server fan-out pushes `{ type: 'push.new', data }`
 * messages as new pushes are created. Reconnects with exponential
 * backoff on transient failures; gives up on auth failures (4001/4002/4003).
 */

import { spawnSync } from 'child_process';
import { readdirSync, statSync } from 'fs';
import { homedir } from 'os';
import { join, basename } from 'path';
import WebSocket from 'ws';
import { loadConfig, resolvedEnv } from './config.js';

const PING_INTERVAL_MS = 25_000;
const PONG_TIMEOUT_MS = 10_000;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const RECONNECT_JITTER_RATIO = 0.15;

// How often the listener reports its tmux session inventory to the
// backend (in addition to immediately on $connect). Cheap; tmux runs
// locally and the payload is small.
const SESSION_REPORT_INTERVAL_MS = 30_000;

type AgentKind = 'claude' | 'codex' | 'gemini';
const AGENT_KINDS: readonly AgentKind[] = ['claude', 'codex', 'gemini'];

interface AgentSession {
    name: string;
    attached: boolean;
    agentKind: AgentKind;
    agentSessionId?: string | null;
    project: string;
    label?: string | null;
    createdAt?: string;
    lastActivityAt?: string;
}

// Per-session token bucket — caps a runaway/compromised sender. 30/min
// is generous for human-driven phone use, tight enough to block flooding.
const RATE_LIMIT_TOKENS = 30;
const RATE_LIMIT_WINDOW_MS = 60_000;

// Shells are refused: a shell prompt + send-keys = arbitrary command exec.
const SHELL_COMMANDS = new Set(['bash', 'zsh', 'fish', 'sh', 'dash', 'ksh', 'tcsh', 'csh', 'pwsh']);

// Auth-failure close codes: retrying with the same bad credentials hammers
// the server forever, so the listener exits instead.
const AUTH_FAILURE_CODES = new Set([4001, 4002, 4003]);

/** Decomposed injection directive. */
export interface ParsedInjection {
    session: string;
    text: string;
}

/**
 * Parse a push body. Null when the body is not an injection directive.
 * Shape: `@<session> <text>`. Session must be non-empty and shell-safe
 * (alphanumerics, dashes, underscores, dots). Text is everything after
 * the first whitespace run, trimmed.
 */
export const parseInjection = (body: string | undefined): ParsedInjection | null => {
    if (!body) return null;
    const m = body.match(/^@([A-Za-z0-9._-]+)\s+([\s\S]+)$/);
    if (!m) return null;
    const session = m[1];
    const text = m[2].trim();
    if (!session || !text) return null;
    return { session, text };
};

const buckets = new Map<string, { tokens: number; lastRefillAt: number }>();

export const checkRateLimit = (session: string, now: number = Date.now()): boolean => {
    const b = buckets.get(session) ?? { tokens: RATE_LIMIT_TOKENS, lastRefillAt: now };
    const elapsed = Math.max(0, now - b.lastRefillAt);
    const refilled = Math.min(
        RATE_LIMIT_TOKENS,
        b.tokens + (elapsed / RATE_LIMIT_WINDOW_MS) * RATE_LIMIT_TOKENS,
    );
    if (refilled < 1) {
        buckets.set(session, { tokens: refilled, lastRefillAt: now });
        return false;
    }
    buckets.set(session, { tokens: refilled - 1, lastRefillAt: now });
    return true;
};

/** Read the foreground command in the named tmux session's active pane. */
export const paneCurrentCommand = (session: string): string | null => {
    const result = spawnSync('tmux', ['display-message', '-p', '-t', session, '#{pane_current_command}'], {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (result.status !== 0) return null;
    return (result.stdout ?? '').trim() || null;
};

const isShellPane = (command: string | null): boolean => {
    if (!command) return false;
    return SHELL_COMMANDS.has(command);
};

/**
 * Inject text into a tmux session: literal text via `-l`, then a
 * separate `Enter`. `-l` takes the text as data, so tmux escape
 * sequences inside the message can't drive other tmux commands.
 */
const injectKeys = (session: string, text: string): boolean => {
    const a = spawnSync('tmux', ['send-keys', '-l', '-t', session, text], { stdio: ['ignore', 'ignore', 'pipe'] });
    if (a.status !== 0) return false;
    const b = spawnSync('tmux', ['send-keys', '-t', session, 'Enter'], { stdio: ['ignore', 'ignore', 'pipe'] });
    return b.status === 0;
};

const stamp = (): string => new Date().toISOString().slice(11, 19);
const log = (msg: string): void => console.log(`[${stamp()}] ${msg}`);

// ─── Session inventory ──────────────────────────────────────────────

/**
 * Parse a `zeph-*` tmux session name into `{project, label}`. For
 * Phase 1 the wrapper only emits `zeph-<project>` (no labels), so the
 * whole tail becomes the project. When labels land in Phase 2 the
 * wrapper will sidecar `{project, label}` so the listener doesn't need
 * to guess from a name that allows dashes in project names.
 */
export const parseSessionName = (name: string): { project: string; label: string | null } | null => {
    if (!name.startsWith('zeph-')) return null;
    const rest = name.slice('zeph-'.length);
    if (!rest) return null;
    return { project: rest, label: null };
};

const CLAUDE_PROJECTS_DIR = join(homedir(), '.claude', 'projects');

/**
 * Locate the most recent Claude Code session UUID for the working
 * directory of a tmux pane. Mirrors `mcp-server/config.ts`'s
 * detectClaudeSessionId: CC writes per-session jsonl files at
 * `~/.claude/projects/<projectHash>/<UUID>.jsonl` where the hash is
 * the cwd with `/` replaced by `-`.
 */
export const detectClaudeSessionId = (cwd: string): string | null => {
    try {
        const projectHash = cwd.replace(/\//g, '-');
        const sessionsDir = join(CLAUDE_PROJECTS_DIR, projectHash);
        let latest: { name: string; mtime: number } | undefined;
        for (const entry of readdirSync(sessionsDir)) {
            const m = entry.match(/^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/);
            if (!m) continue;
            const stat = statSync(join(sessionsDir, entry));
            if (!stat.isFile()) continue;
            if (!latest || stat.mtimeMs > latest.mtime) {
                latest = { name: m[1], mtime: stat.mtimeMs };
            }
        }
        return latest?.name ?? null;
    } catch {
        return null;
    }
};

interface PaneInfo {
    currentCommand: string | null;
    startCommand: string | null;
    currentPath: string | null;
}

const readPaneInfo = (session: string): PaneInfo => {
    const r = spawnSync('tmux', ['display-message', '-p', '-t', session,
        '#{pane_current_command}|#{pane_start_command}|#{pane_current_path}'], {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (r.status !== 0) return { currentCommand: null, startCommand: null, currentPath: null };
    const [current, start, path] = (r.stdout ?? '').trim().split('|');
    return {
        currentCommand: current || null,
        startCommand: start || null,
        currentPath: path || null,
    };
};

/**
 * Identify the agent type from the tmux pane's start command. We rely
 * on start_command rather than current_command because the foreground
 * process under `claude` is often `node` (the interpreter), which
 * doesn't tell us what was actually launched.
 */
const detectAgentKind = (info: PaneInfo): AgentKind | null => {
    const start = info.startCommand;
    if (!start) return null;
    // First token, basename — `/usr/local/bin/claude --foo` → `claude`.
    const startBase = basename(start.split(/\s+/)[0] || '');
    for (const k of AGENT_KINDS) {
        if (startBase === k) return k;
    }
    return null;
};

const epochToIso = (epoch: string | undefined): string | undefined => {
    if (!epoch) return undefined;
    const n = Number(epoch);
    if (!Number.isFinite(n) || n <= 0) return undefined;
    return new Date(n * 1000).toISOString();
};

/**
 * Snapshot the live `zeph-*` tmux sessions on this machine, enriched
 * with the running agent kind, CC session UUID (claude only), project,
 * and tmux activity timestamps. Returns [] when tmux is unreachable
 * or no agent sessions exist. Sessions whose pane is at a shell or
 * running something other than claude/codex/gemini are filtered out
 * — the phone can't usefully address them.
 */
export const collectSessions = (): AgentSession[] => {
    const list = spawnSync('tmux', ['list-sessions', '-F',
        '#{session_name}|#{session_attached}|#{session_created}|#{session_activity}'], {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (list.status !== 0) return [];

    const result: AgentSession[] = [];
    for (const line of (list.stdout ?? '').split('\n')) {
        if (!line) continue;
        const [name, attached, created, activity] = line.split('|');
        const parsed = parseSessionName(name);
        if (!parsed) continue;
        const info = readPaneInfo(name);
        const agentKind = detectAgentKind(info);
        if (!agentKind) continue;
        const agentSessionId = agentKind === 'claude' && info.currentPath
            ? detectClaudeSessionId(info.currentPath)
            : null;
        result.push({
            name,
            attached: attached === '1',
            agentKind,
            agentSessionId,
            project: parsed.project,
            label: parsed.label,
            createdAt: epochToIso(created),
            lastActivityAt: epochToIso(activity),
        });
    }
    return result;
};

// ─── Push handling ──────────────────────────────────────────────────

interface PushItem {
    pushId: string;
    type?: string;
    body?: string;
    title?: string;
    createdAt?: string;
    isEncrypted?: boolean;
    /** Set when type='agent.command' — tmux session name to inject into. */
    agentSessionName?: string;
}

interface HandlePushDeps {
    paneCommand?: (session: string) => string | null;
    inject?: (session: string, text: string) => boolean;
    rateLimit?: (session: string) => boolean;
    now?: () => number;
}

/**
 * Shared inject path: pane guard → rate limit → tmux send-keys. Both
 * the structured `agent.command` push type and the legacy `@<session>`
 * prefix path route through here so the defense layers can't diverge.
 */
const tryInject = (session: string, text: string, deps: HandlePushDeps): boolean => {
    if (!text) {
        log(`! ${session}: empty text — drop`);
        return false;
    }
    const cmd = (deps.paneCommand ?? paneCurrentCommand)(session);
    if (cmd === null) {
        log(`! ${session}: no such tmux session — drop`);
        return false;
    }
    if (isShellPane(cmd)) {
        log(`! ${session}: pane is at shell (${cmd}) — refusing (would be RCE)`);
        return false;
    }
    const allowed = (deps.rateLimit ?? checkRateLimit)(session);
    if (!allowed) {
        log(`! ${session}: rate-limited — drop`);
        return false;
    }
    const ok = (deps.inject ?? injectKeys)(session, text);
    const preview = text.length > 60 ? text.slice(0, 60) + '…' : text;
    log(`${ok ? '→' : '✗'} ${session}: ${preview}`);
    return ok;
};

/**
 * Process one push. Returns true when an injection actually fired.
 * Exported for unit testing with mocked deps.
 *
 * Routing:
 *   - `type='agent.command'` with `agentSessionName` — preferred path,
 *     structured fields from the phone's "AI Agent에게 명령" sheet.
 *   - `@<session> <text>` body prefix — legacy/manual path; still
 *     supported for curl-style ad-hoc sends and debugging.
 *   - Everything else (Stop-hook auto-pushes, zeph_ask responses,
 *     encrypted pushes) is ignored.
 */
export const handlePush = (
    push: PushItem,
    deps: HandlePushDeps = {},
): boolean => {
    if (push.isEncrypted) {
        // Per-device keys aren't wired yet; encrypted pushes are opaque
        // to the listener. Stop-hook and zeph_ask pushes are not part of
        // the injection paths so this is fine for now.
        return false;
    }

    // Structured path — preferred.
    if (push.type === 'agent.command' && push.agentSessionName) {
        return tryInject(push.agentSessionName, push.body ?? '', deps);
    }

    // Legacy `@<session> <text>` prefix in body.
    const parsed = parseInjection(push.body);
    if (!parsed) return false;
    return tryInject(parsed.session, parsed.text, deps);
};

// ─── WS connect loop ─────────────────────────────────────────────────

const verifyTmux = (): void => {
    const r = spawnSync('tmux', ['-V'], { stdio: ['ignore', 'pipe', 'ignore'] });
    if (r.status !== 0) {
        console.error('zeph listener: tmux not found on PATH. Install tmux first.');
        process.exit(127);
    }
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const computeBackoff = (attempt: number): number => {
    const base = Math.min(RECONNECT_BASE_MS * Math.pow(2, attempt), RECONNECT_MAX_MS);
    const jitter = base * RECONNECT_JITTER_RATIO * (Math.random() * 2 - 1);
    return Math.max(0, base + jitter);
};

interface SessionResult {
    /** Resolved with the close code if the server closed cleanly. */
    closeCode: number | null;
    /** Resolved with reason text for logging. */
    reason: string;
}

/**
 * Open one WebSocket and stream messages until it closes. Resolves when
 * the connection is gone; the outer loop decides whether to reconnect.
 */
const streamSession = (wsUrl: string, apiKey: string): Promise<SessionResult> =>
    new Promise<SessionResult>((resolve) => {
        const url = `${wsUrl}?apiKey=${encodeURIComponent(apiKey)}`;
        const ws = new WebSocket(url);

        let pingTimer: NodeJS.Timeout | null = null;
        let pongTimer: NodeJS.Timeout | null = null;
        let sessionsTimer: NodeJS.Timeout | null = null;

        const cleanup = (): void => {
            if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
            if (pongTimer) { clearTimeout(pongTimer); pongTimer = null; }
            if (sessionsTimer) { clearInterval(sessionsTimer); sessionsTimer = null; }
        };

        const reportSessions = (): void => {
            if (ws.readyState !== WebSocket.OPEN) return;
            const sessions = collectSessions();
            ws.send(JSON.stringify({ type: 'listener.sessions', data: { sessions } }));
        };

        ws.on('open', () => {
            log('connected');
            // Initial inventory so the phone's picker has something to
            // show as soon as the listener comes online.
            reportSessions();
            sessionsTimer = setInterval(reportSessions, SESSION_REPORT_INTERVAL_MS);

            pingTimer = setInterval(() => {
                if (ws.readyState !== WebSocket.OPEN) return;
                ws.send(JSON.stringify({ type: 'ping' }));
                pongTimer = setTimeout(() => {
                    log('! pong timeout — forcing reconnect');
                    ws.terminate();
                }, PONG_TIMEOUT_MS);
            }, PING_INTERVAL_MS);
        });

        ws.on('message', (raw) => {
            if (pongTimer) { clearTimeout(pongTimer); pongTimer = null; }
            let msg: unknown;
            try {
                msg = JSON.parse(raw.toString('utf-8'));
            } catch {
                return; // malformed — ignore
            }
            if (!msg || typeof msg !== 'object') return;
            const m = msg as { type?: string; data?: PushItem };
            if (m.type === 'pong') return;
            if (m.type === 'push.new' && m.data) handlePush(m.data);
            // `push.sync` (offline batch on $connect) and other types ignored.
        });

        ws.on('error', (err) => {
            log(`! ws error: ${err.message}`);
        });

        ws.on('close', (code, reasonBuf) => {
            cleanup();
            resolve({ closeCode: code, reason: reasonBuf.toString('utf-8') });
        });
    });

const resolveWsUrl = (args: Record<string, string | boolean>, config: { wsUrl?: string }): string | null => {
    const fromArg = typeof args['ws-url'] === 'string' ? (args['ws-url'] as string) : null;
    return fromArg || resolvedEnv('ZEPH_WS_URL') || config.wsUrl || null;
};

export const handleListener = async (args: Record<string, string | boolean>): Promise<number> => {
    verifyTmux();

    const config = loadConfig();
    const apiKey = (args.key as string) || resolvedEnv('ZEPH_API_KEY') || config.apiKey;
    if (!apiKey) {
        console.error('zeph listener: API key required. Run `zeph install` or set ZEPH_API_KEY.');
        return 3;
    }
    const wsUrl = resolveWsUrl(args, config);
    if (!wsUrl) {
        console.error(
            'zeph listener: WebSocket URL not set. Either:\n' +
            '  • add "wsUrl": "wss://..." to ~/.zeph/config.json\n' +
            '  • export ZEPH_WS_URL=wss://...\n' +
            '  • pass --ws-url wss://...',
        );
        return 1;
    }

    log(`zeph listener starting — ${wsUrl}`);
    log('Waiting for `@<tmux-session> <text>` pushes. Ctrl-C to stop.');

    let shuttingDown = false;
    const stop = (sig: string): void => {
        if (shuttingDown) return;
        shuttingDown = true;
        log(`received ${sig}, stopping`);
    };
    process.on('SIGINT', () => stop('SIGINT'));
    process.on('SIGTERM', () => stop('SIGTERM'));

    let attempt = 0;
    while (!shuttingDown) {
        const result = await streamSession(wsUrl, apiKey);

        if (AUTH_FAILURE_CODES.has(result.closeCode ?? -1)) {
            console.error(`zeph listener: auth failure (${result.closeCode} ${result.reason}). Check API key.`);
            return 3;
        }

        if (shuttingDown) break;

        const delay = computeBackoff(attempt);
        log(`disconnected (code=${result.closeCode}) — reconnect in ${Math.round(delay / 1000)}s`);
        await sleep(delay);
        attempt = Math.min(attempt + 1, 10);
    }

    return 0;
};
