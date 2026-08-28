import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectClaudeSessionIdByPid, detectClaudeSessionNameByPid, findAgentBySubcommand, matchAgentByPaneCommand, REMOTE_AGENTS } from './remote-agents.js';

// Top-level CLI commands the registry's subcommands must never collide
// with — dispatch checks the registry BEFORE the switch, so a collision
// would shadow the built-in command.
const RESERVED_COMMANDS = [
    'install', 'setup', 'login', 'uninstall', 'verify', 'check-update',
    'notify', 'list', 'dismiss', 'test', 'listener', 'help',
];

describe('remote-agents.ts: table invariants', () => {
    it('kinds are unique', () => {
        const kinds = REMOTE_AGENTS.map((a) => a.kind);
        expect(new Set(kinds).size).toBe(kinds.length);
    });

    it('subcommands are globally unique across rows', () => {
        const all = REMOTE_AGENTS.flatMap((a) => [...a.subcommands]);
        expect(new Set(all).size).toBe(all.length);
    });

    it('no subcommand collides with a built-in CLI command', () => {
        const all = REMOTE_AGENTS.flatMap((a) => [...a.subcommands]);
        for (const sub of all) expect(RESERVED_COMMANDS).not.toContain(sub);
    });

    // `--help` builds its agent list from this table, so it can never drift.
    // The README lists them by hand, which is how a shipped agent ends up
    // documented nowhere. This is the only thing that notices.
    it('every agent is documented in the README', () => {
        const readme = readFileSync(
            join(dirname(fileURLToPath(import.meta.url)), '..', 'README.md'),
            'utf-8',
        );
        for (const a of REMOTE_AGENTS) {
            expect(readme, `README.md never mentions \`zeph ${a.subcommands[0]}\``)
                .toContain(`zeph ${a.subcommands[0]}`);
        }
    });

    it('every row has at least one subcommand and a binary', () => {
        for (const a of REMOTE_AGENTS) {
            expect(a.subcommands.length).toBeGreaterThan(0);
            expect(a.binary.length).toBeGreaterThan(0);
        }
    });

    it('only claude carries a session resolver (every other row is a documented stub)', () => {
        for (const a of REMOTE_AGENTS) {
            if (a.kind === 'claude') expect(typeof a.resolveSessionId).toBe('function');
            else expect(a.resolveSessionId).toBeUndefined();
        }
    });

    // Twin of the invariant above, for the name axis. Gemini and Cursor store no
    // session name at all (their state files carry ids and timestamps only), so a
    // resolver appearing on those rows means someone invented a name — which is
    // exactly the drift this table is here to notice.
    it('cursor and gemini never carry a session-name resolver (no name exists to read)', () => {
        for (const a of REMOTE_AGENTS) {
            if (a.kind === 'cursor' || a.kind === 'gemini') expect(a.resolveSessionName).toBeUndefined();
        }
    });

    /**
     * The rows are the only thing wiring a resolver into the report — every
     * resolver test calls the function directly, so a row that never got its
     * `resolveSessionName` leaves the whole feature dead with a green suite.
     */
    it('every agent with a readable name store is wired to its resolver', () => {
        for (const kind of ['claude', 'hermes', 'codex'] as const) {
            const row = REMOTE_AGENTS.find((a) => a.kind === kind);
            expect(typeof row?.resolveSessionName, `${kind} row lost its name resolver`).toBe('function');
        }
    });
});

describe('remote-agents.ts: lookups', () => {
    it('findAgentBySubcommand maps cc → claude (alias support)', () => {
        expect(findAgentBySubcommand('cc')?.kind).toBe('claude');
        expect(findAgentBySubcommand('claude')?.kind).toBe('claude');
        expect(findAgentBySubcommand('codex')?.kind).toBe('codex');
        expect(findAgentBySubcommand('gemini')?.kind).toBe('gemini');
        expect(findAgentBySubcommand('hermes')?.kind).toBe('hermes');
        expect(findAgentBySubcommand('pi')?.kind).toBe('pi');
        expect(findAgentBySubcommand('opencode')?.kind).toBe('opencode');
    });

    it('cursor launches the terminal TUI, never the IDE launcher', () => {
        expect(findAgentBySubcommand('cursor')?.binary).toBe('cursor-agent');
        expect(findAgentBySubcommand('cursor-agent')?.kind).toBe('cursor');
    });

    it('matchAgentByPaneCommand accepts registered binaries only', () => {
        expect(matchAgentByPaneCommand('claude')?.kind).toBe('claude');
        expect(matchAgentByPaneCommand('codex')?.kind).toBe('codex');
        expect(matchAgentByPaneCommand('cursor-agent')?.kind).toBe('cursor');
        // The IDE launcher is not an agent pane — a `cursor` pane is someone
        // opening the editor, and adopting it would address a dead session.
        expect(matchAgentByPaneCommand('cursor')).toBeUndefined();
        expect(matchAgentByPaneCommand('hermes')?.kind).toBe('hermes');
        expect(matchAgentByPaneCommand('pi')?.kind).toBe('pi');
        expect(matchAgentByPaneCommand('opencode')?.kind).toBe('opencode');
        expect(matchAgentByPaneCommand('bash')).toBeUndefined();
        expect(matchAgentByPaneCommand('node')).toBeUndefined();
        expect(matchAgentByPaneCommand('')).toBeUndefined();
    });

    // Guards the no-paneMatchAliases decision on the hermes row (see the
    // comment there) against being undone as a "fix" for a pane that stopped
    // matching.
    it('never adopts a bare interpreter pane as an agent', () => {
        expect(matchAgentByPaneCommand('python')).toBeUndefined();
        expect(matchAgentByPaneCommand('python3')).toBeUndefined();
        expect(matchAgentByPaneCommand('python3.11')).toBeUndefined();
    });
});

// ── detectClaudeSessionId (moved here from listener.ts) ──────────

const ENV_KEYS = ['HOME'] as const;
const originalEnv: Record<string, string | undefined> = {};
for (const key of ENV_KEYS) originalEnv[key] = process.env[key];

let TMP: string;

beforeEach(() => {
    TMP = mkdtempSync(join(tmpdir(), 'zeph-remote-agents-test-'));
    process.env.HOME = TMP;
    // CLAUDE_PROJECTS_DIR is computed at module load — reset so the
    // re-import below picks up the overridden HOME (and a fresh cache).
    vi.resetModules();
});

afterEach(() => {
    rmSync(TMP, { recursive: true, force: true });
    for (const key of ENV_KEYS) {
        if (originalEnv[key] === undefined) delete process.env[key];
        else process.env[key] = originalEnv[key];
    }
});

describe('remote-agents.ts: detectClaudeSessionId', () => {
    const UUID_OLD = '11111111-1111-1111-1111-111111111111';
    const UUID_NEW = '22222222-2222-2222-2222-222222222222';

    it('returns the most recently modified <uuid>.jsonl for the cwd', async () => {
        const { detectClaudeSessionId } = await import('./remote-agents.js');
        const cwd = '/some/project';
        const sessionsDir = join(TMP, '.claude', 'projects', cwd.replace(/\//g, '-'));
        mkdirSync(sessionsDir, { recursive: true });
        const past = new Date(Date.now() - 60_000);
        writeFileSync(join(sessionsDir, `${UUID_OLD}.jsonl`), '{}');
        const { utimesSync } = await import('node:fs');
        utimesSync(join(sessionsDir, `${UUID_OLD}.jsonl`), past, past);
        writeFileSync(join(sessionsDir, `${UUID_NEW}.jsonl`), '{}');
        expect(detectClaudeSessionId(cwd)).toBe(UUID_NEW);
    });

    it('ignores non-uuid files and returns null when nothing matches', async () => {
        const { detectClaudeSessionId } = await import('./remote-agents.js');
        const cwd = '/other/project';
        const sessionsDir = join(TMP, '.claude', 'projects', cwd.replace(/\//g, '-'));
        mkdirSync(sessionsDir, { recursive: true });
        writeFileSync(join(sessionsDir, 'notes.txt'), 'x');
        expect(detectClaudeSessionId(cwd)).toBeNull();
    });

    it('returns null when the projects dir does not exist', async () => {
        const { detectClaudeSessionId } = await import('./remote-agents.js');
        expect(detectClaudeSessionId('/never/seen')).toBeNull();
    });
});

describe('detectClaudeSessionIdByPid', () => {
    const records = [
        { pid: 100, sessionId: 'sess-tmux', cwd: '/proj' },
        { pid: 200, sessionId: 'sess-plain', cwd: '/proj' },
        { pid: 300, sessionId: 'sess-other', cwd: '/elsewhere' },
    ];

    it('picks the session whose pid is inside the pane process tree', () => {
        // Pane 90 → shell 95 → claude 100. The plain-cli claude (200)
        // shares the cwd but lives outside this pane's tree.
        const r = detectClaudeSessionIdByPid(90, '/proj', {
            records, descendants: new Set([90, 95, 100]),
        });
        expect(r).toBe('sess-tmux');
    });

    it('does not steal identity from a same-cwd session in another tree', () => {
        const r = detectClaudeSessionIdByPid(90, '/proj', {
            records, descendants: new Set([90, 95, 200]),
        });
        expect(r).toBe('sess-plain');
    });

    it('rejects a pid match with a different cwd (pid reuse guard)', () => {
        const r = detectClaudeSessionIdByPid(90, '/proj', {
            records, descendants: new Set([90, 300]),
        });
        expect(r).toBeNull();
    });

    it('returns null with no records (older CC) — caller falls back to mtime', () => {
        expect(detectClaudeSessionIdByPid(90, '/proj', { records: [], descendants: new Set([90]) })).toBeNull();
    });

    it('matches without cwd when the pane path is unknown', () => {
        const r = detectClaudeSessionIdByPid(90, null, {
            records, descendants: new Set([90, 300]),
        });
        expect(r).toBe('sess-other');
    });
});

describe('parseProcTable', () => {
    // `ps -axo pid=,ppid=,lstart=` on macOS: two spaces before a single-digit
    // day, trailing padding after the year. Measured with `cat -A`, not guessed.
    const REAL = '    1     0 Fri Aug  7 11:12:59 2026    \n  182     1 Tue Aug 11 18:13:52 2026    ';

    it('reads both the parent links and the start times from one table', async () => {
        const { parseProcTable } = await import('./remote-agents.js');
        const { children, startTimes } = parseProcTable(REAL);
        expect(children.get(0)).toEqual([1]);
        expect(children.get(1)).toEqual([182]);
        expect(Number.isFinite(startTimes.get(1))).toBe(true);
        // Aug 11 started after Aug 7 — an ordering the parse cannot fake by
        // returning a constant, and one that holds in any timezone.
        expect(startTimes.get(182)!).toBeGreaterThan(startTimes.get(1)!);
    });

    /**
     * THE regression this file exists for. A start time that this machine's
     * locale cannot parse must cost only the start time. If it took the parent
     * links with it, `collectDescendantPids` would fall back to `{rootPid}` for
     * every pane, `detectClaudeSessionIdByPid` would return null across the
     * board, and Claude Code would silently drop to the mtime heuristic — the
     * identity theft the pid join was built to end (see the comment above
     * CLAUDE_SESSIONS_DIR).
     */
    it('keeps the parent links when the start time is unparseable', async () => {
        const { parseProcTable } = await import('./remote-agents.js');
        const { children, startTimes } = parseProcTable('  95     1 not a date at all\n 100    95 also not a date');
        expect(children.get(1)).toEqual([95]);
        expect(children.get(95)).toEqual([100]);
        expect(startTimes.has(95)).toBe(false);
    });

    it('still reads a two-field table (a caller that asked for no start times)', async () => {
        const { parseProcTable } = await import('./remote-agents.js');
        const { children, startTimes } = parseProcTable('90 1\n95 90\n100 95');
        expect(children.get(90)).toEqual([95]);
        expect(startTimes.size).toBe(0);
    });

    it('ignores lines that are not a process row', async () => {
        const { parseProcTable } = await import('./remote-agents.js');
        const { children } = parseProcTable('PID PPID STARTED\n\n  90     1 Fri Aug  7 11:12:59 2026');
        expect(children.get(1)).toEqual([90]);
        expect(children.size).toBe(1);
    });
});

describe('collectDescendantPids caching', () => {
    // Two resolvers now ask the same pane for its process tree in one report
    // cycle (session id + session name). The `ps` snapshot was already shared;
    // the walk over it was not, so without this memo a pane pays for two BFS
    // passes every five seconds — on the path whose CPU cost is why the caches
    // in this file exist.
    it('serves the same walk to repeated calls for one pane within the snapshot window', async () => {
        const { collectDescendantPids } = await import('./remote-agents.js');
        const first = collectDescendantPids(process.pid);
        const second = collectDescendantPids(process.pid);
        expect(second).toBe(first);
    });

    it('answers with the root alone for a pid that has no children', async () => {
        const { collectDescendantPids } = await import('./remote-agents.js');
        // pid 1 is init/launchd's parent-of-everything, so an unused high pid is
        // the reliable childless case on a live machine.
        expect([...collectDescendantPids(0x7ff_ffff)]).toEqual([0x7ff_ffff]);
    });
});

describe('detectClaudeSessionNameByPid', () => {
    // Names as Claude Code actually writes them: `<cwd-basename>-<hex2>` when
    // derived, free text when the session was named.
    const records = [
        { pid: 100, sessionId: 'sess-tmux', cwd: '/proj', name: 'proj-95' },
        { pid: 200, sessionId: 'sess-plain', cwd: '/proj', name: 'cleanup-pr-rules' },
        { pid: 300, sessionId: 'sess-nameless', cwd: '/elsewhere' },
    ];

    it('returns the name of the session inside the pane process tree', () => {
        expect(detectClaudeSessionNameByPid(90, '/proj', {
            records, descendants: new Set([90, 95, 100]),
        })).toBe('proj-95');
    });

    it('reads the same record the id resolver picked (one lookup, two fields)', () => {
        const deps = { records, descendants: new Set([90, 95, 200]) };
        expect(detectClaudeSessionIdByPid(90, '/proj', deps)).toBe('sess-plain');
        expect(detectClaudeSessionNameByPid(90, '/proj', deps)).toBe('cleanup-pr-rules');
    });

    it('returns null when the matched record carries no name (older CC)', () => {
        expect(detectClaudeSessionNameByPid(90, null, {
            records, descendants: new Set([90, 300]),
        })).toBeNull();
    });

    it('returns null when no record matches the tree', () => {
        expect(detectClaudeSessionNameByPid(90, '/proj', {
            records, descendants: new Set([90]),
        })).toBeNull();
    });

    // A blank name must not reach the wire: renderers treat '' as falsy and fall
    // back, but the change fingerprints collapse only null/undefined, so '' would
    // ride along as a meaningless "change".
    it('normalizes blank and whitespace-only names to null', () => {
        const blank = [{ pid: 100, sessionId: 's', cwd: '/proj', name: '   ' }];
        expect(detectClaudeSessionNameByPid(90, '/proj', {
            records: blank, descendants: new Set([90, 100]),
        })).toBeNull();
    });
});
