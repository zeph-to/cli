/**
 * Which tmux session `zeph cc` lands in.
 *
 * The rule that matters is not "pick a free name" — it is that no session in
 * the `zeph-<project>` family may become unreachable. A session nobody can get
 * back to still holds a live agent process (a Claude Code CLI plus its whole
 * MCP fleet, 250-550MB measured), so an unreachable one is memory the user
 * cannot see and cannot reclaim.
 *
 * tmux is faked wholesale, as in listener-session-forget.test.ts: what is under
 * test is the pick, not tmux.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** session name → attached, as tmux would report it right now. */
let live = new Map<string, boolean>();
/** Every tmux argv the pick issued — the spawn budget is part of the contract. */
let calls: string[][] = [];
/** When false, `tmux list-sessions` fails the way it does with no server up. */
let serverUp = true;

const fakeTmux = (args: readonly string[]) => {
    calls.push([...args]);
    if (args[0] === 'list-sessions') {
        if (!serverUp) return { status: 1, stdout: '', stderr: 'no server running' };
        const stdout = [...live].map(([name, att]) => `${att ? 1 : 0} ${name}`).join('\n');
        return { status: 0, stdout, stderr: '' };
    }
    if (args[0] === 'has-session') {
        return { status: live.has(args[2] ?? '') ? 0 : 1, stdout: '', stderr: '' };
    }
    if (args[0] === 'list-clients') {
        return { status: 0, stdout: live.get(args[2] ?? '') ? '/dev/ttys001' : '', stderr: '' };
    }
    return { status: 1, stdout: '', stderr: '' };
};

vi.mock('child_process', async (importOriginal) => {
    const actual = await importOriginal<typeof import('child_process')>();
    return {
        ...actual,
        spawnSync: (cmd: string, args?: readonly string[]) =>
            cmd === 'tmux' ? fakeTmux(args ?? []) : { status: 1, stdout: '', stderr: '' },
    };
});

const { findAvailableSession } = await import('./wrapper.js');

const sessions = (spec: Record<string, 'attached' | 'detached'>): void => {
    live = new Map(Object.entries(spec).map(([n, s]) => [n, s === 'attached']));
};

beforeEach(() => {
    live = new Map();
    calls = [];
    serverUp = true;
});

describe('findAvailableSession', () => {
    it('creates the base name when the family is empty', () => {
        expect(findAvailableSession('zeph-foo')).toBe('zeph-foo');
    });

    it('creates the base name when no tmux server is running', () => {
        serverUp = false;
        expect(findAvailableSession('zeph-foo')).toBe('zeph-foo');
    });

    it('reattaches a detached base', () => {
        sessions({ 'zeph-foo': 'detached' });
        expect(findAvailableSession('zeph-foo')).toBe('zeph-foo');
    });

    it('opens an independent session when the base is attached', () => {
        sessions({ 'zeph-foo': 'attached' });
        expect(findAvailableSession('zeph-foo')).toBe('zeph-foo-2');
    });

    it('reattaches a detached suffix rather than opening a third session', () => {
        sessions({ 'zeph-foo': 'attached', 'zeph-foo-2': 'detached' });
        expect(findAvailableSession('zeph-foo')).toBe('zeph-foo-2');
    });

    it('skips past a whole attached family', () => {
        sessions({ 'zeph-foo': 'attached', 'zeph-foo-2': 'attached' });
        expect(findAvailableSession('zeph-foo')).toBe('zeph-foo-3');
    });

    // The stranding case. Once the base is detached the old scan returned it and
    // never looked further, so `zeph-foo-2` could not be reached by any future
    // `zeph cc` — not after the base was used and exited (the base is then
    // missing, and a missing base is taken fresh), not ever. Draining the
    // highest detached suffix first is what makes the tail reachable again.
    it('reattaches the highest detached suffix, not the detached base', () => {
        sessions({ 'zeph-foo': 'detached', 'zeph-foo-2': 'detached' });
        expect(findAvailableSession('zeph-foo')).toBe('zeph-foo-2');
    });

    it('leaves the base reachable on the next run once the tail is drained', () => {
        sessions({ 'zeph-foo': 'detached' });
        expect(findAvailableSession('zeph-foo')).toBe('zeph-foo');
    });

    it('prefers a detached session over a free name in a gap', () => {
        sessions({ 'zeph-foo': 'attached', 'zeph-foo-3': 'detached' });
        expect(findAvailableSession('zeph-foo')).toBe('zeph-foo-3');
    });

    it('ignores sessions of other projects that share a name prefix', () => {
        sessions({ 'zeph-foobar': 'detached', 'zeph-foo-bar': 'detached' });
        expect(findAvailableSession('zeph-foo')).toBe('zeph-foo');
    });

    it('handles a project name containing spaces', () => {
        sessions({ 'zeph-my app': 'attached', 'zeph-my app-2': 'detached' });
        expect(findAvailableSession('zeph-my app')).toBe('zeph-my app-2');
    });

    // Documented fallback, unreachable in practice: 20 attached sessions for
    // one project. Nothing is free and nothing is detached, so the base is
    // returned and `tmux new -A` joins a session someone else is looking at.
    // Recorded so the family is not mistaken for exhaustively safe.
    it('falls back to the base when all 20 of the family are attached', () => {
        const all: Record<string, 'attached'> = { 'zeph-foo': 'attached' };
        for (let i = 2; i <= 20; i++) all[`zeph-foo-${i}`] = 'attached';
        sessions(all);
        expect(findAvailableSession('zeph-foo')).toBe('zeph-foo');
    });

    // The pick runs on every `zeph cc`, on a box that may already be thrashing.
    // One spawn for the whole family, not two per candidate name.
    it('asks tmux exactly once', () => {
        sessions({ 'zeph-foo': 'attached', 'zeph-foo-2': 'attached', 'zeph-foo-3': 'detached' });
        findAvailableSession('zeph-foo');
        expect(calls).toHaveLength(1);
        expect(calls[0][0]).toBe('list-sessions');
    });
});
