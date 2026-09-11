import { describe, expect, it, vi } from 'vitest';
import { awayForGate, isAway, type PresenceDeps } from './presence.js';

// The TS twin of plugin/hooks/gate.sh zeph_is_away. The cases mirror the
// `away:` block of plugin/tests/test-zeph-stop.sh — same probe order, same
// fallbacks — so the Claude Stop hook and the `notify --auto` hooks agree on
// who counts as away.

const NOW_MS = 1_789_000_000_000;
const NOW_SEC = NOW_MS / 1000;
const TMUX_ENV = { TMUX: '/tmp/tmux-test/default,1,0', TMUX_PANE: '%1' };
const SSH_ENV = { SSH_CONNECTION: '10.0.0.1 22 10.0.0.2 22' };

interface Probes {
    /** HIDIdleTime in seconds; undefined = ioreg fails. */
    hidIdleSec?: number;
    /** list-clients activity lines; undefined = tmux fails. */
    clients?: number[];
}

const makeDeps = (env: Record<string, string>, probes: Probes) => {
    const calls: string[] = [];
    const run = vi.fn((cmd: string): string | null => {
        calls.push(cmd);
        if (cmd === 'ioreg') {
            if (probes.hidIdleSec === undefined) return null;
            return `    | |   "HIDIdleTime" = ${probes.hidIdleSec * 1_000_000_000}\n`;
        }
        if (cmd === 'tmux') {
            if (probes.clients === undefined) return null;
            return probes.clients.map((c) => `${c}\n`).join('');
        }
        return null;
    });
    const deps: PresenceDeps = { env, run, now: () => NOW_MS };
    return { deps, calls };
};

describe('isAway', () => {
    it('no probe answers → present', () => {
        expect(isAway(makeDeps({}, {}).deps)).toBe(false);
    });

    it('HID idle past the threshold → away', () => {
        expect(isAway(makeDeps({}, { hidIdleSec: 400 }).deps)).toBe(true);
    });

    it('HID idle below the threshold → present', () => {
        expect(isAway(makeDeps({}, { hidIdleSec: 5 }).deps)).toBe(false);
    });

    it('ZEPH_AWAY_SEC tunes the threshold', () => {
        expect(isAway(makeDeps({ ZEPH_AWAY_SEC: '60' }, { hidIdleSec: 100 }).deps)).toBe(true);
    });

    it('ZEPH_AWAY_SEC=0 disables detection without probing', () => {
        const { deps, calls } = makeDeps({ ZEPH_AWAY_SEC: '0' }, { hidIdleSec: 100_000 });
        expect(isAway(deps)).toBe(false);
        expect(calls).toEqual([]);
    });

    it.each(['soon', '', '99999999999999999999'])('ZEPH_AWAY_SEC=%j falls back to 300s', (raw) => {
        expect(isAway(makeDeps({ ZEPH_AWAY_SEC: raw }, { hidIdleSec: 400 }).deps)).toBe(true);
        expect(isAway(makeDeps({ ZEPH_AWAY_SEC: raw }, { hidIdleSec: 200 }).deps)).toBe(false);
    });

    it('in tmux with no client attached anywhere → away, even with fresh HID input', () => {
        expect(isAway(makeDeps(TMUX_ENV, { clients: [], hidIdleSec: 1 }).deps)).toBe(true);
    });

    it('in tmux but the server does not answer → present (a failed call is not an empty list)', () => {
        expect(isAway(makeDeps(TMUX_ENV, {}).deps)).toBe(false);
    });

    it('a readable HID wins over a stale tmux client (user in another app)', () => {
        expect(isAway(makeDeps(TMUX_ENV, { clients: [NOW_SEC - 3600], hidIdleSec: 5 }).deps)).toBe(false);
    });

    it('no HID (non-macOS) → tmux activity decides', () => {
        expect(isAway(makeDeps(TMUX_ENV, { clients: [NOW_SEC - 3600] }).deps)).toBe(true);
    });

    it('over SSH the local HID is ignored and the newest client decides', () => {
        const env = { ...TMUX_ENV, ...SSH_ENV };
        expect(isAway(makeDeps(env, { hidIdleSec: 5, clients: [NOW_SEC - 3600, NOW_SEC - 7200] }).deps)).toBe(true);
        expect(isAway(makeDeps(env, { hidIdleSec: 9999, clients: [NOW_SEC - 3600, NOW_SEC - 2] }).deps)).toBe(false);
    });

    it('outside tmux the tmux probe never runs', () => {
        const { deps, calls } = makeDeps({}, { hidIdleSec: 5, clients: [] });
        isAway(deps);
        expect(calls).not.toContain('tmux');
    });
});

describe('awayForGate', () => {
    it('probes on a quiet turn with no high marker', () => {
        const probe = vi.fn(() => true);
        expect(awayForGate('quiet', 'none', probe)).toBe(true);
        expect(probe).toHaveBeenCalledTimes(1);
    });

    it.each([
        ['quiet', 'high'],
        ['normal', 'none'],
        ['loud', 'none'],
    ] as const)('never probes when mode=%s marker=%s (the answer cannot change)', (mode, marker) => {
        const probe = vi.fn(() => true);
        expect(awayForGate(mode, marker, probe)).toBe(false);
        expect(probe).not.toHaveBeenCalled();
    });
});
