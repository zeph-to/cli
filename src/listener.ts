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
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'fs';
import { homedir, hostname, userInfo } from 'os';
import { join, basename } from 'path';
import WebSocket from 'ws';
import { loadConfig, resolvedEnv } from './config.js';

const PING_INTERVAL_MS = 25_000;
const PONG_TIMEOUT_MS = 10_000;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const RECONNECT_JITTER_RATIO = 0.15;

// Hard ceiling on WebSocket connection open time. `ws` has no default
// timeout; without this an unreachable backend (NAT drop, suspended
// laptop network) can hang forever in CONNECTING state and the listener
// quietly stops reporting.
const WS_CONNECT_TIMEOUT_MS = 20_000;

// If no successful round-trip (server-persisted ack) is observed within
// this window, the socket is presumed half-open — TCP says alive but the
// peer never replies. macOS App Nap / Wi-Fi handoff / VPN flap all
// surface this way. Force-terminate so the reconnect loop runs.
const WS_STALL_TIMEOUT_MS = 90_000;

// How often the listener reports its tmux session inventory to the
// backend (in addition to immediately on $connect). Cheap — tmux runs
// locally, the payload is small, and the user expects the phone picker
// to reflect new `zeph cc` sessions within a few seconds, not half a
// minute.
const SESSION_REPORT_INTERVAL_MS = 5_000;

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
    const result = spawnSync('tmux', tmuxArgs(['display-message', '-p', '-t', session, '#{pane_current_command}']), {
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
    const a = spawnSync('tmux', tmuxArgs(['send-keys', '-l', '-t', session, text]), { stdio: ['ignore', 'ignore', 'pipe'] });
    if (a.status !== 0) return false;
    const b = spawnSync('tmux', tmuxArgs(['send-keys', '-t', session, 'Enter']), { stdio: ['ignore', 'ignore', 'pipe'] });
    return b.status === 0;
};

const stamp = (): string => new Date().toISOString().slice(11, 19);
const log = (msg: string): void => console.log(`[${stamp()}] ${msg}`);

// ─── tmux socket discovery ──────────────────────────────────────────

/**
 * macOS sets a per-user `TMPDIR` like `/var/folders/xz/.../T/`, and tmux
 * (started from a regular shell there) lays its socket at
 * `<TMPDIR>/tmux-<uid>/default`. When the listener is spawned from a
 * shell with a different TMPDIR — or no TMPDIR at all (cron, launchd,
 * IDE-managed terminals) — tmux defaults to `/tmp/tmux-<uid>/default`
 * and the user's real server is invisible. We probe a small list of
 * common locations and use `-S <path>` for every subsequent tmux call
 * once a live server is found.
 *
 * Caching is one-way: a successful discovery sticks for the process
 * lifetime, but failure does NOT — we re-probe every cycle so the
 * listener picks up a tmux server that gets started AFTER the listener
 * itself (very common: the user opens `zeph cc` after starting the
 * daemon). If tmux dies and respawns under a different path the user
 * has to restart the listener (rare).
 */
let cachedSocketPath: string | null = null;
/** True once we've confirmed a working socket. `cachedSocketPath` of
 *  `null` is ambiguous on its own — it can mean either "use default
 *  (we verified it works)" or "we haven't checked yet". This flag
 *  removes the ambiguity so we don't re-probe every collectSessions
 *  cycle (which was spamming the log with "tmux: default socket OK"). */
let cacheValid = false;

/**
 * Mark the cached socket as no longer trustworthy — call this when a
 * tmux command fails against the cached path. The next findTmuxSocket()
 * will redo full discovery (default probe → /var/folders walk → lsof
 * fallback) instead of returning a stale answer. Without this the
 * listener wedged at "reported 0 session(s)" forever after a tmux
 * server restart, even when a new server was live and discoverable.
 */
export const invalidateTmuxSocketCache = (): void => {
    cacheValid = false;
    cachedSocketPath = null;
};

interface ProbeResult {
    ok: boolean;
    stderr?: string;
}

const probeTmuxSocketDetail = (socketPath: string | null): ProbeResult => {
    const args = socketPath ? ['-S', socketPath, 'list-sessions'] : ['list-sessions'];
    const r = spawnSync('tmux', args, {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (r.status === 0) return { ok: true };
    const err = ((r.stderr ?? '') as string).trim();
    return { ok: false, stderr: err || undefined };
};

const probeTmuxSocket = (socketPath: string | null): boolean =>
    probeTmuxSocketDetail(socketPath).ok;

/**
 * List every socket file inside a `tmux-<uid>/` directory. tmux's
 * default socket name is `default`, but users can change it with
 * `tmux -L <name>` or via .tmux.conf — so we probe every file we find,
 * not just `default`. Returns absolute socket paths.
 */
const listSocketsIn = (dir: string): string[] => {
    if (!existsSync(dir)) return [];
    try { return readdirSync(dir).map((name) => `${dir}/${name}`); }
    catch { return []; }
};

/**
 * Final-fallback socket discovery: find tmux server processes via `ps`
 * and ask `lsof` what unix socket each is bound to. Handles the cases
 * filesystem walking can't:
 *   - macOS auto-cleanup deleted the socket file while the server kept
 *     running (the most likely cause of "no server running" errors when
 *     a tmux session is clearly alive in another iTerm/Warp pane)
 *   - The user runs tmux with `-L <name>` or `-S <unusual-path>` that we
 *     never thought to enumerate
 *
 * `lsof` on macOS may report sockets as `(deleted)`. Even then, if the
 * server still has the inode open we can still tmux-attach by recreating
 * the path — but for now we only return paths that still exist on disk
 * so tmux's connect logic isn't confused. If the path is gone, the user
 * has to `tmux kill-server` + restart anyway.
 */
const findTmuxViaProcess = (): string[] => {
    const username = userInfo().username;
    const ps = spawnSync('ps', ['-A', '-o', 'pid=,user=,command='], {
        encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (ps.status !== 0) return [];

    const tmuxPids: string[] = [];
    for (const line of (ps.stdout ?? '').split('\n')) {
        const m = line.match(/^\s*(\d+)\s+(\S+)\s+(.+)$/);
        if (!m) continue;
        const [, pid, user, cmd] = m;
        if (user !== username) continue;
        // Server processes show up as `tmux: server` (with the colon) on
        // some versions; client/wrapper invocations show up as `tmux new`
        // / `tmux attach` etc. lsof works on either.
        if (!/(^|[^\w-])tmux($|[:\s])/.test(cmd)) continue;
        tmuxPids.push(pid);
    }
    if (tmuxPids.length === 0) return [];

    const found = new Set<string>();
    for (const pid of tmuxPids) {
        const lsof = spawnSync('lsof', ['-p', pid, '-Fn'], {
            encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'],
        });
        if (lsof.status !== 0) continue;
        // `-Fn` prints names prefixed with `n`; one per line. Filter for
        // tmux-shaped socket paths.
        for (const lline of (lsof.stdout ?? '').split('\n')) {
            if (!lline.startsWith('n')) continue;
            const path = lline.slice(1);
            if (!/\/tmux-\d+\//.test(path)) continue;
            if (path.endsWith(' (deleted)') || path.includes('(deleted)')) continue;
            if (existsSync(path)) found.add(path);
        }
    }
    return [...found];
};

/** Walk `/var/folders` for user-owned `tmux-<uid>/*` socket files. Each
 * subdir is wrapped in its own try/catch — entries that belong to other
 * users (or that we otherwise can't read) must skip cleanly, not abort
 * the whole walk. */
const walkVarFolders = (uid: number): string[] => {
    const found: string[] = [];
    const root = '/var/folders';
    if (!existsSync(root)) return found;
    let topEntries: string[];
    try { topEntries = readdirSync(root); } catch { return found; }
    for (const a of topEntries) {
        const aPath = `${root}/${a}`;
        let subEntries: string[];
        try { subEntries = readdirSync(aPath); } catch { continue; }
        for (const b of subEntries) {
            found.push(...listSocketsIn(`${aPath}/${b}/T/tmux-${uid}`));
        }
    }
    return found;
};

/**
 * Track whether the "no server anywhere" diagnostic was already logged
 * this run. We want the user to see the path list *once* on first
 * failure, then go quiet until we either find a server or notice a new
 * candidate file appearing — otherwise every 30-s cycle would spam the
 * full probe report.
 */
let warnedNoServer = false;

const findTmuxSocket = (): string | null => {
    // Successful discovery sticks. Failure does NOT — we want to pick
    // up a tmux server that the user launches *after* `zeph listener`.
    if (cacheValid) return cachedSocketPath;

    // Explicit override — for users with `tmux -L <name>` setups or
    // unusual socket locations. Skip discovery entirely if set and
    // probeable.
    const override = process.env.ZEPH_TMUX_SOCKET;
    if (override) {
        if (probeTmuxSocket(override)) {
            cachedSocketPath = override;
            cacheValid = true;
            log(`tmux socket → ${override} (from ZEPH_TMUX_SOCKET)`);
            warnedNoServer = false;
            return override;
        }
        // Fall through to standard discovery if override fails — better
        // than failing silently. We re-log this every cycle (no
        // `warnedNoServer`) because it's a user-supplied setting we want
        // to keep nagging about.
        log(`tmux: ZEPH_TMUX_SOCKET=${override} probe failed, falling back to auto-discovery`);
    }

    const uid = userInfo().uid;
    const candidates: string[] = [];

    // Process-based discovery first — it's the only path that handles
    // stale-socket-file cases (macOS /tmp cleanup) and unusual socket
    // locations the heuristic walks would miss.
    candidates.push(...findTmuxViaProcess());

    // Include every socket file we find in any `tmux-<uid>/` dir — the
    // user might have `-L <name>` configured rather than the default
    // socket name.
    const envDir = process.env.TMUX_TMPDIR || process.env.TMPDIR;
    if (envDir) candidates.push(...listSocketsIn(`${envDir.replace(/\/+$/, '')}/tmux-${uid}`));
    candidates.push(...walkVarFolders(uid));
    candidates.push(...listSocketsIn(`/tmp/tmux-${uid}`));
    candidates.push(...listSocketsIn(`/private/tmp/tmux-${uid}`));

    const seen = new Set<string>();
    const unique = candidates.filter((p) => (seen.has(p) ? false : (seen.add(p), true)));

    // Default first — succeeds when the shell that launched us shares
    // tmux's view. We deliberately don't cache this success; on the
    // first call though it's enough.
    if (probeTmuxSocket(null)) {
        cachedSocketPath = null; // null means "use default"
        cacheValid = true;
        if (!warnedNoServer) log('tmux: default socket OK');
        warnedNoServer = false;
        return null;
    }

    for (const path of unique) {
        if (!existsSync(path)) continue;
        if (probeTmuxSocket(path)) {
            cachedSocketPath = path;
            cacheValid = true;
            log(`tmux socket → ${path}`);
            warnedNoServer = false;
            return path;
        }
    }

    // No live tmux yet. Log the full probe report once, then stay quiet
    // until something works — otherwise the user gets a 4-line dump
    // every 30 seconds while they're still bringing tmux up. Include the
    // tmux binary identification + stderr for failed probes so the user
    // can spot version mismatches (homebrew on /usr/local vs /opt/homebrew)
    // or stale socket files.
    if (!warnedNoServer) {
        const which = spawnSync('which', ['tmux'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
        const tmuxPath = (which.stdout ?? '').trim() || '(not on PATH)';
        const ver = spawnSync('tmux', ['-V'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
        const tmuxVer = (ver.stdout ?? '').trim() || '?';
        log(`tmux: no live server yet — using ${tmuxPath} (${tmuxVer})`);
        log(`tmux: probed ${unique.length} candidate(s):`);
        for (const path of unique) {
            if (!existsSync(path)) {
                log(`  - ${path}  (no socket file)`);
                continue;
            }
            const detail = probeTmuxSocketDetail(path);
            log(`  ✗ ${path}  (${detail.stderr ?? 'probe failed without stderr'})`);
        }
        log(`tmux: will retry each cycle. If your tmux uses a custom socket,`);
        log(`     run \`tmux info | head -1\` in the same shell as 'zeph cc'`);
        log(`     and pass it via:  ZEPH_TMUX_SOCKET=<path> zeph listener`);
        warnedNoServer = true;
    }
    return null;
};

/** Prepend `-S <socket>` when we've discovered a non-default tmux server. */
const tmuxArgs = (args: string[]): string[] => {
    const sock = findTmuxSocket();
    return sock ? ['-S', sock, ...args] : args;
};

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
 * Cache for detectClaudeSessionId. The function walks every jsonl file
 * in `~/.claude/projects/<hash>/` on each call — after weeks of CC use
 * that directory holds hundreds of session files, and we were calling
 * this per tmux session per 5-second report cycle. Heavy disk I/O
 * compounded with multiple sessions caused the report cycle to spike
 * CPU and starve the host shell.
 *
 * The current-session UUID only changes when a new CC session starts
 * in that directory (rare, on the order of hours), so a 60-second TTL
 * is safe and cuts the per-cycle stat count by ~12×.
 */
const claudeSessionCache = new Map<string, { sessionId: string | null; expiresAt: number }>();
const CLAUDE_SESSION_CACHE_TTL_MS = 60_000;

const doDetectClaudeSessionId = (cwd: string): string | null => {
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

/**
 * Locate the most recent Claude Code session UUID for the working
 * directory of a tmux pane. Mirrors `mcp-server/config.ts`'s
 * detectClaudeSessionId: CC writes per-session jsonl files at
 * `~/.claude/projects/<projectHash>/<UUID>.jsonl` where the hash is
 * the cwd with `/` replaced by `-`. Cached for 60s — see
 * claudeSessionCache.
 */
export const detectClaudeSessionId = (cwd: string): string | null => {
    const now = Date.now();
    const cached = claudeSessionCache.get(cwd);
    if (cached && cached.expiresAt > now) return cached.sessionId;

    // Cap cache size so a long-lived listener that's seen many cwds
    // doesn't grow unbounded. 64 is plenty for any realistic setup.
    if (claudeSessionCache.size >= 64) {
        // Evict the oldest-expiring entry — Map iteration order is
        // insertion order, so the first key we hit is the oldest.
        const firstKey = claudeSessionCache.keys().next().value;
        if (firstKey !== undefined) claudeSessionCache.delete(firstKey);
    }

    const sessionId = doDetectClaudeSessionId(cwd);
    claudeSessionCache.set(cwd, { sessionId, expiresAt: now + CLAUDE_SESSION_CACHE_TTL_MS });
    return sessionId;
};

interface PaneInfo {
    currentCommand: string | null;
    startCommand: string | null;
    currentPath: string | null;
}

// U+241F "Symbol for Unit Separator" — a *printable* Unicode glyph
// (3-byte UTF-8) that visually represents the C0 Unit Separator but is
// itself a normal character. Critical detail: tmux 3.5a's `-F` format
// escapes raw control bytes (0x00-0x1F) like `\037` for terminal safety,
// which broke an earlier `'\x1f'` separator — the byte we passed never
// arrived at the consumer end. A printable Unicode char passes through
// verbatim and won't appear in any real session name or filesystem path.
const FIELD_SEP = '␟';

const readPaneInfo = (session: string): PaneInfo => {
    const r = spawnSync('tmux', tmuxArgs(['display-message', '-p', '-t', session,
        `#{pane_current_command}${FIELD_SEP}#{pane_start_command}${FIELD_SEP}#{pane_current_path}`]), {
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

/**
 * Strip the surrounding quotes tmux uses when serialising commands
 * with spaces. `tmux display-message -p '#{pane_start_command}'`
 * outputs `"claude --resume xxx"` (literal double-quotes around the
 * whole shell-command form the wrapper passed). Without unwrapping,
 * the leading `"` made the basename check fail and the listener
 * skipped the session as 'no agent in pane'.
 */
const unwrapQuotes = (cmd: string): string => {
    const m = cmd.match(/^"(.+)"$/) || cmd.match(/^'(.+)'$/);
    return m ? m[1] : cmd;
};

const firstTokenBasename = (cmd: string | null): string => {
    if (!cmd) return '';
    const stripped = unwrapQuotes(cmd.trim());
    return basename(stripped.split(/\s+/)[0] || '');
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
    const list = spawnSync('tmux', tmuxArgs(['list-sessions', '-F',
        `#{session_name}${FIELD_SEP}#{session_attached}${FIELD_SEP}#{session_created}${FIELD_SEP}#{session_activity}`]), {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (list.status !== 0) {
        const stderr = (list.stderr ?? '').toString().trim();
        log(`  tmux list-sessions failed: status=${list.status}${stderr ? ', stderr=' + stderr : ''}`);
        // Tmux call failed against the cached socket — the server it
        // pointed at is gone (died, restarted at a different path, etc).
        // Invalidate so the next cycle re-runs full discovery instead of
        // wedging the listener at "reported 0 session(s)" forever.
        invalidateTmuxSocketCache();
        return { sessions: [], rejected: [] };
    }

    const rawLines = (list.stdout ?? '').split('\n').filter(Boolean);
    // Sanity-check that the format separator actually survived. tmux is
    // supposed to pass non-format bytes through unchanged, but if any
    // shim (login shell, security tool, terminal wrapper) mangles the
    // 0x1f byte we'd parse the line as a single un-split field and drop
    // it as "not zeph-*". Detect that explicitly so the user isn't left
    // guessing.
    if (rawLines.length > 0 && !rawLines[0].includes(FIELD_SEP)) {
        log(`  tmux output missing FIELD_SEP — likely encoding issue. Raw line: ${JSON.stringify(rawLines[0])}`);
    }

    const sessions: AgentSession[] = [];
    const rejected: Array<{ name: string; reason: string }> = [];
    for (const line of rawLines) {
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

/**
 * One file riding on an `agent.command` push. agent.command attachments
 * are uploaded in *plaintext* (the listener has no per-user crypto key),
 * so `iv`/`encryptedKey` should be absent. If either is present the file
 * is encrypted and the listener can't read it — it gets skipped.
 */
interface PushFileAttachment {
    fileKey: string;
    fileName: string;
    fileType?: string;
    fileSize?: number;
    iv?: string;
    encryptedKey?: string;
}

interface PushItem {
    pushId: string;
    type?: string;
    body?: string;
    title?: string;
    createdAt?: string;
    isEncrypted?: boolean;
    /** Set when type='agent.command' — tmux session name to inject into. */
    agentSessionName?: string;
    /** Optional image/file attachments (agent.command only, plaintext). */
    files?: PushFileAttachment[];
}

interface HandlePushDeps {
    paneCommand?: (session: string) => string | null;
    inject?: (session: string, text: string) => boolean;
    rateLimit?: (session: string) => boolean;
    now?: () => number;
    /** Injectable for tests; defaults to the REST-backed downloader. */
    downloadAttachments?: (pushId: string, files: PushFileAttachment[]) => Promise<string[]>;
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

// ─── Attachment download (agent.command files[]) ────────────────────

const ATTACHMENTS_DIR = join(homedir(), '.zeph', 'attachments');
const DEFAULT_API_BASE = 'https://api.zeph.to/v1';

// apiKey + baseUrl for the file-download REST calls, set once in
// handleListener. The default downloader reads it. null until the daemon
// resolves credentials (handlePush isn't called before then in the real
// flow, but the guard keeps it safe).
let attachmentCtx: { apiKey: string; baseUrl: string } | null = null;

export const setAttachmentContext = (ctx: { apiKey: string; baseUrl: string }): void => {
    attachmentCtx = ctx;
};

/**
 * Make a filesystem-safe single path segment: take the basename (drops
 * any `../` prefix), strip control chars and embedded separators, remove
 * leading dots, and cap length. Empty/dot-only names use the fallback.
 */
const safeSegment = (raw: string, fallback: string): string => {
    const cleaned = basename(raw)
        .replace(/[\x00-\x1f\x7f]/g, '')
        .replace(/[/\\]/g, '_')
        .replace(/^\.+/, '')
        .trim();
    return (cleaned || fallback).slice(0, 200);
};

/** Resolve fileKey → presigned URL → bytes. Throws on any HTTP failure so
 *  the caller can isolate one file's failure from the rest of the batch. */
const fetchAttachmentBytes = async (
    fileKey: string,
    ctx: { apiKey: string; baseUrl: string },
): Promise<Buffer> => {
    const metaUrl = `${ctx.baseUrl.replace(/\/+$/, '')}/files/${encodeURIComponent(fileKey)}`;
    const meta = await fetch(metaUrl, { headers: { 'X-API-Key': ctx.apiKey } });
    if (!meta.ok) throw new Error(`metadata ${meta.status}`);
    // Server wraps responses as { data: { downloadUrl } } (see lib/response ok()).
    const body = (await meta.json()) as { data?: { downloadUrl?: string }; downloadUrl?: string };
    const downloadUrl = body.data?.downloadUrl ?? body.downloadUrl;
    if (!downloadUrl) throw new Error('response had no downloadUrl');
    // The presigned URL is self-authenticating — no API key header.
    const bin = await fetch(downloadUrl);
    if (!bin.ok) throw new Error(`download ${bin.status}`);
    return Buffer.from(await bin.arrayBuffer());
};

/**
 * Download every plaintext attachment to
 * `~/.zeph/attachments/<pushId>/<fileName>` and return absolute paths.
 * Encrypted files are skipped (no key). A single file's failure is logged
 * and skipped — it never aborts the batch, so a partial download still
 * injects whatever succeeded. Files are kept (not deleted) so the agent
 * can read them after injection.
 */
const downloadAttachments = async (
    pushId: string,
    files: PushFileAttachment[],
    ctx: { apiKey: string; baseUrl: string },
): Promise<string[]> => {
    const dir = join(ATTACHMENTS_DIR, safeSegment(pushId, 'push'));
    const paths: string[] = [];
    for (const [i, f] of files.entries()) {
        if (f.iv || f.encryptedKey) {
            log(`! attachment "${f.fileName}": encrypted (iv/encryptedKey present) — listener can't decrypt, skipping`);
            continue;
        }
        try {
            const bytes = await fetchAttachmentBytes(f.fileKey, ctx);
            mkdirSync(dir, { recursive: true });
            const abs = join(dir, safeSegment(f.fileName || `file-${i}`, `file-${i}`));
            writeFileSync(abs, bytes);
            paths.push(abs);
            log(`⇣ ${f.fileName} → ${abs} (${bytes.length}B)`);
        } catch (err) {
            log(`! attachment "${f.fileName}": download failed — ${(err as Error).message}`);
        }
    }
    return paths;
};

const defaultDownloadAttachments = (pushId: string, files: PushFileAttachment[]): Promise<string[]> => {
    if (!attachmentCtx) {
        log('! attachment context not initialised — skipping files');
        return Promise.resolve([]);
    }
    return downloadAttachments(pushId, files, attachmentCtx);
};

/**
 * Combine the command body with downloaded file paths, one per line.
 * Claude Code reads local image paths from the prompt text, so appending
 * absolute paths makes the agent load them. Empty body → paths only.
 */
const composeInjection = (body: string, paths: string[]): string =>
    paths.length ? [body, ...paths].filter(Boolean).join('\n') : body;

// Downloaded attachments are kept after injection (the agent reads them
// from disk), so they accumulate. A per-push dir older than this is GC'd —
// long enough to outlive any realistic agent read, short enough that the
// directory can't grow without bound on a long-running daemon.
const ATTACHMENT_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Remove attachment sub-directories whose mtime is older than `ttl`.
 * Best-effort: an entry that can't be statted or removed is skipped, not
 * fatal. Returns the count removed. `dir`/`ttl` are injectable for tests.
 */
export const gcAttachments = (
    now: number = Date.now(),
    dir: string = ATTACHMENTS_DIR,
    ttl: number = ATTACHMENT_TTL_MS,
): number => {
    let removed = 0;
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return 0; }
    for (const name of entries) {
        const full = join(dir, name);
        try {
            if (now - statSync(full).mtimeMs <= ttl) continue;
            rmSync(full, { recursive: true, force: true });
            removed++;
        } catch { /* skip unreadable/unremovable entries */ }
    }
    return removed;
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
export const handlePush = async (
    push: PushItem,
    deps: HandlePushDeps = {},
): Promise<boolean> => {
    if (push.isEncrypted) {
        // Per-device keys aren't wired yet; encrypted pushes are opaque
        // to the listener.
        return false;
    }
    if (push.type !== 'agent.command' || !push.agentSessionName) return false;

    // Download any attachments BEFORE injecting so the agent can read the
    // local paths immediately. A download-phase failure is isolated: the
    // body text still injects so the command itself isn't blocked.
    let paths: string[] = [];
    if (push.files?.length) {
        const download = deps.downloadAttachments ?? defaultDownloadAttachments;
        try {
            paths = await download(push.pushId, push.files);
        } catch (err) {
            log(`! ${push.agentSessionName}: attachment download failed — ${(err as Error).message}`);
        }
    }

    return tryInject(push.agentSessionName, composeInjection(push.body ?? '', paths), deps);
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
        let connectTimer: NodeJS.Timeout | null = null;
        let stallTimer: NodeJS.Timeout | null = null;
        // Updated on every server-acked round-trip (ack / pong). The
        // stall watchdog terminates the WS if this stays stale too long,
        // which lets the reconnect loop recover from half-open sockets
        // (suspended laptop, NAT drop, server unreachable but TCP alive).
        let lastRoundTripAt = Date.now();

        const cleanup = (): void => {
            if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
            if (pongTimer) { clearTimeout(pongTimer); pongTimer = null; }
            if (sessionsTimer) { clearInterval(sessionsTimer); sessionsTimer = null; }
            if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; }
            if (stallTimer) { clearInterval(stallTimer); stallTimer = null; }
        };

        // If the WS doesn't reach OPEN within the timeout, kill it.
        // Otherwise an unreachable backend (DNS / route / SG drop) keeps
        // the socket in CONNECTING forever and `done` never resolves.
        connectTimer = setTimeout(() => {
            if (sock.readyState !== WebSocket.OPEN) {
                log(`! connect timeout after ${WS_CONNECT_TIMEOUT_MS / 1000}s — terminating`);
                sock.terminate();
            }
        }, WS_CONNECT_TIMEOUT_MS);

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
            // When the parsed result is empty AND nothing was rejected,
            // we likely have a tmux-visibility issue (different socket,
            // tmux server not running, etc.). Dump what tmux sees from
            // *this process's* perspective so the user can compare with
            // their interactive shell.
            if (sessions.length === 0 && rejected.length === 0) {
                const raw = spawnSync('tmux', tmuxArgs(['list-sessions', '-F', '#{session_name}']), {
                    encoding: 'utf-8',
                    stdio: ['ignore', 'pipe', 'pipe'],
                });
                if (raw.status !== 0) {
                    const err = (raw.stderr ?? '').toString().trim() || 'no stderr';
                    log(`  diag: tmux list-sessions exit=${raw.status}, ${err}`);
                } else {
                    const all = (raw.stdout ?? '').trim().split('\n').filter(Boolean);
                    log(`  diag: tmux sees ${all.length} session(s) total: ${all.join(', ') || '∅'}`);
                    if (all.length > 0) {
                        log(`  diag: none start with "zeph-" — check wrapper output or run 'zeph cc' to verify naming`);
                    }
                }
            }
        };

        sock.on('open', () => {
            if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; }
            lastRoundTripAt = Date.now();
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

            // Independent stall watchdog. If we go > WS_STALL_TIMEOUT_MS
            // without any server message landing — ack, pong, anything —
            // the socket is effectively half-open. ping/pong should catch
            // most of this but a sleeping laptop can pause the JS timer
            // such that pongTimer is checked AFTER the suspension and
            // appears 'recently scheduled'. The watchdog uses wall-clock
            // delta vs lastRoundTripAt so it's resilient to that.
            stallTimer = setInterval(() => {
                if (sock.readyState !== WebSocket.OPEN) return;
                if (Date.now() - lastRoundTripAt > WS_STALL_TIMEOUT_MS) {
                    log(`! no server traffic for ${Math.round((Date.now() - lastRoundTripAt) / 1000)}s — terminating`);
                    sock.terminate();
                }
            }, 15_000);
        });

        sock.on('message', (raw) => {
            if (pongTimer) { clearTimeout(pongTimer); pongTimer = null; }
            lastRoundTripAt = Date.now();
            let msg: unknown;
            try {
                msg = JSON.parse(raw.toString('utf-8'));
            } catch {
                return; // malformed — ignore
            }
            if (!msg || typeof msg !== 'object') return;
            const m = msg as { type?: string; data?: unknown; message?: string };
            if (m.type === 'pong') return;
            if (m.type === 'push.new' && m.data) {
                // Fire-and-forget: handlePush is async (attachment download)
                // but the WS read loop must stay responsive. Errors are
                // logged, never thrown into the socket handler.
                void handlePush(m.data as PushItem).catch((err) =>
                    log(`! handlePush: ${(err as Error).message}`));
            }
            // Surface server-side errors from listener.sessions reports.
            // Without this the daemon happily logs "reported N session(s)"
            // even when the server is silently dropping every message —
            // exactly how the picker-empty bug stayed hidden for weeks.
            if (m.type === 'listener.sessions.error') {
                log(`! server rejected listener.sessions: ${m.message ?? '(no detail)'}`);
            }
            if (m.type === 'listener.sessions.ack') {
                const d = m.data as { count?: number; updatedAt?: string } | undefined;
                log(`✓ server persisted ${d?.count ?? '?'} session(s)`);
            }
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

// ── Singleton guard (PID file) ──────────────────────────────────────

const ZEPH_DIR = join(homedir(), '.zeph');
const LISTENER_PID_FILE = join(ZEPH_DIR, 'listener.pid');

/**
 * Whether another `zeph listener` is already running on this machine.
 * The wrapper's autostart and a user typing `zeph listener` by hand can
 * race — both check this guard so we don't spawn duplicates that
 * compete for the same `agent.command` pushes.
 *
 * Stale PID files (process gone) are treated as "no listener" so the
 * wrapper can recover from crashes without manual cleanup.
 */
const otherListenerAlive = (): number | null => {
    try {
        const pid = Number(readFileSync(LISTENER_PID_FILE, 'utf-8').trim());
        if (!Number.isFinite(pid) || pid <= 0 || pid === process.pid) return null;
        process.kill(pid, 0); // existence check, throws if dead
        return pid;
    } catch {
        return null;
    }
};

const writeListenerPid = (): void => {
    try {
        mkdirSync(ZEPH_DIR, { recursive: true });
        writeFileSync(LISTENER_PID_FILE, String(process.pid));
    } catch (err) {
        log(`! could not write ${LISTENER_PID_FILE}: ${(err as Error).message}`);
    }
};

const removeListenerPid = (): void => {
    try {
        if (!existsSync(LISTENER_PID_FILE)) return;
        // Only remove our own pid file — don't trample a successor's.
        const pid = Number(readFileSync(LISTENER_PID_FILE, 'utf-8').trim());
        if (pid === process.pid) unlinkSync(LISTENER_PID_FILE);
    } catch { /* best-effort */ }
};

export const handleListener = async (args: Record<string, string | boolean>): Promise<number> => {
    verifyTmux();

    // Refuse to start when another listener is already running. The
    // wrapper's autostart calls us blindly on every `zeph cc`; the user
    // running `zeph listener` directly does too. Bail with exit 0 (not
    // an error — there *is* a listener, just not us).
    const otherPid = otherListenerAlive();
    if (otherPid) {
        if (process.env.ZEPH_LISTENER_AUTOSTART === '1') {
            // Autostart from the wrapper — stay quiet on the happy path.
            return 0;
        }
        console.error(`zeph listener: another listener is already running (pid ${otherPid}). ` +
            `Tail \`~/.zeph/listener.log\` to follow it, or kill ${otherPid} first.`);
        return 0;
    }

    const config = loadConfig();
    const apiKey = (args.key as string) || resolvedEnv('ZEPH_API_KEY') || config.apiKey;
    if (!apiKey) {
        console.error('zeph listener: API key required. Run `zeph install` or set ZEPH_API_KEY.');
        return 3;
    }
    // Base URL for attachment downloads (GET /v1/files/{fileKey}). Same
    // resolution order as the rest of the CLI; falls back to the prod API.
    const baseUrl = (args['base-url'] as string) || resolvedEnv('ZEPH_BASE_URL') || config.baseUrl || DEFAULT_API_BASE;
    setAttachmentContext({ apiKey, baseUrl });

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

    writeListenerPid();
    process.on('exit', removeListenerPid);

    log(`zeph listener starting — ${wsUrl}`);
    log(`device=${computeListenerDeviceId()} host=${hostname()} pid=${process.pid}`);
    log("Waiting for 'agent.command' pushes from the phone picker. Ctrl-C to stop.");

    // Heartbeat memory log — once an hour. Lets the user (and us) spot
    // gradual growth in a long-running daemon before it gets bad enough
    // to make the host shell unresponsive. The MB counter is human-
    // readable and tiny enough not to bloat the log.
    const HEAP_LOG_INTERVAL_MS = 60 * 60 * 1000;
    const heapLogTimer = setInterval(() => {
        const m = process.memoryUsage();
        const mb = (n: number) => Math.round(n / 1024 / 1024);
        log(`heap: rss=${mb(m.rss)}MB heapUsed=${mb(m.heapUsed)}MB external=${mb(m.external)}MB`);
    }, HEAP_LOG_INTERVAL_MS);
    heapLogTimer.unref();

    // Sweep stale attachment dirs at startup, then hourly. Keeps
    // ~/.zeph/attachments from growing without bound over a long run.
    const sweepAttachments = (): void => {
        const n = gcAttachments();
        if (n > 0) log(`gc: removed ${n} stale attachment dir(s)`);
    };
    sweepAttachments();
    const gcTimer = setInterval(sweepAttachments, 60 * 60 * 1000);
    gcTimer.unref();

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
            removeListenerPid();
            return 3;
        }

        if (shuttingDown) break;

        const delay = computeBackoff(attempt);
        log(`disconnected (code=${result.closeCode}) — reconnect in ${Math.round(delay / 1000)}s`);
        await sleep(delay);
        attempt = Math.min(attempt + 1, 10);
    }

    removeListenerPid();
    return 0;
};
