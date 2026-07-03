import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findAgentBySubcommand, matchAgentByPaneCommand, REMOTE_AGENTS } from './remote-agents.js';

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

    it('every row has at least one subcommand and a binary', () => {
        for (const a of REMOTE_AGENTS) {
            expect(a.subcommands.length).toBeGreaterThan(0);
            expect(a.binary.length).toBeGreaterThan(0);
        }
    });

    it('only claude carries a session resolver (codex/gemini are documented stubs)', () => {
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
        expect(findAgentBySubcommand('cursor')).toBeUndefined();
    });

    it('matchAgentByPaneCommand accepts registered binaries only', () => {
        expect(matchAgentByPaneCommand('claude')?.kind).toBe('claude');
        expect(matchAgentByPaneCommand('codex')?.kind).toBe('codex');
        expect(matchAgentByPaneCommand('bash')).toBeUndefined();
        expect(matchAgentByPaneCommand('node')).toBeUndefined();
        expect(matchAgentByPaneCommand('')).toBeUndefined();
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
