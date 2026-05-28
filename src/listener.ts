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
 * Wire format: pushes with `type='agent.command'` carry the tmux
 * session name in `agentSessionName` and the message in `body`. The
 * "AI Agent에게 명령" sheet on the phone builds these structured
 * pushes from the listener-reported session inventory. Other push
 * types (Stop-hook auto-pushes, zeph_ask responses, channel
 * broadcasts) are ignored.
 *
 * Transport: WebSocket against the Zeph $connect endpoint with
 * `?apiKey=<key>`. The server fan-out pushes `{ type: 'push.new', data }`
 * messages as new pushes are created. Reconnects with exponential
 * backoff on transient failures; gives up on auth failures (4001/4002/4003).
 */

import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import { readdirSync, statSync } from 'fs';
import { homedir, hostname } from 'os';
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

const buckets = new Map<string, { tokens: number; lastRefillAt: number }>();

// Evict idle buckets older than this so the Map can't grow without bound
// under attack. Two refill windows past full refill = bucket is at cap
// anyway and recreating it on next hit is free.
const BUCKET_IDLE_TTL_MS = RATE_LIMIT_WINDOW_MS * 2;

const pruneStaleBuckets = (now: number): void => {
    for (const [key, b] of buckets) {
        if (now - b.lastRefillAt > BUCKET_IDLE_TTL_MS) buckets.delete(key);
    }
};

export const checkRateLimit = (session: string, now: number = Date.now()): boolean => {
    pruneStaleBuckets(now);
    const b = buckets.get(session) ?? { tokens: RATE_LIMIT_TOKENS, lastRefillAt: now };
    const elapsed = Math.max(0, now - b.lastRefillAt);
    // Fractional refill is intentional: smooths the boundary so a session
    // hitting the cap doesn't have to wait a full window for the next slot.
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

// ASCII Unit Separator (US, 0x1f) — won't appear in command lines or
// filesystem paths, so we can split the tmux output unambiguously.
const FIELD_SEP = '\x1f';

const readPaneInfo = (session: string): PaneInfo => {
    const r = spawnSync('tmux', ['display-message', '-p', '-t', session,
        `#{pane_current_command}${FIELD_SEP}#{pane_start_command}${FIELD_SEP}#{pane_current_path}`], {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (r.status !== 0) return { currentCommand: null, startCommand: null, currentPath: null };
    const parts = (r.stdout ?? '').trim().split(FIELD_SEP);
    if (parts.length !== 3) return { currentCommand: null, startCommand: null, currentPath: null };
    const [current, start, path] = parts;
    return {
        currentCommand: current || null,
        startCommand: start || null,
        currentPath: path || null,
    };
};

const firstTokenBasename = (cmd: string | null): string => {
    if (!cmd) return '';
    return basename(cmd.split(/\s+/)[0] || '');
};

/**
 * Identify the agent type from the tmux pane. Prefer `pane_start_command`
 * because the foreground process is usually `node`/`python3` (the
 * interpreter), which doesn't tell us *what* was launched. Fall back to
 * `pane_current_command` when start_command is empty — tmux clears
 * start_command in some re-attach cases, especially when a pre-existing
 * session was joined via `tmux new -A` instead of being created fresh.
 * That fallback is safe because we only accept literal `claude` /
 * `codex` / `gemini` as a match.
 */
const detectAgentKind = (info: PaneInfo): AgentKind | null => {
    const startBase = firstTokenBasename(info.startCommand);
    for (const k of AGENT_KINDS) {
        if (startBase === k) return k;
    }
    const currentBase = firstTokenBasename(info.currentCommand);
    for (const k of AGENT_KINDS) {
        if (currentBase === k) return k;
    }
    return null;
};

const epochToIso = (epoch: string | undefined): string | undefined => {
    if (!epoch) return undefined;
    const n = Number(epoch);
    if (!Number.isFinite(n) || n <= 0) return undefined;
    return new Date(n * 1000).toISOString();
};

export interface CollectResult {
    sessions: AgentSession[];
    /** Diagnostic notes per rejected session — surfaced under `--verbose`. */
    rejected: Array<{ name: string; reason: string }>;
}

/**
 * Inventory pass that also records *why* each `zeph-*` session was
 * skipped. The verbose log uses the rejection notes to explain empty
 * pickers (most common cause: tmux pane lost its start_command after a
 * re-attach, and the current command is `node` rather than `claude`).
 */
export const collectSessionsVerbose = (): CollectResult => {
    const list = spawnSync('tmux', ['list-sessions', '-F',
        `#{session_name}${FIELD_SEP}#{session_attached}${FIELD_SEP}#{session_created}${FIELD_SEP}#{session_activity}`], {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (list.status !== 0) return { sessions: [], rejected: [] };

    const sessions: AgentSession[] = [];
    const rejected: Array<{ name: string; reason: string }> = [];
    for (const line of (list.stdout ?? '').split('\n')) {
        if (!line) continue;
        const [name, attached, created, activity] = line.split(FIELD_SEP);
        const parsed = parseSessionName(name);
        if (!parsed) {
            // Not noisy enough to log every plain tmux session here —
            // would clutter the verbose output on machines with many
            // non-zeph sessions.
            continue;
        }
        const info = readPaneInfo(name);
        const agentKind = detectAgentKind(info);
        if (!agentKind) {
            rejected.push({
                name,
                reason: `no agent in pane (start=${info.startCommand ?? 'null'}, current=${info.currentCommand ?? 'null'})`,
            });
            continue;
        }
        const agentSessionId = agentKind === 'claude' && info.currentPath
            ? detectClaudeSessionId(info.currentPath)
            : null;
        sessions.push({
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
    return { sessions, rejected };
};

/**
 * Snapshot the live `zeph-*` tmux sessions on this machine, enriched
 * with the running agent kind, CC session UUID (claude only), project,
 * and tmux activity timestamps. Returns [] when tmux is unreachable
 * or no agent sessions exist. Sessions whose pane is at a shell or
 * running something other than claude/codex/gemini are filtered out
 * — the phone can't usefully address them.
 */
export const collectSessions = (): AgentSession[] => collectSessionsVerbose().sessions;

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
 * Only acts on `type='agent.command'` pushes carrying both an
 * `agentSessionName` (tmux session to inject into) and a non-empty
 * `body`. Everything else (Stop-hook auto-pushes, zeph_ask responses,
 * encrypted pushes, normal text/link/file notifications) is ignored.
 */
export const handlePush = (
    push: PushItem,
    deps: HandlePushDeps = {},
): boolean => {
    if (push.isEncrypted) {
        // Per-device keys aren't wired yet; encrypted pushes are opaque
        // to the listener.
        return false;
    }
    if (push.type !== 'agent.command' || !push.agentSessionName) return false;
    return tryInject(push.agentSessionName, push.body ?? '', deps);
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
 * Stable per-host device id for the listener. We hash the OS hostname so
 * the same machine reuses the same DeviceRecord across listener restarts
 * (otherwise the phone's session inventory grows a new ghost device every
 * time `zeph listener` rebinds). `dev_listener_<sha8(hostname)>` keeps it
 * human-recognisable in dev logs without leaking the raw hostname.
 */
export const computeListenerDeviceId = (host: string = hostname()): string => {
    const h = createHash('sha256').update(host).digest('hex').slice(0, 8);
    return `dev_listener_${h}`;
};

interface StreamHandle {
    done: Promise<SessionResult>;
    terminate: () => void;
}

/**
 * Open one WebSocket and stream messages until it closes. `done` resolves
 * when the connection is gone; the outer loop decides whether to reconnect.
 * `terminate` lets a signal handler force-close from outside (otherwise
 * SIGINT during an open WS would hang the loop until the server closed).
 */
const streamSession = (wsUrl: string, apiKey: string): StreamHandle => {
    let ws: WebSocket | null = null;
    const done = new Promise<SessionResult>((resolve) => {
        // deviceId + listenerNickname let the backend attach the connection
        // to a DeviceRecord (auto-created on first connect for apiKey auth).
        // Without these the `listener.sessions` reports are silently dropped
        // server-side and the phone's picker stays empty.
        const deviceId = computeListenerDeviceId();
        const nickname = hostname() || 'listener';
        const params = new URLSearchParams({
            apiKey,
            deviceId,
            listenerNickname: nickname,
        });
        const url = `${wsUrl}?${params.toString()}`;
        ws = new WebSocket(url);
        const sock = ws;

        let pingTimer: NodeJS.Timeout | null = null;
        let pongTimer: NodeJS.Timeout | null = null;
        let sessionsTimer: NodeJS.Timeout | null = null;

        const cleanup = (): void => {
            if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
            if (pongTimer) { clearTimeout(pongTimer); pongTimer = null; }
            if (sessionsTimer) { clearInterval(sessionsTimer); sessionsTimer = null; }
        };

        const reportSessions = (): void => {
            if (sock.readyState !== WebSocket.OPEN) return;
            const { sessions, rejected } = collectSessionsVerbose();
            sock.send(JSON.stringify({ type: 'listener.sessions', data: { sessions } }));
            // One line per cycle gives the user immediate feedback on
            // what the phone picker will see — particularly important
            // during setup, when an empty picker has no other observable
            // cause.
            const names = sessions.map((s) => s.name).join(', ') || '∅';
            log(`reported ${sessions.length} session(s): ${names}`);
            // Explain skipped zeph-* sessions so the most common
            // confusion (pane lost its claude start_command after a
            // re-attach) shows up directly in the log.
            for (const r of rejected) log(`  skip ${r.name}: ${r.reason}`);
        };

        sock.on('open', () => {
            log('connected');
            // Initial inventory so the phone's picker has something to
            // show as soon as the listener comes online.
            reportSessions();
            sessionsTimer = setInterval(reportSessions, SESSION_REPORT_INTERVAL_MS);

            pingTimer = setInterval(() => {
                if (sock.readyState !== WebSocket.OPEN) return;
                sock.send(JSON.stringify({ type: 'ping' }));
                pongTimer = setTimeout(() => {
                    log('! pong timeout — forcing reconnect');
                    sock.terminate();
                }, PONG_TIMEOUT_MS);
            }, PING_INTERVAL_MS);
        });

        sock.on('message', (raw) => {
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

        sock.on('error', (err) => {
            log(`! ws error: ${err.message}`);
        });

        sock.on('close', (code, reasonBuf) => {
            cleanup();
            resolve({ closeCode: code, reason: reasonBuf?.toString('utf-8') ?? '' });
        });
    });

    return {
        done,
        terminate: () => { ws?.terminate(); },
    };
};

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
    log(`device=${computeListenerDeviceId()} host=${hostname()}`);
    log("Waiting for 'agent.command' pushes from the phone picker. Ctrl-C to stop.");

    let shuttingDown = false;
    let activeHandle: StreamHandle | null = null;
    const stop = (sig: string): void => {
        if (shuttingDown) return;
        shuttingDown = true;
        log(`received ${sig}, stopping`);
        // Force-close any open WS so the streamSession promise resolves
        // immediately instead of waiting for the server to drop us.
        activeHandle?.terminate();
    };
    process.on('SIGINT', () => stop('SIGINT'));
    process.on('SIGTERM', () => stop('SIGTERM'));

    let attempt = 0;
    while (!shuttingDown) {
        activeHandle = streamSession(wsUrl, apiKey);
        const result = await activeHandle.done;
        activeHandle = null;

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
