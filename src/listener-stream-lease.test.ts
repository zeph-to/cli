import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

// tmux is faked wholesale: the lease contract is about subscriber liveness,
// not about tmux, and the inventory guard in handleStreamControl needs
// `list-sessions` + a pane running an agent before it will start anything.
const FIELD_SEP = '␟';
const SESSIONS = ['zeph-a', 'zeph-b', 'zeph-c', 'zeph-d'];

const fakeTmux = (args: readonly string[]) => {
    // Drop the optional `-S <socket>` prefix tmuxArgs() prepends.
    const a = args[0] === '-S' ? args.slice(2) : args;
    if (a[0] === 'list-sessions') {
        const stdout = SESSIONS.map((n) => [n, '0', '1700000000', '1700000000'].join(FIELD_SEP)).join('\n');
        return { status: 0, stdout, stderr: '' };
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

const { handleStreamControl, stopAllStreams, computeListenerDeviceId, MAX_CONCURRENT_STREAMS, STREAM_LEASE_MS, STREAM_RENEW_FRESH_MS } =
    await import('./listener.js');

/**
 * Contract: a subscriber that vanishes WITHOUT sending agent.stream.stop must
 * not hold a concurrency slot for more than this. The native terminal lives in
 * its own WebView (AgentStreamScreen); a swipe-back destroys that WebView
 * outright, so no unmount cleanup and no stop ever reaches the daemon. With
 * only the 5-minute orphan guard as a backstop, three such opens wedge the
 * per-listener cap and every retry answers `stream_limit`.
 */
const MAX_ZOMBIE_HOLD_MS = 20_000;

describe('stream lease — a vanished subscriber must free its slot', () => {
    const device = computeListenerDeviceId();

    beforeEach(() => {
        vi.useFakeTimers();
        vi.spyOn(console, 'log').mockImplementation(() => {});
    });
    afterEach(() => {
        stopAllStreams();
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    /** Subscribe (renewal-capable by default); returns the frames sent back. */
    const start = (sessionName: string, renewing = true) => {
        const sent: Array<Record<string, unknown>> = [];
        handleStreamControl(
            { subtype: 'agent.stream.start', targetDeviceId: device, sessionName, renew: renewing },
            (d) => sent.push(d as Record<string, unknown>),
        );
        return sent;
    };

    const renew = (sessionName: string) => {
        const sent: Array<Record<string, unknown>> = [];
        const claimed = handleStreamControl(
            { subtype: 'agent.stream.renew', targetDeviceId: device, sessionName },
            (d) => sent.push(d as Record<string, unknown>),
        );
        return { claimed, sent };
    };

    it('reclaims the slots of subscribers that stopped renewing', () => {
        expect(MAX_CONCURRENT_STREAMS).toBe(3);
        // Three sessions opened and swiped away on the phone — each WebView
        // died mid-stream, so no stop was ever sent.
        expect(start('zeph-a')).toEqual([]);
        expect(start('zeph-b')).toEqual([]);
        expect(start('zeph-c')).toEqual([]);
        // The 4th open is refused while the three leases are still fresh.
        expect(start('zeph-d')[0]).toMatchObject({ subtype: 'agent.stream.frame', error: 'stream_limit' });

        // Nobody renews — the three are zombies. A zombie is indistinguishable
        // from a live viewer until its lease lapses, so the refusal stands for
        // that long: bounded by STREAM_LEASE_MS, not by the 5-minute guard.
        vi.advanceTimersByTime(STREAM_LEASE_MS / 2);
        expect(start('zeph-d')[0]).toMatchObject({ error: 'stream_limit' });

        vi.advanceTimersByTime(MAX_ZOMBIE_HOLD_MS);
        expect(STREAM_LEASE_MS).toBeLessThanOrEqual(MAX_ZOMBIE_HOLD_MS);
        // Retry must now succeed instead of answering stream_limit forever.
        expect(start('zeph-d')).toEqual([]);
    });

    /**
     * The signal a quiet stream has no other way to send. The capture loop
     * drops unchanged frames, so an agent that stopped to think produces the
     * same silence as a daemon that stopped existing — and the viewer paints a
     * frozen pane through both. The renew already runs on a timer; answering it
     * is what separates the two.
     */
    it('answers a healthy renew so the viewer knows the daemon is still there', () => {
        start('zeph-a');

        const { claimed, sent } = renew('zeph-a');

        expect(claimed).toBe(true);
        expect(sent).toEqual([{ subtype: 'agent.stream.renew.ok', sessionName: 'zeph-a' }]);
    });

    // The ack reports on the lease, not on the pane, so it carries nothing a
    // relay could read — and must not start carrying it.
    it('puts no pane content in the acknowledgement', () => {
        start('zeph-a');

        const [ack] = renew('zeph-a').sent;

        expect(Object.keys(ack).sort()).toEqual(['sessionName', 'subtype']);
    });

    it('answers only the session that was renewed', () => {
        start('zeph-a');
        start('zeph-b');

        expect(renew('zeph-b').sent).toEqual([
            { subtype: 'agent.stream.renew.ok', sessionName: 'zeph-b' },
        ]);
    });

    it('tells a renewing viewer its stream is gone so it can re-subscribe', () => {
        start('zeph-a');
        // Stream dropped daemon-side (socket reconnect → stopAllStreams, or a
        // lease lost to dropped renews). The viewer is still painting frames
        // under a LIVE badge and has no other way to find out.
        stopAllStreams();
        expect(renew('zeph-a').sent[0]).toMatchObject({
            subtype: 'agent.stream.frame',
            sessionName: 'zeph-a',
            error: 'stream_gone',
        });
    });

    it('leaves another machine\'s stream-control alone', () => {
        // Two machines can run the same tmux session name and the relay fans
        // these out to every connection, so an unaddressed stop/renew must not
        // touch our stream of that name.
        start('zeph-a');
        const sent: Array<Record<string, unknown>> = [];
        for (const subtype of ['agent.stream.renew', 'agent.stream.stop']) {
            expect(
                handleStreamControl(
                    { subtype, targetDeviceId: 'dev_someone_else', sessionName: 'zeph-a' },
                    (d) => sent.push(d as Record<string, unknown>),
                ),
            ).toBe(false);
        }
        expect(sent).toEqual([]);
        // Our stream survived the foreign stop — still holding its slot.
        start('zeph-b');
        start('zeph-c');
        expect(start('zeph-d')[0]).toMatchObject({ error: 'stream_limit' });
    });

    it('keeps a stream alive as long as its subscriber renews', () => {
        expect(start('zeph-a')).toEqual([]);
        // A viewer that is actually watching keeps renewing well past the TTL.
        for (let i = 0; i < 12; i++) {
            vi.advanceTimersByTime(MAX_ZOMBIE_HOLD_MS / 4);
            expect(renew('zeph-a').claimed).toBe(true);
        }
        // zeph-a still owns a slot, so filling the other two wedges the cap.
        expect(start('zeph-b')).toEqual([]);
        expect(start('zeph-c')).toEqual([]);
        expect(start('zeph-d')[0]).toMatchObject({ error: 'stream_limit' });
    });

    it('takes the slot from a legacy holder that cannot prove it is watching', () => {
        // Clients older than the renew protocol (a cached web build, an
        // un-updated app) hold a slot for the full 5-minute orphan guard on
        // nothing but hope — a new subscriber outranks that.
        start('zeph-a', false);
        start('zeph-b', false);
        start('zeph-c', false);
        expect(start('zeph-d')).toEqual([]);
    });

    it('hands a ghost slot over after one missed renew beat, before the lease lapses', () => {
        // Three terminals open; the user swipes zeph-c away — its WebView dies
        // without a stop, but its lease is still live for STREAM_LEASE_MS.
        start('zeph-a');
        start('zeph-b');
        start('zeph-c');
        // One renew beat passes. The live viewers renew; the ghost cannot.
        vi.advanceTimersByTime(STREAM_RENEW_FRESH_MS + 500);
        renew('zeph-a');
        renew('zeph-b');
        expect(STREAM_RENEW_FRESH_MS).toBeLessThan(STREAM_LEASE_MS);
        // The next open takes the ghost's slot NOW — not after the full lease.
        expect(start('zeph-d')).toEqual([]);
        // If zeph-c's viewer were actually alive, its next renew tells it to
        // re-subscribe instead of leaving it painting under a LIVE badge.
        expect(renew('zeph-c').sent[0]).toMatchObject({ error: 'stream_gone' });
    });

    it('still refuses when every holder is actively renewing', () => {
        start('zeph-a');
        start('zeph-b');
        start('zeph-c');
        vi.advanceTimersByTime(MAX_ZOMBIE_HOLD_MS / 4);
        for (const s of ['zeph-a', 'zeph-b', 'zeph-c']) renew(s);
        // Three live viewers is a real cap, not a leak — eviction must not
        // steal a slot someone is watching.
        expect(start('zeph-d')[0]).toMatchObject({ error: 'stream_limit' });
    });
});
