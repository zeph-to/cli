/**
 * Ending a session from the phone.
 *
 * The mirror image of resume, and the more dangerous half: resume creates a
 * process the user can watch, while this destroys one that may be mid-write.
 * So it asks rather than kills — `C-c`, then end-of-input, and the agent
 * decides what to do about it. If the session is still there when the signals
 * run out, that is the answer the phone gets. "I asked and it refused" beats a
 * button that can silently destroy a working agent.
 */

import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

const FIELD_SEP = '␟';
/** tmux sessions that exist right now. */
let liveSessions: string[] = [];
let tmuxCalls: string[][] = [];
/** Signals after which the fake session gives up, or null for one that never does. */
let diesAfterSignals: number | null = 1;
let signalsSeen = 0;

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
    if (a[0] === 'send-keys') {
        signalsSeen += 1;
        if (diesAfterSignals !== null && signalsSeen >= diesAfterSignals) {
            liveSessions = liveSessions.filter((n) => n !== a[2]);
        }
        return { status: 0, stdout: '', stderr: '' };
    }
    if (a[0] === 'display-message') {
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

const TMP = mkdtempSync(join(tmpdir(), 'zeph-exit-'));
process.env.HOME = TMP;
process.env.XDG_STATE_HOME = join(TMP, 'state');

const { handleSessionExitRequest, computeListenerDeviceId, SESSION_EXIT_STEP_MS } =
    await import('./listener.js');

describe('agent.session.exit.request — ending a running session', () => {
    const device = computeListenerDeviceId();
    let sent: Array<Record<string, unknown>>;
    const send = (data: Record<string, unknown>) => { sent.push(data); };

    const request = (over: Record<string, unknown> = {}) => ({
        subtype: 'agent.session.exit.request',
        targetDeviceId: device,
        sessionName: 'zeph-api',
        requestId: 'x1',
        ...over,
    });

    const ask = (over: Record<string, unknown> = {}) => handleSessionExitRequest(request(over), send);

    /** Run out the whole signal sequence, letting each awaited wait resolve. */
    const runOutTheSequence = async () => {
        for (let i = 0; i < 4; i += 1) {
            await vi.advanceTimersByTimeAsync(SESSION_EXIT_STEP_MS);
        }
    };

    const signals = () => tmuxCalls.filter((c) => c[0] === 'send-keys').map((c) => c.slice(3));

    beforeEach(() => {
        vi.useFakeTimers();
        vi.spyOn(console, 'log').mockImplementation(() => {});
        tmuxCalls = [];
        sent = [];
        liveSessions = ['zeph-api'];
        diesAfterSignals = 1;
        signalsSeen = 0;
    });
    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    describe('routing', () => {
        it('does not claim other ephemeral traffic', () => {
            expect(handleSessionExitRequest({ subtype: 'clipboard' }, send)).toBe(false);
            expect(handleSessionExitRequest({}, send)).toBe(false);
            expect(sent).toEqual([]);
        });

        it('ignores a request addressed to another machine', () => {
            // Two machines can run the same tmux session name; an unaddressed
            // exit must not end the other one's.
            expect(ask({ targetDeviceId: 'dev_someone_else' })).toBe(false);
            expect(signals()).toEqual([]);
        });

        it('ignores a request with no id to answer', () => {
            expect(ask({ requestId: undefined })).toBe(false);
        });
    });

    it('refuses a session that is not running', async () => {
        liveSessions = [];

        ask();

        expect(sent.at(-1)).toMatchObject({
            subtype: 'agent.session.exit.result',
            sessionName: 'zeph-api',
            error: 'unknown_session',
        });
        expect(signals()).toEqual([]);
    });

    it('asks before it insists — interrupt first, then end-of-input', async () => {
        diesAfterSignals = null; // a session that ignores everything

        ask();
        await runOutTheSequence();

        expect(signals()).toEqual([['C-c'], ['C-d'], ['C-d']]);
    });

    it('reports the session as ended once it is gone', async () => {
        ask();
        await runOutTheSequence();

        expect(sent.at(-1)).toMatchObject({
            subtype: 'agent.session.exit.result',
            sessionName: 'zeph-api',
            exited: true,
        });
    });

    // The signals after the session is gone would land in whatever tmux gives
    // that name next — a new session started in the same second, most plainly.
    it('stops signalling the moment the session is gone', async () => {
        ask();
        await runOutTheSequence();

        expect(signals()).toEqual([['C-c']]);
    });

    /**
     * The honest failure. Something in that pane refused end-of-input — a
     * confirmation modal, a TUI that swallows it, an agent mid-write — and the
     * daemon does not escalate to a kill. The phone is told the truth instead
     * of being shown a success it did not get.
     */
    it('says it is still running rather than forcing it', async () => {
        diesAfterSignals = null;

        ask();
        await runOutTheSequence();

        expect(sent.at(-1)).toMatchObject({ error: 'still_running' });
        expect(sent.at(-1)).not.toHaveProperty('exited');
        // Nothing here may reach for the one command that would always work.
        expect(tmuxCalls.some((c) => c[0] === 'kill-session')).toBe(false);
    });

    it('answers only after the session has had its chance', async () => {
        diesAfterSignals = 3;

        ask();
        // Mid-sequence: the first signals have gone out and nothing is decided.
        await vi.advanceTimersByTimeAsync(SESSION_EXIT_STEP_MS);
        expect(sent).toEqual([]);

        await runOutTheSequence();
        expect(sent.at(-1)).toMatchObject({ exited: true });
    });
});
