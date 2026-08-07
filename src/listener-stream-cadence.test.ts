import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

// tmux is faked wholesale (as in listener-stream-lease.test.ts): what is under
// test is the capture cadence, not tmux. capture-pane hands back a fresh line
// every call so the diff-gate never suppresses a tick — every tick that is
// allowed to send becomes an observable frame.
const FIELD_SEP = '␟';
const SESSIONS = ['zeph-a', 'zeph-b'];

let captureCount = 0;
// Pinning these makes a pane that holds still — which is the only way to see
// the cursor half of the diff-gate, since a changing capture would send frames
// no matter what the cursor did.
let paneText: string | null = null;
let cursorProbe = '';

const fakeTmux = (args: readonly string[]) => {
    // Drop the optional `-S <socket>` prefix tmuxArgs() prepends.
    const a = args[0] === '-S' ? args.slice(2) : args;
    if (a[0] === 'list-sessions') {
        const stdout = SESSIONS.map((n) => [n, '0', '1700000000', '1700000000'].join(FIELD_SEP)).join('\n');
        return { status: 0, stdout, stderr: '' };
    }
    if (a[0] === 'display-message') {
        if (a[4] === '#{pane_current_command}') return { status: 0, stdout: 'node', stderr: '' };
        // Unset by default, which fails to parse — the same "pane reports no
        // cursor" path every other test in this file runs on.
        if (a[4] === '#{cursor_x},#{cursor_y},#{pane_height}') {
            return { status: 0, stdout: cursorProbe, stderr: '' };
        }
        return { status: 0, stdout: ['node', 'claude', '/tmp/proj', '1234'].join(FIELD_SEP), stderr: '' };
    }
    if (a[0] === 'capture-pane') {
        captureCount++;
        return { status: 0, stdout: paneText ?? `pane ${captureCount}\n`, stderr: '' };
    }
    if (a[0] === 'send-keys') return { status: 0, stdout: '', stderr: '' };
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

// Redirect the device-id file and the remote-origin marker into a temp dir
// before listener.ts resolves either at import time.
const TMP = mkdtempSync(join(tmpdir(), 'zeph-cadence-'));
process.env.HOME = TMP;
process.env.XDG_STATE_HOME = join(TMP, 'state');

const {
    streamCadence,
    claimFrameSend,
    handleStreamControl,
    handleCommandInput,
    handlePush,
    stopAllStreams,
    computeListenerDeviceId,
    STREAM_INTERVAL_MS,
    BURST_INTERVAL_MS,
    BURST_WINDOW_MS,
    MAX_FRAMES_PER_SEC,
    MAX_CONCURRENT_STREAMS,
} = await import('./listener.js');

describe('streamCadence — how fast the next capture comes', () => {
    it('runs at the idle cadence when no input has ever landed', () => {
        expect(streamCadence(null, 10_000)).toBe(STREAM_INTERVAL_MS);
    });

    it('bursts while the keystroke is still echoing', () => {
        expect(streamCadence(10_000, 10_000)).toBe(BURST_INTERVAL_MS);
        expect(streamCadence(10_000, 10_000 + BURST_WINDOW_MS - 1)).toBe(BURST_INTERVAL_MS);
    });

    it('decays to the idle cadence at the window boundary, not after it', () => {
        // Exactly BURST_WINDOW_MS is already idle: the window is what bounds
        // the extra frames one keypress can cost, so it must not stretch.
        expect(streamCadence(10_000, 10_000 + BURST_WINDOW_MS)).toBe(STREAM_INTERVAL_MS);
        expect(streamCadence(10_000, 10_000 + BURST_WINDOW_MS + 5_000)).toBe(STREAM_INTERVAL_MS);
    });

    it('treats a clock that ran backwards as fresh input, not as an expired window', () => {
        // Wall-clock jumps (NTP, laptop resume) must not park a stream at a
        // cadence it can never leave — bursting is the safe side of that.
        expect(streamCadence(10_000, 9_000)).toBe(BURST_INTERVAL_MS);
    });
});

describe('claimFrameSend — the per-stream one-second send budget', () => {
    it('lets a stream spend its whole budget, then refuses the rest of that second', () => {
        const budget = { windowStartedAt: 1_000, sent: 0 };
        const claims = Array.from({ length: MAX_FRAMES_PER_SEC + 1 }, (_, i) =>
            claimFrameSend(budget, 1_000 + i * 10),
        );
        expect(claims.filter(Boolean)).toHaveLength(MAX_FRAMES_PER_SEC);
        expect(claims.at(-1)).toBe(false);
    });

    it('refills when the second rolls over', () => {
        const budget = { windowStartedAt: 1_000, sent: MAX_FRAMES_PER_SEC };
        expect(claimFrameSend(budget, 1_999)).toBe(false);
        expect(claimFrameSend(budget, 2_000)).toBe(true);
    });

    it('recovers when the clock runs backwards instead of freezing the mirror', () => {
        // NTP step / suspend-resume: a spent budget whose window start is now
        // in the future must reset, or no window ever rolls again — the same
        // wall-clock defense streamCadence has.
        const budget = { windowStartedAt: 10_000, sent: MAX_FRAMES_PER_SEC };
        expect(claimFrameSend(budget, 9_000)).toBe(true);
        expect(budget.windowStartedAt).toBe(9_000);
    });

    it('keeps the worst case under half the shared API Gateway stage throttle', () => {
        // 50 rps is shared across every user, so one bursting host must not be
        // able to spend even half of it: 3 streams × 8 frames/s = 24 < 25.
        expect(MAX_CONCURRENT_STREAMS * MAX_FRAMES_PER_SEC).toBeLessThan(25);
    });
});

describe('capture chain — cadence around a keystroke', () => {
    const device = computeListenerDeviceId();
    let sent: Array<Record<string, unknown>>;

    const send = (data: Record<string, unknown>) => { sent.push(data); };

    beforeEach(() => {
        vi.useFakeTimers();
        vi.spyOn(console, 'log').mockImplementation(() => {});
        captureCount = 0;
        paneText = null;
        cursorProbe = '';
        sent = [];
    });
    afterEach(() => {
        stopAllStreams();
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    const openStream = (sessionName: string) => {
        handleStreamControl(
            { subtype: 'agent.stream.start', targetDeviceId: device, sessionName, renew: true },
            send,
        );
        sent = [];
    };

    /** Capture instants of the data frames, in order. `capturedAt` is stamped
     *  inside the tick, so the gaps between these ARE the realized cadence. */
    const tickTimes = (): number[] =>
        sent.filter((f) => typeof f.content === 'string').map((f) => Date.parse(f.capturedAt as string));

    const gaps = (): number[] => tickTimes().slice(1).map((t, i) => t - tickTimes()[i]);

    /** One arrow key over the ephemeral path — the same tryInjectKeys success
     *  the REST path reaches, so this covers both entry points' trigger. */
    const typeKey = (sessionName: string, seq: number) =>
        handleCommandInput(
            { subtype: 'agent.command.input', targetDeviceId: device, sessionName, keys: ['down'], seq, epoch: 1 },
            send,
        );

    it('sends a frame when only the cursor moved', async () => {
        // An arrow key inside a prompt moves the cursor and leaves every
        // character where it was, so a capture-only diff-gate suppresses the
        // tick — and the mirror's cursor sits still while the real one moves,
        // which is exactly the feedback it exists to give.
        paneText = 'a steady pane\n';
        cursorProbe = '0,0,1';
        openStream('zeph-a');
        await vi.advanceTimersByTimeAsync(STREAM_INTERVAL_MS);
        expect(tickTimes()).toHaveLength(1);
        expect(sent.at(-1)).toMatchObject({ cursorLine: 0, cursorCol: 0 });

        cursorProbe = '5,0,1';
        await vi.advanceTimersByTimeAsync(STREAM_INTERVAL_MS);
        expect(tickTimes()).toHaveLength(2);
        expect(sent.at(-1)).toMatchObject({ cursorLine: 0, cursorCol: 5 });
    });

    it('still says nothing when neither the pane nor the cursor moved', async () => {
        // The gate is what keeps an idle pane off the wire; widening it must
        // not turn every tick into a frame.
        paneText = 'a steady pane\n';
        cursorProbe = '2,0,1';
        openStream('zeph-a');
        await vi.advanceTimersByTimeAsync(STREAM_INTERVAL_MS * 4);
        expect(tickTimes()).toHaveLength(1);
    });

    it('captures at the idle cadence until something is typed', async () => {
        openStream('zeph-a');
        await vi.advanceTimersByTimeAsync(STREAM_INTERVAL_MS * 3);
        expect(tickTimes()).toHaveLength(3);
        expect(gaps()).toEqual([STREAM_INTERVAL_MS, STREAM_INTERVAL_MS]);
    });

    it('re-arms immediately on input instead of waiting out the idle gap', async () => {
        // A single keypress must echo at burst latency even when it lands just
        // after an idle tick — without the wake, the first fast capture waits
        // out the remaining ~390ms of the idle gap and the burst never helps a
        // lone arrow key.
        openStream('zeph-a');
        await vi.advanceTimersByTimeAsync(STREAM_INTERVAL_MS);
        await vi.advanceTimersByTimeAsync(10);
        typeKey('zeph-a', 1);
        const before = tickTimes().length;
        await vi.advanceTimersByTimeAsync(BURST_INTERVAL_MS);
        expect(tickTimes().length).toBe(before + 1);
    });

    it('does not let a keystroke flurry starve the tick chain', async () => {
        // The wake only replaces an IDLE-armed timer. If every keystroke reset
        // the pending burst timer, keys arriving faster than the burst cadence
        // would push the next capture away forever.
        openStream('zeph-a');
        await vi.advanceTimersByTimeAsync(STREAM_INTERVAL_MS);
        const before = tickTimes().length;
        for (let seq = 1; seq <= 20; seq++) {
            typeKey('zeph-a', seq);
            await vi.advanceTimersByTimeAsync(50);
        }
        // 1000ms of flurry at burst cadence ≈ 8 ticks; anything close means the
        // chain kept firing. Zero or one means it was being starved.
        expect(tickTimes().length - before).toBeGreaterThanOrEqual(6);
    });

    it('a wake cannot resurrect a stopped stream', async () => {
        openStream('zeph-a');
        await vi.advanceTimersByTimeAsync(STREAM_INTERVAL_MS + 10);
        stopAllStreams();
        const before = tickTimes().length;
        typeKey('zeph-a', 1); // refused (no lease) — and must not re-arm anything
        await vi.advanceTimersByTimeAsync(BURST_WINDOW_MS * 2);
        expect(tickTimes().length).toBe(before);
    });

    it('tightens to the burst cadence once a keystroke lands', async () => {
        openStream('zeph-a');
        await vi.advanceTimersByTimeAsync(STREAM_INTERVAL_MS);
        typeKey('zeph-a', 1);
        const before = tickTimes().length;
        await vi.advanceTimersByTimeAsync(BURST_WINDOW_MS - STREAM_INTERVAL_MS);
        // Idle would have managed 5 frames in that span; the burst cadence is
        // what makes the echo of the keypress visible instead.
        expect(tickTimes().length - before).toBeGreaterThan(10);
        expect(gaps()).toContain(BURST_INTERVAL_MS);
    });

    it('decays back to the idle cadence once the burst window passes', async () => {
        openStream('zeph-a');
        await vi.advanceTimersByTimeAsync(STREAM_INTERVAL_MS);
        typeKey('zeph-a', 1);
        await vi.advanceTimersByTimeAsync(BURST_WINDOW_MS + STREAM_INTERVAL_MS * 4);
        // It has to have bursted for the decay to mean anything.
        expect(gaps()).toContain(BURST_INTERVAL_MS);
        // The tail of the run is past the window, so the steady-state cost is
        // back where it was — a burst raises the peak, never the baseline.
        expect(gaps().slice(-3)).toEqual([STREAM_INTERVAL_MS, STREAM_INTERVAL_MS, STREAM_INTERVAL_MS]);
    });

    it('holds every send window to the budget (sliding windows may see one boundary frame)', async () => {
        // The budget is a fixed one-second window, which is what the stage
        // throttle's token bucket actually needs (it absorbs momentary spikes;
        // the sustained rate is what starves other users). A SLIDING window
        // straddling a refill boundary can therefore see budget+1 — assert
        // that exact bound rather than pretending the limiter is sliding.
        openStream('zeph-a');
        typeKey('zeph-a', 1);
        await vi.advanceTimersByTimeAsync(BURST_WINDOW_MS);
        for (const start of tickTimes()) {
            const inSecond = tickTimes().filter((t) => t >= start && t < start + 1_000);
            expect(inSecond.length).toBeLessThanOrEqual(MAX_FRAMES_PER_SEC + 1);
        }
    });

    it('leaves the burst cadence of one stream out of another stream', async () => {
        openStream('zeph-a');
        openStream('zeph-b');
        typeKey('zeph-a', 1);
        await vi.advanceTimersByTimeAsync(BURST_WINDOW_MS);
        const perSession = (name: string) =>
            sent.filter((f) => f.sessionName === name && typeof f.content === 'string').length;
        // zeph-b was not typed into, so it must still be paying idle rates.
        expect(perSession('zeph-b')).toBeLessThanOrEqual(Math.ceil(BURST_WINDOW_MS / STREAM_INTERVAL_MS));
        expect(perSession('zeph-a')).toBeGreaterThan(perSession('zeph-b'));
    });

    it('starts the fast captures one burst interval after the input, not at the end of the idle gap', async () => {
        openStream('zeph-a');
        const t0 = Date.now();
        // One idle tick lands, arming the next for a full idle gap out. The
        // keystroke arrives 10ms into that gap: waiting it out is what made a
        // single keypress echo up to STREAM_INTERVAL_MS late.
        await vi.advanceTimersByTimeAsync(STREAM_INTERVAL_MS + 10);
        const inputAt = Date.now();
        typeKey('zeph-a', 1);
        await vi.advanceTimersByTimeAsync(BURST_INTERVAL_MS * 4);
        expect(tickTimes().filter((t) => t > inputAt)).toEqual([
            inputAt + BURST_INTERVAL_MS,
            inputAt + BURST_INTERVAL_MS * 2,
            inputAt + BURST_INTERVAL_MS * 3,
            inputAt + BURST_INTERVAL_MS * 4,
        ]);
        expect(t0 + STREAM_INTERVAL_MS).toBeLessThan(inputAt);
    });

    it('cancels the tick the keystroke pre-empted instead of leaving both armed', async () => {
        openStream('zeph-a');
        const t0 = Date.now();
        await vi.advanceTimersByTimeAsync(STREAM_INTERVAL_MS + 10);
        const inputAt = Date.now();
        typeKey('zeph-a', 1);
        // Past where the pre-empted tick was due. A handle left armed there
        // forks the chain — two loops capturing one pane, and stopStream can
        // only ever hold one of them.
        await vi.advanceTimersByTimeAsync(STREAM_INTERVAL_MS * 2);
        expect(tickTimes()).not.toContain(t0 + STREAM_INTERVAL_MS * 2);
        expect(tickTimes().filter((t) => t > inputAt)).toEqual(
            tickTimes().filter((t) => t > inputAt).map((_, i) => inputAt + BURST_INTERVAL_MS * (i + 1)),
        );
    });

    it('does not resurrect a stopped stream when input still lands in the pane', async () => {
        openStream('zeph-a');
        await vi.advanceTimersByTimeAsync(STREAM_INTERVAL_MS);
        handleStreamControl({ subtype: 'agent.stream.stop', targetDeviceId: device, sessionName: 'zeph-a' }, send);
        const afterStop = tickTimes().length;
        // The REST path keeps injecting into panes nobody is streaming, and
        // it runs through the same inject helpers — it must not arm a capture
        // chain that no lease is behind.
        await handlePush(
            { pushId: '1', type: 'agent.command', agentSessionName: 'zeph-a', keys: ['down'] },
            { paneCommand: () => 'claude', sendKeys: () => true, rateLimit: () => true },
        );
        await vi.advanceTimersByTimeAsync(BURST_WINDOW_MS);
        expect(tickTimes()).toHaveLength(afterStop);
    });

    it('a REST agent.command into a LIVE stream fires the burst too', async () => {
        // Both entry points funnel through the same inject helpers, so a key
        // pushed over REST while someone is watching must tighten the cadence
        // exactly like the ephemeral path — asserted, not argued.
        openStream('zeph-b');
        await vi.advanceTimersByTimeAsync(STREAM_INTERVAL_MS);
        await vi.advanceTimersByTimeAsync(10);
        const before = tickTimes().length;
        await handlePush(
            { pushId: '2', type: 'agent.command', agentSessionName: 'zeph-b', keys: ['down'] },
            { paneCommand: () => 'claude', sendKeys: () => true, rateLimit: () => true },
        );
        await vi.advanceTimersByTimeAsync(BURST_INTERVAL_MS);
        expect(tickTimes().length).toBe(before + 1);
    });

    it('stops capturing when the stream stops', async () => {
        openStream('zeph-a');
        typeKey('zeph-a', 1);
        await vi.advanceTimersByTimeAsync(STREAM_INTERVAL_MS * 2);
        handleStreamControl({ subtype: 'agent.stream.stop', targetDeviceId: device, sessionName: 'zeph-a' }, send);
        const afterStop = tickTimes().length;
        await vi.advanceTimersByTimeAsync(BURST_WINDOW_MS * 2);
        // A self-rescheduling chain has a new handle every tick; a stop that
        // clears a stale one leaves the pane being captured forever.
        expect(tickTimes()).toHaveLength(afterStop);
    });
});

describe('cursorLineFor — placing the cursor in a captured frame', () => {
    // The capture reaches into scrollback, so the visible pane is its TAIL —
    // the cursor's row has to count back from the end, not forward from 0.
    const capture = (rows: number) => `${Array.from({ length: rows }, (_, i) => `row${i}`).join('\n')}\n`;

    it('counts the pane back from the end of the capture', async () => {
        const { cursorLineFor } = await import('./listener.js');
        // 10 captured rows, a 4-row pane: pane row 0 is captured row 6.
        expect(cursorLineFor(capture(10), { x: 3, y: 0, height: 4 })).toEqual({ line: 6, col: 3 });
        expect(cursorLineFor(capture(10), { x: 0, y: 3, height: 4 })).toEqual({ line: 9, col: 0 });
    });

    it('places the cursor correctly when the capture is only the visible pane', async () => {
        const { cursorLineFor } = await import('./listener.js');
        expect(cursorLineFor(capture(4), { x: 7, y: 2, height: 4 })).toEqual({ line: 2, col: 7 });
    });

    it('reports nothing when the byte cap cut the cursor off the top', async () => {
        const { cursorLineFor } = await import('./listener.js');
        // Two rows survived a 40-row pane — the cursor near its top is gone.
        expect(cursorLineFor(capture(2), { x: 0, y: 1, height: 40 })).toBeNull();
    });

    it('reports nothing for a row past the captured text', async () => {
        const { cursorLineFor } = await import('./listener.js');
        expect(cursorLineFor(capture(4), { x: 0, y: 9, height: 4 })).toBeNull();
    });

    it('does not count the trailing newline as a pane row', async () => {
        const { cursorLineFor } = await import('./listener.js');
        // Same rows, with and without the trailing newline capture-pane emits.
        expect(cursorLineFor('a\nb\nc\n', { x: 1, y: 2, height: 3 })).toEqual({ line: 2, col: 1 });
        expect(cursorLineFor('a\nb\nc', { x: 1, y: 2, height: 3 })).toEqual({ line: 2, col: 1 });
    });
});
