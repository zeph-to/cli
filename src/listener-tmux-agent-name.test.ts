/**
 * Publishing the agent's own session name onto the tmux session.
 *
 * The phone shows `zeph-to-d0 · Claude Code` while the user's status bar shows
 * `zeph-zeph-to-3`. This mirrors the middle tier of the phone's render
 * precedence into a tmux user option so a status line can read it — without
 * renaming the tmux session, which is the address the phone injects against.
 *
 * What is under test is the write gate, not tmux: a spawn per session per
 * five-second sweep is what this cache exists to avoid, and a tmux name is a
 * reusable slot, so an unchanged key must not let a new occupant inherit the
 * previous one's write.
 */
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** Every tmux argv issued, in order. */
let calls: string[][] = [];
/** Sessions whose `set-option` should fail, as an unreachable tmux would. */
let failFor = new Set<string>();

vi.mock('child_process', async (importOriginal) => {
    const actual = await importOriginal<typeof import('child_process')>();
    return {
        ...actual,
        spawnSync: (cmd: string, args?: readonly string[]) => {
            if (cmd !== 'tmux') return { status: 1, stdout: '', stderr: '' };
            const a = args?.[0] === '-S' ? args.slice(2) : (args ?? []);
            calls.push([...a]);
            const target = a[a.indexOf('-t') + 1] ?? '';
            return { status: failFor.has(target) ? 1 : 0, stdout: '', stderr: '' };
        },
    };
});

const TMP = mkdtempSync(join(tmpdir(), 'zeph-tmuxname-'));
process.env.HOME = TMP;
process.env.XDG_STATE_HOME = join(TMP, 'state');

const { syncTmuxAgentNames } = await import('./listener.js');

/** Just the fields the publisher reads. */
const session = (name: string, providerSessionName: string | null, createdAt = '2026-08-31T00:00:00.000Z') =>
    ({ name, attached: true, agentKind: 'claude', project: name, providerSessionName, createdAt }) as never;

const setCalls = () => calls.filter((a) => a[0] === 'set-option');

beforeEach(() => {
    calls = [];
    failFor = new Set();
    // Drop whatever a previous test left in the module-level cache by sweeping
    // an empty inventory: every key goes stale and is evicted.
    syncTmuxAgentNames([]);
    calls = [];
});

describe('syncTmuxAgentNames', () => {
    it('writes the provider name as @zeph_agent_name', () => {
        syncTmuxAgentNames([session('zeph-zeph-to-3', 'zeph-to-d0')]);
        expect(setCalls()).toEqual([
            ['set-option', '-t', 'zeph-zeph-to-3', '@zeph_agent_name', 'zeph-to-d0'],
        ]);
    });

    it('never renames the tmux session', () => {
        syncTmuxAgentNames([session('zeph-zeph-to-3', 'zeph-to-d0')]);
        expect(calls.some((a) => a[0] === 'rename-session')).toBe(false);
    });

    // The whole point of the cache: this runs every five seconds per session.
    it('writes nothing on a second sweep with the same name', () => {
        syncTmuxAgentNames([session('zeph-zeph-to-3', 'zeph-to-d0')]);
        calls = [];
        syncTmuxAgentNames([session('zeph-zeph-to-3', 'zeph-to-d0')]);
        expect(calls).toEqual([]);
    });

    it('rewrites when the agent renames its session', () => {
        syncTmuxAgentNames([session('zeph-zeph-to-3', 'zeph-to-d0')]);
        calls = [];
        syncTmuxAgentNames([session('zeph-zeph-to-3', 'orca-debug')]);
        expect(setCalls()).toEqual([
            ['set-option', '-t', 'zeph-zeph-to-3', '@zeph_agent_name', 'orca-debug'],
        ]);
    });

    // Unset rather than set-empty, so the status format falls through to #S and
    // no stale name outlives the agent that reported it.
    it('unsets the option when the agent reports no name', () => {
        syncTmuxAgentNames([session('zeph-zeph-to-3', 'zeph-to-d0')]);
        calls = [];
        syncTmuxAgentNames([session('zeph-zeph-to-3', null)]);
        expect(setCalls()).toEqual([
            ['set-option', '-u', '-t', 'zeph-zeph-to-3', '@zeph_agent_name'],
        ]);
    });

    // A tmux name is a slot. Same name, different session -- the cache must not
    // report the write as already done.
    it('rewrites for a new session that took the same tmux name', () => {
        syncTmuxAgentNames([session('zeph-zeph-to-3', 'zeph-to-d0', '2026-08-31T00:00:00.000Z')]);
        calls = [];
        syncTmuxAgentNames([session('zeph-zeph-to-3', 'zeph-to-d0', '2026-08-31T09:00:00.000Z')]);
        expect(setCalls()).toEqual([
            ['set-option', '-t', 'zeph-zeph-to-3', '@zeph_agent_name', 'zeph-to-d0'],
        ]);
    });

    it('retries a write that failed instead of caching it as done', () => {
        failFor = new Set(['zeph-zeph-to-3']);
        syncTmuxAgentNames([session('zeph-zeph-to-3', 'zeph-to-d0')]);
        expect(setCalls()).toHaveLength(1);
        calls = [];
        failFor = new Set();
        syncTmuxAgentNames([session('zeph-zeph-to-3', 'zeph-to-d0')]);
        expect(setCalls()).toHaveLength(1);
    });

    it('writes once per session across a mixed sweep', () => {
        syncTmuxAgentNames([
            session('zeph-zeph-to', 'zeph-to-95'),
            session('zeph-muzly-app', null),
            session('zeph-debegi', 'debegi-fa'),
        ]);
        expect(setCalls()).toHaveLength(3);
    });
});
