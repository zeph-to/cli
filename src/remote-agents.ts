/**
 * Remote-control agent registry — the single table behind every
 * `zeph <agent>` subcommand, the listener's pane matching, and the
 * per-agent session-id enrichment. Adding a remote-controllable agent is
 * one row here (plus, for a genuinely new kind, backend/phone support:
 * `kind` is a wire contract — AgentSession.agentKind flows to the server
 * and the phone picker, which may validate the enum).
 *
 * This is deliberately NOT merged into `agents.ts`: that table drives
 * install/uninstall/verify detection (8 agents, incl. Windsurf, which can
 * never be driven via tmux), and the two tables carry different name axes
 * — install id vs subcommand alias vs pane binary. Cursor is the clearest
 * case for keeping them apart: the `cursor` install id there means the
 * IDE, while the drivable binary here is `cursor-agent`, its terminal TUI.
 */
import { readdirSync, readFileSync, statSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';

export interface RemoteAgent {
    /** Wire value for AgentSession.agentKind (server/phone contract). */
    kind: string;
    /** Human name for --help text. */
    displayName: string;
    /** Binary launched in the tmux pane; also the primary pane-match token. */
    binary: string;
    /** `zeph <subcommand>` aliases that launch this agent. */
    subcommands: readonly string[];
    /**
     * What this agent is typed to make it quit, if it has such a command.
     *
     * Signals are not enough on their own: Claude Code holds its prompt
     * through both `C-c` and `C-d`, so a remote "end this session" built only
     * out of key presses reports failure against the agent people actually
     * run. Omitted where the command has not been verified against the real
     * binary — sending a guess into a live pane types it at whatever prompt
     * is there.
     */
    quitCommand?: string;
    /** Extra pane_command basenames accepted as this agent (beyond binary). */
    paneMatchAliases?: readonly string[];
    /**
     * Resolve the agent's own session id from the pane's cwd (+ pane pid
     * when the caller knows it — enables exact process-tree matching).
     * EXTENSION POINT: carried only by Claude Code. Every other row omits
     * it until that agent's session-file format is confirmed — the listener
     * then reports agentSessionId: null.
     */
    resolveSessionId?: (paneCwd: string, panePid?: number) => string | null;
}

// ── Claude Code session resolver ─────────────────────────────────

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

// ── Claude Code pid → session resolver ───────────────────────────
//
// Claude Code maintains ~/.claude/sessions/<pid>.json with the exact
// {pid, sessionId, cwd} of every live session. Matching the tmux pane's
// process tree against these records identifies THE session running in
// that pane — immune to the identity theft the mtime heuristic suffers
// when a second `claude` opens in the same cwd (its transcript becomes
// the newest file and steals the tmux session's id).

const CLAUDE_SESSIONS_DIR = join(homedir(), '.claude', 'sessions');

interface PidSessionRecord {
    pid: number;
    sessionId: string;
    cwd: string;
}

const readPidSessionRecords = (): PidSessionRecord[] => {
    try {
        const out: PidSessionRecord[] = [];
        for (const entry of readdirSync(CLAUDE_SESSIONS_DIR)) {
            if (!/^\d+\.json$/.test(entry)) continue;
            try {
                const raw = JSON.parse(readFileSync(join(CLAUDE_SESSIONS_DIR, entry), 'utf-8')) as Partial<PidSessionRecord>;
                if (typeof raw.pid === 'number' && typeof raw.sessionId === 'string' && typeof raw.cwd === 'string') {
                    out.push({ pid: raw.pid, sessionId: raw.sessionId, cwd: raw.cwd });
                }
            } catch { /* partial write / corrupt — skip */ }
        }
        return out;
    } catch {
        return []; // dir absent (older CC) — caller falls back to mtime
    }
};

// One `ps` spawn and one ~/.claude/sessions scan per report cycle, not per
// tmux session: the resolver runs for every session every 5s, and each call
// paid a full process-table spawn plus a directory scan on the daemon's hot
// path. A TTL just under the report interval lets all sessions in one cycle
// share a single snapshot while still refreshing every cycle. The parsed
// child-adjacency map is what's cached (not the raw table) so N sessions
// share one parse and differ only in the per-root BFS.
const SNAPSHOT_TTL_MS = 4_000;

const ttlMemo = <T,>(ttlMs: number, compute: () => T): (() => T) => {
    let snap: { value: T; expiresAt: number } | null = null;
    return () => {
        const now = Date.now();
        if (snap && snap.expiresAt > now) return snap.value;
        snap = { value: compute(), expiresAt: now + ttlMs };
        return snap.value;
    };
};

const parseChildren = (table: string): Map<number, number[]> => {
    const children = new Map<number, number[]>();
    for (const line of table.split('\n')) {
        const m = line.trim().match(/^(\d+)\s+(\d+)$/);
        if (!m) continue;
        const [pid, ppid] = [Number(m[1]), Number(m[2])];
        const list = children.get(ppid) ?? [];
        list.push(pid);
        children.set(ppid, list);
    }
    return children;
};

const readPsChildren = ttlMemo(SNAPSHOT_TTL_MS, (): Map<number, number[]> | null => {
    const r = spawnSync('ps', ['-axo', 'pid=,ppid='], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
    return r.status === 0 ? parseChildren(r.stdout ?? '') : null;
});

const cachedPidSessionRecords = ttlMemo(SNAPSHOT_TTL_MS, readPidSessionRecords);

/** pid set of `rootPid` + all descendants, from one `ps` snapshot. */
const collectDescendantPids = (rootPid: number, psOutput?: string): Set<number> => {
    const children = psOutput !== undefined ? parseChildren(psOutput) : readPsChildren();
    if (children === null) return new Set([rootPid]);
    const found = new Set<number>([rootPid]);
    const queue = [rootPid];
    while (queue.length > 0) {
        for (const child of children.get(queue.shift()!) ?? []) {
            if (!found.has(child)) {
                found.add(child);
                queue.push(child);
            }
        }
    }
    return found;
};

/** Test seam for the pid-based resolver. */
export interface PidResolveDeps {
    records?: PidSessionRecord[];
    descendants?: Set<number>;
}

/**
 * Exact resolution: the session record whose pid lives in the pane's
 * process tree AND whose cwd matches (guards against OS pid reuse
 * leaving a stale record pointing elsewhere). Null → caller falls back
 * to the mtime heuristic.
 */
export const detectClaudeSessionIdByPid = (
    panePid: number,
    paneCwd: string | null,
    deps: PidResolveDeps = {},
): string | null => {
    const records = deps.records ?? cachedPidSessionRecords();
    if (records.length === 0) return null;
    const descendants = deps.descendants ?? collectDescendantPids(panePid);
    const match = records.find((r) =>
        descendants.has(r.pid) && (paneCwd === null || r.cwd === paneCwd));
    return match?.sessionId ?? null;
};

// ── The registry ─────────────────────────────────────────────────

const REMOTE_AGENT_TABLE = [
    {
        kind: 'claude',
        displayName: 'Claude Code',
        binary: 'claude',
        subcommands: ['cc', 'claude'],
        quitCommand: '/exit',
        // Exact pid-tree match first; mtime heuristic only as fallback
        // (older CC without ~/.claude/sessions, or ps failure).
        resolveSessionId: (paneCwd, panePid) =>
            (panePid !== undefined ? detectClaudeSessionIdByPid(panePid, paneCwd) : null)
            ?? detectClaudeSessionId(paneCwd),
    },
    {
        kind: 'codex',
        displayName: 'Codex CLI',
        binary: 'codex',
        subcommands: ['codex'],
    },
    {
        // The pane binary is `cursor-agent`, Cursor's terminal TUI — NOT the
        // bare `cursor` on PATH, which is the IDE launcher script: it opens
        // the app and exits, so a pane started with it dies before the
        // listener can address it.
        kind: 'cursor',
        displayName: 'Cursor CLI',
        binary: 'cursor-agent',
        subcommands: ['cursor', 'cursor-agent'],
    },
    {
        kind: 'gemini',
        displayName: 'Gemini CLI',
        binary: 'gemini',
        subcommands: ['gemini'],
    },
    {
        // `hermes` on PATH is a bash script that execs a venv Python, so the
        // pane's *current* command reads the interpreter (`python3.11` as
        // measured). Only `pane_start_command` identifies it, which is the
        // same bargain `claude` (node) already makes. Deliberately no
        // paneMatchAliases: matching interpreter names would adopt every
        // Python REPL on the machine as a Hermes session.
        kind: 'hermes',
        displayName: 'Hermes',
        binary: 'hermes',
        subcommands: ['hermes'],
    },
] as const satisfies readonly RemoteAgent[];

/** Closed union of remote-controllable agent kinds, derived from the table above. */
export type AgentKind = (typeof REMOTE_AGENT_TABLE)[number]['kind'];

/** A registry row: the uniform RemoteAgent shape with `kind` narrowed to the closed union. */
export type RegisteredRemoteAgent = RemoteAgent & { kind: AgentKind };

export const REMOTE_AGENTS: readonly RegisteredRemoteAgent[] = REMOTE_AGENT_TABLE;

export const findAgentBySubcommand = (cmd: string): RegisteredRemoteAgent | undefined =>
    REMOTE_AGENTS.find((a) => a.subcommands.includes(cmd));

export const matchAgentByPaneCommand = (base: string): RegisteredRemoteAgent | undefined => {
    if (!base) return undefined;
    return REMOTE_AGENTS.find((a) => a.binary === base || (a.paneMatchAliases ?? []).includes(base));
};
