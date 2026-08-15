/**
 * Deleting a past session, from the phone.
 *
 * The request carries a session NAME and nothing else, exactly like resume —
 * and for the same reason: everything this daemon acts on comes from what it
 * wrote down itself. What separates this one is that it is destructive and has
 * no undo. The entry leaves the registry, which is also the resume whitelist,
 * so the session cannot be started again afterwards.
 */

import { mkdirSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

const FIELD_SEP = '␟';
/** tmux sessions that exist right now. */
let liveSessions: string[] = [];

const fakeTmux = (args: readonly string[]) => {
    const a = args[0] === '-S' ? args.slice(2) : args;
    if (a[0] === 'list-sessions') {
        const stdout = liveSessions
            .map((n) => [n, '0', '1700000000', '1700000000'].join(FIELD_SEP))
            .join('\n');
        return { status: 0, stdout, stderr: '' };
    }
    if (a[0] === 'has-session') {
        return { status: liveSessions.includes(a[2]) ? 0 : 1, stdout: '', stderr: '' };
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

const TMP = mkdtempSync(join(tmpdir(), 'zeph-forget-'));
process.env.HOME = TMP;
process.env.XDG_STATE_HOME = join(TMP, 'state');
const PROJECT_DIR = join(TMP, 'work', 'api');
mkdirSync(PROJECT_DIR, { recursive: true });

const { handleSessionForgetRequest, computeListenerDeviceId } = await import('./listener.js');
const { rememberSessions, knownSessions, isKnownSession } = await import('./session-registry.js');

describe('agent.session.forget.request — deleting a session this machine ran', () => {
    const device = computeListenerDeviceId();
    let sent: Array<Record<string, unknown>>;
    const send = (data: Record<string, unknown>) => { sent.push(data); };

    const request = (over: Record<string, unknown> = {}) => ({
        subtype: 'agent.session.forget.request',
        targetDeviceId: device,
        sessionName: 'zeph-api',
        requestId: 'f1',
        ...over,
    });

    const ask = (over: Record<string, unknown> = {}) => {
        const claimed = handleSessionForgetRequest(request(over), send);
        return { claimed, reply: sent.at(-1) };
    };

    /** What the daemon remembered while the session was running. */
    const remember = (over: Record<string, unknown> = {}) =>
        rememberSessions([
            { name: 'zeph-api', cwd: PROJECT_DIR, agentKind: 'claude', project: 'api', ...over },
        ]);

    beforeEach(() => {
        vi.spyOn(console, 'log').mockImplementation(() => {});
        sent = [];
        liveSessions = [];
        rmSync(join(TMP, 'state'), { recursive: true, force: true });
    });
    afterEach(() => vi.restoreAllMocks());

    describe('routing', () => {
        it('does not claim other ephemeral traffic', () => {
            expect(handleSessionForgetRequest({ subtype: 'clipboard' }, send)).toBe(false);
            expect(handleSessionForgetRequest({}, send)).toBe(false);
            expect(sent).toEqual([]);
        });

        it('ignores a request addressed to another machine', () => {
            remember();

            expect(ask({ targetDeviceId: 'dev_someone_else' }).claimed).toBe(false);

            expect(isKnownSession('zeph-api')).toBe(true);
        });

        it('ignores a request with no requestId or no session', () => {
            expect(ask({ requestId: undefined }).claimed).toBe(false);
            expect(ask({ sessionName: undefined }).claimed).toBe(false);
        });
    });

    describe('what it will forget', () => {
        it('drops the session from its own record and says so', () => {
            remember();

            const { claimed, reply } = ask();

            expect(claimed).toBe(true);
            expect(reply).toMatchObject({
                subtype: 'agent.session.forget.result',
                requestId: 'f1',
                sessionName: 'zeph-api',
                forgotten: true,
            });
            expect(knownSessions().map((e) => e.name)).toEqual([]);
        });

        it('leaves the machine unable to start it again', () => {
            remember();

            ask();

            // The registry IS the resume whitelist — this is the deletion, not
            // a consequence of it.
            expect(isKnownSession('zeph-api')).toBe(false);
        });

        it('keeps the other sessions it remembers', () => {
            remember();
            rememberSessions([{ name: 'zeph-web', cwd: PROJECT_DIR, agentKind: 'claude' }]);

            ask();

            expect(knownSessions().map((e) => e.name)).toEqual(['zeph-web']);
        });
    });

    describe('what it refuses', () => {
        it('refuses a name it never saw', () => {
            expect(ask().reply).toMatchObject({ error: 'unknown_session' });
        });

        // A running session is not a past one. Deleting the record under a live
        // session would leave the phone watching something it can no longer
        // name — ending it is a different request.
        it('refuses while the session is still running', () => {
            remember();
            liveSessions = ['zeph-api'];

            expect(ask().reply).toMatchObject({ error: 'still_running' });
            expect(isKnownSession('zeph-api')).toBe(true);
        });
    });
});
