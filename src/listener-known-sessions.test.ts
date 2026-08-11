/**
 * What the daemon tells the phone about sessions it is no longer running.
 *
 * The phone used to work this out for itself by reading a page of recent
 * pushes, which answered a different question than the one being asked. This
 * machine already keeps the answer — the same registry the resume path reads —
 * so the report carries it and the list stops disagreeing with the button.
 */

import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it, beforeEach, vi } from 'vitest';

vi.mock('child_process', async (importOriginal) => {
    const actual = await importOriginal<typeof import('child_process')>();
    return {
        ...actual,
        spawnSync: () => ({ status: 1, stdout: '', stderr: '' }),
    };
});

const TMP = mkdtempSync(join(tmpdir(), 'zeph-known-'));
process.env.HOME = TMP;
process.env.XDG_STATE_HOME = join(TMP, 'state');

const {
    knownSessionsToReport,
    knownSessionsFingerprint,
    KNOWN_SESSIONS_REPORTED,
} = await import('./listener.js');
const { rememberSessions } = await import('./session-registry.js');

/** A live-inventory entry, as `collectSessions` would report it. */
const live = (name: string) => ({
    name,
    attached: false,
    agentKind: 'claude' as const,
    project: 'proj',
});

describe('known sessions in the inventory report', () => {
    beforeEach(() => {
        rmSync(join(TMP, 'state'), { recursive: true, force: true });
    });

    const remember = (names: string[], at?: number) =>
        rememberSessions(
            names.map((name) => ({ name, cwd: '/work/proj', agentKind: 'claude', project: 'proj' })),
            at,
        );

    it('reports what this machine has run', () => {
        remember(['zeph-api', 'zeph-web']);

        expect(knownSessionsToReport([]).map((k) => k.name).sort()).toEqual([
            'zeph-api',
            'zeph-web',
        ]);
    });

    /**
     * Not just tidiness. A live session's `lastSeenAt` moves every sweep, and a
     * field that changes every five seconds would defeat the report's
     * unchanged-inventory gate — the daemon would write to the device record
     * all day for a list nobody watched change.
     */
    it('leaves out the sessions that are running right now', () => {
        remember(['zeph-api', 'zeph-web']);

        const reported = knownSessionsToReport([live('zeph-api')]);

        expect(reported.map((k) => k.name)).toEqual(['zeph-web']);
    });

    it('keeps the same fingerprint while nothing has changed', () => {
        remember(['zeph-api', 'zeph-web']);
        const first = knownSessionsFingerprint(knownSessionsToReport([live('zeph-api')]));

        // A later sweep of the same machine, with the live session still live.
        const second = knownSessionsFingerprint(knownSessionsToReport([live('zeph-api')]));

        expect(second).toBe(first);
    });

    it('changes fingerprint when a session ends', () => {
        remember(['zeph-api', 'zeph-web']);
        const whileRunning = knownSessionsFingerprint(knownSessionsToReport([live('zeph-api')]));

        const afterItEnded = knownSessionsFingerprint(knownSessionsToReport([]));

        expect(afterItEnded).not.toBe(whileRunning);
    });

    /**
     * The registry keeps a cwd because resume needs somewhere to start the
     * agent. Nothing off this machine needs a filesystem path, and sending one
     * would hand the relay a map of the user's disk for no behaviour in return.
     */
    it('never sends the directory off this machine', () => {
        remember(['zeph-api']);

        const [reported] = knownSessionsToReport([]);

        expect(reported).not.toHaveProperty('cwd');
        expect(Object.keys(reported).sort()).toEqual([
            'agentKind',
            'lastSeenAt',
            'name',
            'project',
        ]);
    });

    it('sends the newest, and no more than the cap', () => {
        const names = Array.from({ length: KNOWN_SESSIONS_REPORTED + 5 }, (_, i) => `zeph-${i}`);
        // One per minute, oldest first, so "newest" is unambiguous.
        names.forEach((name, i) => remember([name], Date.parse('2026-08-10T00:00:00Z') + i * 60_000));

        const reported = knownSessionsToReport([], Date.parse('2026-08-10T02:00:00Z'));

        expect(reported).toHaveLength(KNOWN_SESSIONS_REPORTED);
        expect(reported[0].name).toBe(`zeph-${names.length - 1}`);
    });

    it('reports nothing on a machine that has run nothing', () => {
        expect(knownSessionsToReport([])).toEqual([]);
    });
});
