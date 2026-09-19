/**
 * What the daemon concludes from a quiet socket.
 *
 * Measured failure (2026-09-18): the pong deadline was a `setTimeout` armed by
 * each ping and judged on the same thread that reads inbound frames. A blocking
 * inventory sweep held that thread for tens of seconds — a `setInterval(5_000)`
 * fired at a median of 28.5 s — so the deadline fired while nobody was reading,
 * and the daemon tore down a working connection every 1-3 minutes
 * (`.claude/20260918/DEBUG-09-55-00.md`).
 *
 * The verdict therefore takes two measurements: how long the server has been
 * quiet, and how much of that quiet was this thread's own absence. Neither
 * alone can separate a dead socket from a deaf client.
 */
import { describe, expect, it } from 'vitest';

const { heartbeatVerdict } = await import('./listener.js');

// Named locally rather than imported: a spec that reads the implementation's
// own constants stays green when the implementation changes them.
const PONG = 30_000;
const STALL = 90_000;
const GRACE = 10_000;
const verdict = (silentMs: number, blockedMs: number) =>
    heartbeatVerdict(silentMs, blockedMs, PONG, STALL, GRACE);

describe('heartbeatVerdict', () => {
    it('leaves a socket alone while the server is still talking', () => {
        expect(verdict(0, 0)).toBe('alive');
        expect(verdict(PONG - 1, 0)).toBe('alive');
        expect(verdict(PONG, 0)).toBe('alive');
    });

    it('kills a socket that goes quiet while the thread was free to listen', () => {
        // The case the watchdog exists for: nothing came back, and we were
        // there to notice. Under the old per-ping timer this never fired --
        // the next ping cancelled the deadline before it could.
        expect(verdict(PONG + 1, 0)).toBe('dead');
        expect(verdict(PONG + 1, GRACE - 1)).toBe('dead');
    });

    it('spares a socket whose silence is mostly our own blindness', () => {
        expect(verdict(PONG + 1, GRACE)).toBe('blocked');
        expect(verdict(STALL, GRACE * 2)).toBe('blocked');
    });

    it('stops forgiving at the wall-clock ceiling', () => {
        // Past here a blocked thread is no longer an excuse: we cannot tell the
        // two apart any more and a reconnect is cheap.
        expect(verdict(STALL + 1, STALL)).toBe('dead');
    });

    it('does not let a long block hide a socket that is answering', () => {
        // Blocked for a minute, but the server was heard from 1 s ago -- the
        // reading that matters is silence, and there is none.
        expect(verdict(1_000, 60_000)).toBe('alive');
    });
});
