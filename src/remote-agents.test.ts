import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
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

    // A row that can find a transcript but not read one is the worst of the
    // three states: the watcher accepts the watch, tails a file nothing parses,
    // and the phone shows an empty timeline that reads as a hung agent. The
    // honest `no_transcript` a resolver-less row produces is strictly better,
    // so half a pair must fail here rather than on someone's phone.
    it('a row resolves a transcript and reads it, or does neither', () => {
        for (const a of REMOTE_AGENTS) {
            expect(
                Boolean(a.resolveTranscript),
                `${a.kind}: resolveTranscript and projectTranscript must be set together`,
            ).toBe(Boolean(a.projectTranscript));
        }
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

    it('reads comm with spaces after the 5-token lstart, plus pgid/tpgid', async () => {
        const { parseProcTable } = await import('./remote-agents.js');
        const t = parseProcTable('  501   400   501   501 Fri Aug  7 11:12:59 2026 tmux: client\n  502   501   777   777 Fri Aug  7 11:13:59 2026 pi');
        expect(t.pgidOf.get(501)).toBe(501);
        expect(t.tpgidOf.get(501)).toBe(501);
        expect(t.commOf.get(501)).toBe('tmux: client');
        expect(t.pgidOf.get(502)).toBe(777);
        expect(t.tpgidOf.get(502)).toBe(777);
        expect(t.commOf.get(502)).toBe('pi');
        expect(Number.isFinite(t.startTimes.get(501))).toBe(true);
    });

    it('ignores lines that are not a process row', async () => {
        const { parseProcTable } = await import('./remote-agents.js');
        const { children } = parseProcTable('PID PPID STARTED\n\n  90     1 Fri Aug  7 11:12:59 2026');
        expect(children.get(1)).toEqual([90]);
        expect(children.size).toBe(1);
    });
});

describe('ps snapshot under a non-English locale', () => {
    // A listener started with LANG=ko_KR.UTF-8 got `목  9/24 21:00:39 2026`
    // (4 tokens) or `2026년  9월 24일 목요일 21시 03분 05초` (7) for lstart,
    // so the 5-token cut swallowed or left behind the comm and no pi
    // subagent pane was ever reported (measured 2026-09-24, takui-MacBookPro).
    const saved = { LANG: process.env.LANG, LC_ALL: process.env.LC_ALL, LC_TIME: process.env.LC_TIME };
    afterEach(() => {
        for (const [k, v] of Object.entries(saved)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    });

    it('still reads start times when the listener runs in ko_KR', async () => {
        process.env.LANG = 'ko_KR.UTF-8';
        process.env.LC_ALL = 'ko_KR.UTF-8';
        process.env.LC_TIME = 'ko_KR.UTF-8';
        vi.resetModules();
        const { psStartTimes } = await import('./remote-agents.js');
        expect(Number.isFinite(psStartTimes().get(process.pid))).toBe(true);
    });
});

describe('foregroundAgentFor — subagent pane detection', () => {
    // A subagent pane's tmux view: pane_pid is the login zsh, but the tty's
    // foreground group is the bash→pi script's group (measured 15:25). A plain
    // prompt has the shell's own group in the foreground.
    const TABLE = [
        '  600     1   600   900 Fri Aug  7 11:12:59 2026 zsh',      // subagent pane's login shell — tty fg group is 900
        '  601   600   900   900 Fri Aug  7 11:12:59 2026 bash',     // the script
        '  602   601   900   900 Fri Aug  7 11:12:59 2026 pi',       // pi in the fg group
        '  610     1   610   610 Fri Aug  7 11:12:59 2026 zsh',      // plain prompt pane
        '  611   610   910   610 Fri Aug  7 11:12:59 2026 vim',      // suspended-ish: fg tty group is the shell's
    ].join('\n');

    it('detects the agent in the foreground group of a subagent pane', async () => {
        const { foregroundAgentFor, parseProcTable } = await import('./remote-agents.js');
        const agent = foregroundAgentFor(600, parseProcTable(TABLE));
        expect(agent?.kind).toBe('pi');
    });

    it('a pane at its login shell prompt is not a subagent', async () => {
        const { foregroundAgentFor, parseProcTable } = await import('./remote-agents.js');
        expect(foregroundAgentFor(610, parseProcTable(TABLE))).toBeNull();
    });

    it('a pane whose tty group holds no registered agent is not a subagent', async () => {
        const { foregroundAgentFor, parseProcTable } = await import('./remote-agents.js');
        const noAgent = parseProcTable('  620     1   620   620 Fri Aug  7 11:12:59 2026 zsh\n  621   620   920   920 Fri Aug  7 11:12:59 2026 bash');
        expect(foregroundAgentFor(620, noAgent)).toBeNull();
    });

    it('answers null without a usable table (ps failed — no subagents this cycle)', async () => {
        const { foregroundAgentFor } = await import('./remote-agents.js');
        expect(foregroundAgentFor(600, null)).toBeNull();
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

// ── piTranscriptPath ─────────────────────────────────────────────

/**
 * The encoding here is not ours and was not guessed. It is copied from pi's own
 * writer, `@earendil-works/pi-coding-agent/dist/core/session-manager.js:245`
 * (`getDefaultSessionDirPath`), read 2026-09-14:
 *
 *     `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`
 *
 * The dot case is why that matters. Claude Code maps `.` to `-` as well; pi does
 * not. Inferring pi's rule from Claude's would resolve every dotted directory to
 * a path that has never existed, and the watcher would poll it forever without
 * ever saying why.
 */
describe('remote-agents.ts: piTranscriptPath', () => {
    const piDirFor = (encoded: string) => join(TMP, '.pi', 'agent', 'sessions', encoded);

    const writeSession = (encoded: string, file: string, at?: Date) => {
        const dir = piDirFor(encoded);
        mkdirSync(dir, { recursive: true });
        const path = join(dir, file);
        writeFileSync(path, '{"type":"session","version":3}\n');
        if (at) utimesSync(path, at, at);
        return path;
    };

    it.each([
        ['/Users/tak/projects/app', '--Users-tak-projects-app--'],
        // The case Claude's encoder would get wrong: pi keeps the dot.
        ['/Users/tak/.config/thing', '--Users-tak-.config-thing--'],
        ['/Users/tak/repo.git/sub', '--Users-tak-repo.git-sub--'],
        // A path segment that already starts with a dash — the encoding is not
        // reversible, and does not need to be.
        ['/private/tmp/x/-Users-y/scratch', '--private-tmp-x--Users-y-scratch--'],
    ])('encodes %s the way pi encodes it', async (cwd, encoded) => {
        const { piTranscriptPath } = await import('./remote-agents.js');
        const expected = writeSession(encoded, '2026-09-14T00-00-00-000Z_01a079a7.jsonl');

        expect(piTranscriptPath(cwd)).toBe(expected);
    });

    it('takes the most recently written session in the directory', async () => {
        const { piTranscriptPath } = await import('./remote-agents.js');
        const encoded = '--Users-tak-projects-app--';
        const past = new Date(Date.now() - 60_000);
        writeSession(encoded, '2026-09-01T00-00-00-000Z_old.jsonl', past);
        const newest = writeSession(encoded, '2026-09-14T00-00-00-000Z_new.jsonl');

        expect(piTranscriptPath('/Users/tak/projects/app')).toBe(newest);
    });

    it('ignores the loadout sidecar pi writes beside every session', async () => {
        const { piTranscriptPath } = await import('./remote-agents.js');
        const encoded = '--Users-tak-projects-app--';
        const transcript = writeSession(encoded, '2026-09-14T00-00-00-000Z_s.jsonl', new Date(Date.now() - 60_000));
        writeSession(encoded, '2026-09-14T00-00-00-000Z_s.jsonl.loadout.json');

        expect(piTranscriptPath('/Users/tak/projects/app')).toBe(transcript);
    });

    // pi encodes `resolvePath(cwd)`, not the raw string
    // (`…/pi-coding-agent/dist/core/session-manager.js:243-245` + `utils/paths.js:82-86`).
    // Encoding the raw string turns a trailing slash into `--a-b---` and leaves
    // `..` in the directory name, both of which are paths pi never wrote.
    it.each([
        ['/Users/tak/projects/app/', 'a trailing slash'],
        ['/Users/tak/projects/./app', 'a dot segment'],
        ['/Users/tak/projects/other/../app', 'a parent segment'],
        ['/Users/tak//projects/app', 'a doubled separator'],
    ])('normalizes %s (%s) the way pi does before encoding', async (cwd) => {
        const { piTranscriptPath } = await import('./remote-agents.js');
        const expected = writeSession('--Users-tak-projects-app--', '2026-09-14T00-00-00-000Z_s.jsonl');

        expect(piTranscriptPath(cwd)).toBe(expected);
    });

    // `turn-watch` re-resolves every TRANSCRIPT_RECHECK_MS per watcher, and a
    // directory someone has run pi in for months holds one file per run.
    it('does not re-scan the directory for the same pane', async () => {
        const { piTranscriptPath } = await import('./remote-agents.js');
        const dir = piDirFor('--Users-tak-projects-app--');
        const path = writeSession('--Users-tak-projects-app--', '2026-09-14T00-00-00-000Z_s.jsonl');

        expect(piTranscriptPath('/Users/tak/projects/app', 4242)).toBe(path);

        // The directory is gone; only a cached answer can still name the file.
        // Proving it this way rather than by spying on `readdirSync`, which the
        // module binds at import and a namespace spy never reaches.
        rmSync(dir, { recursive: true, force: true });
        expect(piTranscriptPath('/Users/tak/projects/app', 4242)).toBe(path);
    });

    // A pi that was restarted in the same directory writes a new file. Keyed on
    // cwd alone, the watch would follow the dead session's transcript for the
    // rest of the TTL — far longer than the 10s recheck that should have caught it.
    it('resolves again when the pane is a different process', async () => {
        const { piTranscriptPath } = await import('./remote-agents.js');
        const encoded = '--Users-tak-projects-app--';
        const first = writeSession(encoded, '2026-09-14T00-00-00-000Z_old.jsonl', new Date(Date.now() - 60_000));

        expect(piTranscriptPath('/Users/tak/projects/app', 1111)).toBe(first);

        const restarted = writeSession(encoded, '2026-09-14T01-00-00-000Z_new.jsonl');
        expect(piTranscriptPath('/Users/tak/projects/app', 1111)).toBe(first);
        expect(piTranscriptPath('/Users/tak/projects/app', 2222)).toBe(restarted);
    });

    // pi reads PI_CODING_AGENT_DIR before falling back to ~/.pi/agent
    // (`…/pi-coding-agent/dist/config.js:406,421-426`).
    it('follows PI_CODING_AGENT_DIR, the override pi itself honours', async () => {
        const { piTranscriptPath } = await import('./remote-agents.js');
        const elsewhere = join(TMP, 'custom-agent-dir');
        process.env.PI_CODING_AGENT_DIR = elsewhere;
        try {
            const dir = join(elsewhere, 'sessions', '--Users-tak-projects-app--');
            mkdirSync(dir, { recursive: true });
            const path = join(dir, '2026-09-14T00-00-00-000Z_s.jsonl');
            writeFileSync(path, '{"type":"session","version":3}\n');

            expect(piTranscriptPath('/Users/tak/projects/app')).toBe(path);
        } finally {
            delete process.env.PI_CODING_AGENT_DIR;
        }
    });

    it('answers null for a directory pi has never run in, and for no cwd at all', async () => {
        const { piTranscriptPath } = await import('./remote-agents.js');

        expect(piTranscriptPath('/nowhere/pi/has/been')).toBeNull();
        expect(piTranscriptPath(null)).toBeNull();
    });
});

// ── codexTranscriptPath ──────────────────────────────────────────

/**
 * Codex shards its rollouts by date and puts no cwd anywhere in the path — the
 * cwd is inside the file, on the `session_meta` first line. So unlike pi's and
 * Claude's resolvers, this one cannot answer from a directory name and has to
 * open files, which is what every bound and cache below exists to limit.
 *
 * Shape measured 2026-09-14 against `~/.codex/sessions/2026/09/14/rollout-…jsonl`
 * written by codex-cli 0.154.0.
 */
describe('remote-agents.ts: codexTranscriptPath', () => {
    const META = (cwd: string, timestamp = '2026-09-14T00:00:00.000Z') =>
        JSON.stringify({ timestamp, type: 'session_meta', payload: { cwd, timestamp, id: 'x' } });

    const writeRollout = (shard: string, file: string, header: string, at?: Date): string => {
        const dir = join(TMP, '.codex', 'sessions', shard);
        mkdirSync(dir, { recursive: true });
        const path = join(dir, file);
        writeFileSync(path, `${header}\n{"type":"event_msg","payload":{"type":"task_started"}}\n`);
        if (at) utimesSync(path, at, at);
        return path;
    };

    it('finds the rollout whose session_meta names this pane directory', async () => {
        const { codexTranscriptPath } = await import('./remote-agents.js');
        writeRollout('2026/09/14', 'rollout-a.jsonl', META('/Users/tak/other'));
        const mine = writeRollout('2026/09/14', 'rollout-b.jsonl', META('/Users/tak/app'));

        expect(codexTranscriptPath('/Users/tak/app')).toBe(mine);
    });

    // The cwd comparison happens after the same normalization pi's encoder does,
    // because tmux reports what the shell reports and a trailing slash there
    // would otherwise miss every rollout Codex ever wrote for that directory.
    it.each([
        ['/Users/tak/app/', 'a trailing slash'],
        ['/Users/tak/./app', 'a dot segment'],
        ['/Users/tak/other/../app', 'a parent segment'],
    ])('normalizes %s (%s) before comparing', async (cwd) => {
        const { codexTranscriptPath } = await import('./remote-agents.js');
        const mine = writeRollout('2026/09/14', 'rollout-b.jsonl', META('/Users/tak/app'));

        expect(codexTranscriptPath(cwd)).toBe(mine);
    });

    it('answers null when no rollout names this directory', async () => {
        const { codexTranscriptPath } = await import('./remote-agents.js');
        writeRollout('2026/09/14', 'rollout-a.jsonl', META('/Users/tak/other'));

        expect(codexTranscriptPath('/Users/tak/app')).toBeNull();
        expect(codexTranscriptPath(null)).toBeNull();
    });

    it('takes the most recently written of several rollouts for the directory', async () => {
        const { codexTranscriptPath } = await import('./remote-agents.js');
        writeRollout('2026/09/14', 'rollout-old.jsonl', META('/Users/tak/app'), new Date(Date.now() - 60_000));
        const newest = writeRollout('2026/09/14', 'rollout-new.jsonl', META('/Users/tak/app'));

        expect(codexTranscriptPath('/Users/tak/app')).toBe(newest);
    });

    /*
     * The scan is bounded to the two newest date shards. Unbounded, a machine
     * someone has run Codex on for a year would open and parse a 22KB header out
     * of every rollout ever written, every time a watch re-resolved.
     */
    it('never opens a shard older than the two newest', async () => {
        const { codexTranscriptPath } = await import('./remote-agents.js');
        writeRollout('2026/09/10', 'rollout-ancient.jsonl', META('/Users/tak/app'));
        writeRollout('2026/09/13', 'rollout-yesterday.jsonl', META('/Users/tak/other'));
        writeRollout('2026/09/14', 'rollout-today.jsonl', META('/Users/tak/other'));

        expect(codexTranscriptPath('/Users/tak/app')).toBeNull();
    });

    it('reaches a session started before midnight and still running', async () => {
        const { codexTranscriptPath } = await import('./remote-agents.js');
        const yesterday = writeRollout('2026/09/13', 'rollout-y.jsonl', META('/Users/tak/app'));
        writeRollout('2026/09/14', 'rollout-t.jsonl', META('/Users/tak/other'));

        expect(codexTranscriptPath('/Users/tak/app')).toBe(yesterday);
    });

    it('skips a file that is not a session_meta header, and one with no line at all', async () => {
        const { codexTranscriptPath } = await import('./remote-agents.js');
        writeRollout('2026/09/14', 'rollout-headerless.jsonl', '{"type":"event_msg","payload":{}}');
        writeRollout('2026/09/14', 'rollout-truncated.jsonl', '{"type":"session_meta","payl');
        writeRollout('2026/09/14', 'rollout-garbage.jsonl', 'not json at all');

        expect(codexTranscriptPath('/Users/tak/app')).toBeNull();
    });

    /*
     * `session_meta` carries `base_instructions` — measured at 21551 bytes of a
     * 22049-byte header — and that field grows with the user's AGENTS.md and
     * skill set. A fixed single read is a bound someone eventually crosses, and
     * crossing it answers null forever: "this agent has no live timeline", with
     * nothing to say why.
     */
    it('reads a header far past one chunk, and one with a multi-byte character across the boundary', async () => {
        const { codexTranscriptPath } = await import('./remote-agents.js');
        const header = JSON.stringify({
            type: 'session_meta',
            // 3 bytes each, so the 65536 and 131072 chunk boundaries both land
            // on a continuation byte — decoding per chunk would corrupt them.
            payload: { cwd: '/Users/tak/app', timestamp: '2026-09-14T00:00:00.000Z', base_instructions: `${'가'.repeat(50_000)}x` },
        });
        const path = writeRollout('2026/09/14', 'rollout-huge.jsonl', header);

        expect(codexTranscriptPath('/Users/tak/app')).toBe(path);
    });

    // The reader's outer cap is a bound on work, not on the answer, so what is
    // pinned here is the answer: a file with no line ending is not a rollout and
    // must not become one. That it stops reading at CODEX_HEADER_MAX rather than
    // consuming the file is stated in the reader and not asserted here — a test
    // that proved it would have to measure the read itself.
    it('answers null for a file with no line ending at all', async () => {
        const { codexTranscriptPath } = await import('./remote-agents.js');
        const dir = join(TMP, '.codex', 'sessions', '2026', '09', '14');
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'rollout-runaway.jsonl'), 'x'.repeat(2 * 1024 * 1024));

        expect(codexTranscriptPath('/Users/tak/app')).toBeNull();
    });

    it('ignores files in the shard that are not rollouts', async () => {
        const { codexTranscriptPath } = await import('./remote-agents.js');
        writeRollout('2026/09/14', 'notes.jsonl', META('/Users/tak/app'));
        writeRollout('2026/09/14', 'rollout-a.json', META('/Users/tak/app'));

        expect(codexTranscriptPath('/Users/tak/app')).toBeNull();
    });

    // Opening a 22KB header out of every rollout in two shards is the most
    // expensive resolver here, and `turn-watch` re-resolves every
    // TRANSCRIPT_RECHECK_MS per watcher.
    it('does not re-scan the shards for the same pane', async () => {
        const { codexTranscriptPath } = await import('./remote-agents.js');
        const path = writeRollout('2026/09/14', 'rollout-a.jsonl', META('/Users/tak/app'));

        expect(codexTranscriptPath('/Users/tak/app', 4242)).toBe(path);

        // The tree is gone; only a cached answer can still name the file.
        rmSync(join(TMP, '.codex'), { recursive: true, force: true });
        expect(codexTranscriptPath('/Users/tak/app', 4242)).toBe(path);
    });

    it('resolves again when the pane is a different process', async () => {
        const { codexTranscriptPath } = await import('./remote-agents.js');
        const first = writeRollout('2026/09/14', 'rollout-a.jsonl', META('/Users/tak/app'), new Date(Date.now() - 60_000));

        expect(codexTranscriptPath('/Users/tak/app', 1111)).toBe(first);

        const restarted = writeRollout('2026/09/14', 'rollout-b.jsonl', META('/Users/tak/app'));
        expect(codexTranscriptPath('/Users/tak/app', 1111)).toBe(first);
        expect(codexTranscriptPath('/Users/tak/app', 2222)).toBe(restarted);
    });

    // The binary reports `CODEX_HOME` in its own `doctor` output and carries
    // `failed to resolve CODEX_HOME`, so the override is the writer's, not ours.
    it('follows CODEX_HOME, the override Codex itself honours', async () => {
        const { codexTranscriptPath } = await import('./remote-agents.js');
        const elsewhere = join(TMP, 'custom-codex-home');
        process.env.CODEX_HOME = elsewhere;
        try {
            const dir = join(elsewhere, 'sessions', '2026', '09', '14');
            mkdirSync(dir, { recursive: true });
            const path = join(dir, 'rollout-a.jsonl');
            writeFileSync(path, `${META('/Users/tak/app')}\n`);

            expect(codexTranscriptPath('/Users/tak/app')).toBe(path);
        } finally {
            delete process.env.CODEX_HOME;
        }
    });
});
