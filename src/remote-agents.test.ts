import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectClaudeSessionIdByPid, findAgentBySubcommand, matchAgentByPaneCommand, REMOTE_AGENTS } from './remote-agents.js';

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
});

describe('remote-agents.ts: lookups', () => {
    it('findAgentBySubcommand maps cc → claude (alias support)', () => {
        expect(findAgentBySubcommand('cc')?.kind).toBe('claude');
        expect(findAgentBySubcommand('claude')?.kind).toBe('claude');
        expect(findAgentBySubcommand('codex')?.kind).toBe('codex');
        expect(findAgentBySubcommand('gemini')?.kind).toBe('gemini');
        expect(findAgentBySubcommand('hermes')?.kind).toBe('hermes');
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
