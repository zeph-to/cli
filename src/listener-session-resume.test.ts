/**
 * Starting a finished session again, from the phone.
 *
 * This is the one remote path that creates a process rather than typing into
 * one, so the shape of the request matters more than usual: it carries a
 * session NAME and nothing else. Where to start, and what to start, come from
 * the registry this machine wrote while the session was alive. A phone — or a
 * relay posing as one — cannot name a directory, a command, or an argument.
 */

import { mkdirSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

const FIELD_SEP = '␟';
/** tmux sessions that exist right now. */
let liveSessions: string[] = [];
let tmuxCalls: string[][] = [];
let newSessionFails = false;

const fakeTmux = (args: readonly string[]) => {
    const a = args[0] === '-S' ? args.slice(2) : args;
    tmuxCalls.push([...a]);
    if (a[0] === 'list-sessions') {
        const stdout = liveSessions
            .map((n) => [n, '0', '1700000000', '1700000000'].join(FIELD_SEP))
            .join('\n');
        return { status: 0, stdout, stderr: '' };
    }
    if (a[0] === 'has-session') {
        return { status: liveSessions.includes(a[2]) ? 0 : 1, stdout: '', stderr: '' };
    }
    if (a[0] === 'new-session') {
        if (newSessionFails) return { status: 1, stdout: '', stderr: 'no server' };
        return { status: 0, stdout: '', stderr: '' };
    }
    if (a[0] === 'display-message') {
        if (a[4] === '#{pane_current_command}') return { status: 0, stdout: 'node', stderr: '' };
        return { status: 0, stdout: ['node', 'claude', '/tmp/proj', '1234'].join(FIELD_SEP), stderr: '' };
    }
    if (a[0] === 'capture-pane') return { status: 0, stdout: 'idle pane\n', stderr: '' };
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

const TMP = mkdtempSync(join(tmpdir(), 'zeph-resume-'));
process.env.HOME = TMP;
process.env.XDG_STATE_HOME = join(TMP, 'state');
/** A directory that really exists — the recorded cwd has to still be there. */
const PROJECT_DIR = join(TMP, 'work', 'api');
mkdirSync(PROJECT_DIR, { recursive: true });

const { handleSessionResumeRequest, computeListenerDeviceId } = await import('./listener.js');
const { rememberSessions } = await import('./session-registry.js');

describe('agent.session.resume.request — starting a session that ended', () => {
    const device = computeListenerDeviceId();
    let sent: Array<Record<string, unknown>>;
    const send = (data: Record<string, unknown>) => { sent.push(data); };

    const request = (over: Record<string, unknown> = {}) => ({
        subtype: 'agent.session.resume.request',
        targetDeviceId: device,
        sessionName: 'zeph-api',
        requestId: 'r1',
        ...over,
    });

    const ask = (over: Record<string, unknown> = {}) => {
        const claimed = handleSessionResumeRequest(request(over), send);
        return { claimed, reply: sent.at(-1) };
    };

    /** What the daemon remembered while the session was running. */
    const remember = (over: Record<string, unknown> = {}) =>
        rememberSessions([
            { name: 'zeph-api', cwd: PROJECT_DIR, agentKind: 'claude', project: 'api', ...over },
        ]);

    const newSessions = () => tmuxCalls.filter((c) => c[0] === 'new-session');

    beforeEach(() => {
        vi.spyOn(console, 'log').mockImplementation(() => {});
        tmuxCalls = [];
        sent = [];
        liveSessions = [];
        newSessionFails = false;
        rmSync(join(TMP, 'state'), { recursive: true, force: true });
    });
    afterEach(() => vi.restoreAllMocks());

    describe('routing', () => {
        it('does not claim other ephemeral traffic', () => {
            expect(handleSessionResumeRequest({ subtype: 'clipboard' }, send)).toBe(false);
            expect(handleSessionResumeRequest({}, send)).toBe(false);
            expect(sent).toEqual([]);
        });

        it('ignores a request addressed to another machine', () => {
            remember();
            expect(ask({ targetDeviceId: 'dev_someone_else' }).claimed).toBe(false);
            expect(newSessions()).toEqual([]);
        });

        it('ignores a request with no requestId or no session', () => {
            expect(ask({ requestId: undefined }).claimed).toBe(false);
            expect(ask({ sessionName: undefined }).claimed).toBe(false);
        });
    });

    describe('what it will start', () => {
        it('starts the recorded agent in the recorded directory, detached', () => {
            remember();

            const { reply } = ask();

            expect(newSessions()).toEqual([
                ['new-session', '-d', '-s', 'zeph-api', '-c', PROJECT_DIR, 'claude'],
            ]);
            expect(reply).toMatchObject({
                subtype: 'agent.session.resume.result',
                requestId: 'r1',
                sessionName: 'zeph-api',
                resumed: true,
            });
        });

        // The registry IS the whitelist. A name this machine never wrote down
        // has no directory and no binary attached to it, and the daemon has
        // nothing else to fall back on — which is the point.
        it('refuses a session it never saw run', () => {
            remember();

            const { reply } = ask({ sessionName: 'zeph-not-mine' });

            expect(reply?.error).toBe('unknown_session');
            expect(newSessions()).toEqual([]);
        });

        it('refuses when the recorded directory is gone', () => {
            rememberSessions([
                { name: 'zeph-api', cwd: join(TMP, 'work', 'deleted'), agentKind: 'claude' },
            ]);

            const { reply } = ask();

            expect(reply?.error).toBe('missing_directory');
            expect(newSessions()).toEqual([]);
        });

        // agentKind is a wire enum that outlives installs: a record written by
        // a newer build, or for an agent since removed from the table, must not
        // become a command guess.
        it('refuses an agent kind it cannot resolve to a known binary', () => {
            remember({ agentKind: 'some-future-agent' });

            const { reply } = ask();

            expect(reply?.error).toBe('unknown_agent');
            expect(newSessions()).toEqual([]);
        });

        it('refuses a session that is already running', () => {
            remember();
            liveSessions = ['zeph-api'];

            const { reply } = ask();

            expect(reply?.error).toBe('already_running');
            expect(newSessions()).toEqual([]);
        });

        it('reports a tmux that refused to start it', () => {
            remember();
            newSessionFails = true;

            const { reply } = ask();

            expect(reply?.error).toBe('start_failed');
            expect(reply?.resumed).toBeUndefined();
        });
    });

    // Starting a process is the most expensive thing the phone can ask for, so
    // it is charged against the same per-session budget as an injected command
    // — a flood cannot be laundered through the cheaper path either way.
    it('refuses once the session budget is spent', async () => {
        const { checkRateLimit } = await import('./listener.js');
        remember();
        for (let i = 0; i < 40; i++) checkRateLimit('zeph-api', undefined, 4);

        const { reply } = ask();

        expect(reply?.error).toBe('rate_limited');
        expect(newSessions()).toEqual([]);
    });
});
