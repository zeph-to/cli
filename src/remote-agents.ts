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
    /**
     * Resolve the name the agent calls this session by — what the user sees in
     * their own terminal, which the phone shows instead of the computed
     * `<project> · <Agent> #N` label.
     *
     * Same shape as `resolveSessionId` and the same EXTENSION POINT rule: a row
     * carries this only once that agent's name store is confirmed. Cursor and
     * Gemini never will — their state files hold ids, cwds and timestamps and no
     * name at all, so there is nothing to read and the computed label stands.
     */
    resolveSessionName?: (paneCwd: string, panePid?: number) => string | null;
}

/**
 * A name is only worth carrying if it has visible characters. Renderers treat
 * `''` as falsy and fall back on their own, but the change fingerprints on both
 * sides of the wire collapse `undefined`/`null` and would ship a blank string as
 * a real change — a report per cycle that says nothing.
 */
const nonBlank = (value: string | undefined): string | null => {
    const trimmed = value?.trim();
    return trimmed ? trimmed : null;
};

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

export interface PidSessionRecord {
    pid: number;
    sessionId: string;
    cwd: string;
    /**
     * What Claude Code calls this session (`zeph-to-95` when derived from the
     * cwd, free text once named). Optional: an older CC writes the record
     * without it, and a record without a name is still a valid id match.
     */
    name?: string;
}

const readPidSessionRecords = (): PidSessionRecord[] => {
    try {
        const out: PidSessionRecord[] = [];
        for (const entry of readdirSync(CLAUDE_SESSIONS_DIR)) {
            if (!/^\d+\.json$/.test(entry)) continue;
            try {
                const raw = JSON.parse(readFileSync(join(CLAUDE_SESSIONS_DIR, entry), 'utf-8')) as Partial<PidSessionRecord>;
                if (typeof raw.pid === 'number' && typeof raw.sessionId === 'string' && typeof raw.cwd === 'string') {
                    out.push({
                        pid: raw.pid,
                        sessionId: raw.sessionId,
                        cwd: raw.cwd,
                        ...(typeof raw.name === 'string' ? { name: raw.name } : {}),
                    });
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

export interface ProcTable {
    /** ppid → its direct children, for walking a pane's process tree. */
    children: Map<number, number[]>;
    /** pid → process start time in epoch ms. Only pids whose `lstart` parsed. */
    startTimes: Map<number, number>;
}

/**
 * Parse `ps -axo pid=,ppid=,lstart=`. A row is `<pid> <ppid> [<lstart>]`, e.g.
 * `    1     0 Fri Aug  7 11:12:59 2026    ` — note the two spaces before a
 * single-digit day and the trailing padding.
 *
 * The third field is OPTIONAL in the pattern, and that is load-bearing rather
 * than defensive. Requiring it would mean that on any machine whose `ps` prints
 * a different `lstart` shape, EVERY row fails to match, `children` comes back
 * empty, `collectDescendantPids` answers `{rootPid}`, and
 * `detectClaudeSessionByPid` finds nothing — dropping Claude Code back to the
 * mtime heuristic and its identity theft (see CLAUDE_SESSIONS_DIR above). The
 * parent links must survive an unreadable timestamp; only the start time is
 * allowed to go missing, and every consumer of `startTimes` treats an absent
 * entry as "no match" rather than guessing.
 */
export const parseProcTable = (table: string): ProcTable => {
    const children = new Map<number, number[]>();
    const startTimes = new Map<number, number>();
    for (const line of table.split('\n')) {
        const m = line.trim().match(/^(\d+)\s+(\d+)(?:\s+(.*))?$/);
        if (!m) continue;
        const [pid, ppid] = [Number(m[1]), Number(m[2])];
        const list = children.get(ppid) ?? [];
        list.push(pid);
        children.set(ppid, list);
        if (m[3] === undefined) continue;
        const started = Date.parse(m[3].trim());
        if (Number.isFinite(started)) startTimes.set(pid, started);
    }
    return { children, startTimes };
};

/**
 * One process-table snapshot per report cycle, shared by every pane. `lstart`
 * rides along because the agents without a pid registry (Hermes, Codex) are
 * matched to their session row by when their process started, and paying for a
 * second `ps` spawn to learn that would undo what this memo is for.
 */
const readPsSnapshot = ttlMemo(SNAPSHOT_TTL_MS, (): ProcTable | null => {
    const r = spawnSync('ps', ['-axo', 'pid=,ppid=,lstart='], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
    return r.status === 0 ? parseProcTable(r.stdout ?? '') : null;
});

/** Start times for this cycle's snapshot. Empty when `ps` is unavailable. */
export const psStartTimes = (): Map<number, number> => readPsSnapshot()?.startTimes ?? new Map();

const cachedPidSessionRecords = ttlMemo(SNAPSHOT_TTL_MS, readPidSessionRecords);

const walkDescendants = (rootPid: number, children: Map<number, number[]>): Set<number> => {
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

/**
 * Per-pane process tree, memoized for the same window as the `ps` snapshot it
 * walks. The snapshot itself is already shared across the cycle (readPsChildren),
 * but the walk was not: each resolver on a row ran its own BFS, so asking a pane
 * for both its session id and its session name doubled the work on the path
 * whose CPU cost is the reason these caches exist (see claudeSessionCache).
 *
 * Callers must treat the returned Set as read-only — it is shared.
 */
const descendantCache = new Map<number, { pids: Set<number>; expiresAt: number }>();

/** pid set of `rootPid` + all descendants, from one `ps` snapshot. */
export const collectDescendantPids = (rootPid: number, psOutput?: string): Set<number> => {
    // An explicit table is a caller supplying its own snapshot — never cached,
    // since the cache key says nothing about which table it came from.
    if (psOutput !== undefined) return walkDescendants(rootPid, parseProcTable(psOutput).children);

    const now = Date.now();
    const cached = descendantCache.get(rootPid);
    if (cached && cached.expiresAt > now) return cached.pids;

    const children = readPsSnapshot()?.children ?? null;
    // A failed `ps` is not cached: the next cycle should retry rather than
    // serve "this pane has no children" for the whole TTL.
    if (children === null) return new Set([rootPid]);

    // Same bound and eviction as claudeSessionCache — a long-lived listener sees
    // many pane pids over its lifetime and none of them come back.
    if (descendantCache.size >= 64) {
        const oldest = descendantCache.keys().next().value;
        if (oldest !== undefined) descendantCache.delete(oldest);
    }
    const pids = walkDescendants(rootPid, children);
    descendantCache.set(rootPid, { pids, expiresAt: now + SNAPSHOT_TTL_MS });
    return pids;
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
 *
 * Returns the whole record so the id and the name come from one lookup — they
 * describe the same session, and reading the directory twice per cycle to get
 * them separately is what the cache above exists to avoid.
 */
export const detectClaudeSessionByPid = (
    panePid: number,
    paneCwd: string | null,
    deps: PidResolveDeps = {},
): PidSessionRecord | null => {
    const records = deps.records ?? cachedPidSessionRecords();
    if (records.length === 0) return null;
    const descendants = deps.descendants ?? collectDescendantPids(panePid);
    return records.find((r) =>
        descendants.has(r.pid) && (paneCwd === null || r.cwd === paneCwd)) ?? null;
};

export const detectClaudeSessionIdByPid = (
    panePid: number,
    paneCwd: string | null,
    deps: PidResolveDeps = {},
): string | null => detectClaudeSessionByPid(panePid, paneCwd, deps)?.sessionId ?? null;

/**
 * The name of the session running in this pane. No mtime fallback exists here:
 * the transcript filenames the heuristic walks carry a UUID and nothing else,
 * so an older CC without `~/.claude/sessions` yields no name and the phone
 * keeps the computed label.
 */
export const detectClaudeSessionNameByPid = (
    panePid: number,
    paneCwd: string | null,
    deps: PidResolveDeps = {},
): string | null => nonBlank(detectClaudeSessionByPid(panePid, paneCwd, deps)?.name);

// ── Agents whose session store keeps no pid ──────────────────────
//
// Hermes and Codex both record a session per cwd with a creation timestamp and
// no pid, so a pane cannot be joined to its row the exact way Claude Code's
// `<pid>.json` allows. What is left is time: both stores stamp the row when the
// session starts, so the row belonging to this pane is the one stamped when a
// process in this pane started. The window has to be narrow — two agents opened
// in the same directory within it are indistinguishable — and a miss must stay a
// miss, since a wrong name shown confidently is worse than the computed label.

/** How far a row's creation time may sit from a process start time. */
const PROC_MATCH_TOLERANCE_MS = 10_000;

/**
 * The row whose timestamp is closest to when one of `pids` started, within
 * `tolMs`. Null when nothing qualifies — including when no pid in the tree has a
 * known start time, which is why the start times are read before any row is
 * compared rather than defaulted to zero.
 */
export const pickRowByProcStart = <T>(
    rows: readonly T[],
    tsMsOf: (row: T) => number | null,
    startTimes: Map<number, number>,
    pids: Set<number>,
    tolMs: number = PROC_MATCH_TOLERANCE_MS,
): T | null => {
    const procStarts = [...pids]
        .map((pid) => startTimes.get(pid))
        .filter((t): t is number => t !== undefined && Number.isFinite(t));
    if (procStarts.length === 0) return null;

    let best: { row: T; distance: number } | null = null;
    for (const row of rows) {
        const at = tsMsOf(row);
        if (at === null || !Number.isFinite(at)) continue;
        const distance = Math.min(...procStarts.map((start) => Math.abs(at - start)));
        if (distance > tolMs) continue;
        if (best === null || distance < best.distance) best = { row, distance };
    }
    return best?.row ?? null;
};

/**
 * Read rows from a SQLite file as JSON. Null on every failure — no `sqlite3` on
 * PATH, a locked or corrupt database, a schema that moved — because a missing
 * name costs the computed label and nothing else.
 *
 * The query carries no parameters BY DESIGN: SQL passed to the `sqlite3` binary
 * as an argv string has nowhere to bind `?` to, so interpolating a cwd would
 * make this file the place that has to know SQLite quoting rules. Callers select
 * the columns they need and filter in JS instead; the stores hold tens of rows,
 * not millions. The `timeout` keeps a locked database from holding up a report
 * cycle that runs every five seconds.
 */
export const sqliteJson = (dbPath: string, sql: string): unknown[] | null => {
    const r = spawnSync('sqlite3', ['-readonly', '-json', dbPath, sql], {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 1_000,
    });
    if (r.status !== 0) return null;
    const out = (r.stdout ?? '').trim();
    if (out === '') return []; // no rows — sqlite3 prints nothing, not `[]`
    try {
        const parsed = JSON.parse(out);
        return Array.isArray(parsed) ? parsed : null;
    } catch {
        return null;
    }
};

/** Test seam for the store-backed resolvers. `rows: null` = the read failed. */
export interface StoreResolveDeps {
    rows?: unknown[] | null;
    startTimes?: Map<number, number>;
    descendants?: Set<number>;
}

// ── Hermes ───────────────────────────────────────────────────────

const HERMES_STATE_DB = join(homedir(), '.hermes', 'state.db');

/**
 * `sessions` rows for CLI sessions. `started_at` is REAL **seconds** (e.g.
 * `1786676108.657766`), not milliseconds — the one unit mistake that would make
 * every comparison miss by decades without erroring.
 *
 * `ended_at IS NULL` is deliberately NOT a filter: measured rows for sessions
 * that died days ago still have a null `ended_at`, so it says nothing about
 * liveness. The process-start match is the only thing that does.
 */
interface HermesSessionRow {
    cwd?: string | null;
    title?: string | null;
    display_name?: string | null;
    started_at?: number | null;
}

const readHermesSessions = ttlMemo(SNAPSHOT_TTL_MS, (): unknown[] | null => sqliteJson(
    HERMES_STATE_DB,
    "SELECT cwd, title, display_name, started_at FROM sessions WHERE source = 'cli'",
));

export const detectHermesSessionName = (
    paneCwd: string,
    panePid?: number,
    deps: StoreResolveDeps = {},
): string | null => {
    // Without the pane's pid there is no process tree to match against, and this
    // store offers no other key — no name is the only honest answer.
    if (panePid === undefined) return null;
    const raw = deps.rows !== undefined ? deps.rows : readHermesSessions();
    if (raw === null) return null;

    const rows = (raw as HermesSessionRow[]).filter((r) => r.cwd === paneCwd);
    if (rows.length === 0) return null;
    const row = pickRowByProcStart(
        rows,
        (r) => (typeof r.started_at === 'number' ? r.started_at * 1_000 : null),
        deps.startTimes ?? psStartTimes(),
        deps.descendants ?? collectDescendantPids(panePid),
    );
    // The auto-title is written asynchronously after the first response, so an
    // untitled row is a young session, not a broken one.
    return nonBlank(row?.title ?? undefined) ?? nonBlank(row?.display_name ?? undefined);
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
        resolveSessionName: (paneCwd, panePid) =>
            panePid !== undefined ? detectClaudeSessionNameByPid(panePid, paneCwd) : null,
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
        // No `resolveSessionId` counterpart: the store's own id is a
        // `<timestamp>_<hash>` string, and nothing on the wire consumes it yet.
        resolveSessionName: detectHermesSessionName,
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
