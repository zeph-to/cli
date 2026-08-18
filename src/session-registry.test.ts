/**
 * The registry is the whitelist behind remote resume: a resume request names a
 * session, and everything else — which directory, which binary — is read back
 * from what this machine observed itself. So what it stores, and what it
 * refuses to store, is a security property, not bookkeeping.
 */

import { mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';

let TMP: string;
const originalState = process.env.XDG_STATE_HOME;

beforeEach(() => {
    TMP = mkdtempSync(join(tmpdir(), 'zeph-registry-'));
    process.env.XDG_STATE_HOME = TMP;
});
afterEach(() => {
    rmSync(TMP, { recursive: true, force: true });
    if (originalState === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = originalState;
});

const {
    rememberSessions,
    recallSession,
    knownSessions,
    isKnownSession,
    knownSessionsPath,
    forgetSession,
    MAX_KNOWN_SESSIONS,
    KNOWN_SESSION_TTL_MS,
} = await import('./session-registry.js');

const T0 = Date.parse('2026-08-01T00:00:00.000Z');

const live = (over: Record<string, unknown> = {}) => ({
    name: 'zeph-api',
    cwd: '/Users/tak/work/api',
    agentKind: 'claude',
    project: 'api',
    ...over,
});

describe('session registry', () => {
    it('remembers where a session ran and what ran there', () => {
        rememberSessions([live()], T0);

        expect(recallSession('zeph-api', T0)).toEqual({
            name: 'zeph-api',
            cwd: '/Users/tak/work/api',
            agentKind: 'claude',
            project: 'api',
            lastSeenAt: '2026-08-01T00:00:00.000Z',
        });
    });

    it('knows nothing about a name it never saw', () => {
        rememberSessions([live()], T0);

        expect(recallSession('zeph-somewhere-else', T0)).toBeNull();
        expect(isKnownSession('zeph-somewhere-else', T0)).toBe(false);
    });

    // An entry with no directory cannot say where to start the agent, so it is
    // not a resume target — remembering it would only produce a row that fails
    // when tapped.
    it('skips a session whose directory could not be read', () => {
        rememberSessions([live({ cwd: null })], T0);

        expect(knownSessions(T0)).toEqual([]);
    });

    it('follows a session that moved directory rather than pinning the first sighting', () => {
        rememberSessions([live()], T0);
        rememberSessions([live({ cwd: '/Users/tak/work/api-v2' })], T0 + 1000);

        expect(recallSession('zeph-api', T0 + 1000)?.cwd).toBe('/Users/tak/work/api-v2');
        expect(knownSessions(T0 + 1000)).toHaveLength(1);
    });

    it('keeps sessions it saw in earlier sweeps', () => {
        rememberSessions([live({ name: 'zeph-api' })], T0);
        rememberSessions([live({ name: 'zeph-web' })], T0 + 1000);

        expect(knownSessions(T0 + 1000).map((e) => e.name)).toEqual(['zeph-web', 'zeph-api']);
    });

    it('forgets a session it has not seen for a month', () => {
        rememberSessions([live()], T0);

        const later = T0 + KNOWN_SESSION_TTL_MS + 1;
        expect(recallSession('zeph-api', later)).toBeNull();
        expect(knownSessions(later)).toEqual([]);
    });

    it('keeps the most recent names when the cap is reached', () => {
        for (let i = 0; i < MAX_KNOWN_SESSIONS + 5; i++) {
            rememberSessions([live({ name: `zeph-${i}` })], T0 + i * 1000);
        }

        const all = knownSessions(T0 + 1_000_000);
        expect(all).toHaveLength(MAX_KNOWN_SESSIONS);
        expect(all[0].name).toBe(`zeph-${MAX_KNOWN_SESSIONS + 4}`);
        // The oldest names are the ones dropped.
        expect(all.some((e) => e.name === 'zeph-0')).toBe(false);
    });

    it('survives a registry file that is not what it expects', () => {
        const path = knownSessionsPath();
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, '{ this is not json');

        expect(knownSessions(T0)).toEqual([]);
        // And a later sweep repairs it rather than failing forever.
        rememberSessions([live()], T0);
        expect(recallSession('zeph-api', T0)?.cwd).toBe('/Users/tak/work/api');
    });

    it('drops rows that are missing the fields a resume needs', () => {
        const path = knownSessionsPath();
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(
            path,
            JSON.stringify([
                { name: 'zeph-good', cwd: '/w/good', agentKind: 'claude', lastSeenAt: '2026-08-01T00:00:00.000Z' },
                { name: 'zeph-nocwd', agentKind: 'claude', lastSeenAt: '2026-08-01T00:00:00.000Z' },
                { cwd: '/w/noname', agentKind: 'claude', lastSeenAt: '2026-08-01T00:00:00.000Z' },
                'not even an object',
            ]),
        );

        expect(knownSessions(T0).map((e) => e.name)).toEqual(['zeph-good']);
    });

    it('writes a file only this account can read', () => {
        rememberSessions([live()], T0);

        // The registry names the user's project directories; other accounts on
        // the machine have no business reading them.
        expect(statSync(knownSessionsPath()).mode & 0o077).toBe(0);
    });
});

/**
 * Forgetting is what "delete" means on this side: the entry leaves the file,
 * so the session stops being offered and — because this file is the resume
 * whitelist — stops being startable. `rememberSessions` only writes down
 * sessions that are running, so a session that has ended stays forgotten.
 */
describe('forgetSession', () => {
    it('drops the named session and keeps the rest', () => {
        rememberSessions([live(), live({ name: 'zeph-web', cwd: '/Users/tak/work/web' })], T0);

        expect(forgetSession('zeph-api')).toBe(true);
        expect(knownSessions(T0).map((e) => e.name)).toEqual(['zeph-web']);
    });

    it('takes the session out of the resume whitelist', () => {
        rememberSessions([live()], T0);

        forgetSession('zeph-api');

        expect(isKnownSession('zeph-api', T0)).toBe(false);
        expect(recallSession('zeph-api', T0)).toBeNull();
    });

    it('says so when it never knew the name, and writes nothing', () => {
        rememberSessions([live()], T0);

        expect(forgetSession('zeph-never')).toBe(false);
        expect(knownSessions(T0).map((e) => e.name)).toEqual(['zeph-api']);
    });

    it('is safe on a machine with no registry at all', () => {
        expect(forgetSession('zeph-api')).toBe(false);
    });
});
