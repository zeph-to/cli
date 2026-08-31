/**
 * Judging a worker's exit.
 *
 * `terminate()` makes a worker exit with code 1, exactly like a crash, so the
 * offload cannot read the code — it has to ask whether that worker still owed
 * an answer. The bug this pins: the question used to be asked of a map shared
 * by every worker, so a worker killed on timeout was judged against the NEXT
 * worker's pending sweep and its ordinary, deliberate death was read as
 * "the worker died before ever answering" — which disables the offload for the
 * daemon's whole lifetime (`everReplied` is false, so the failure is not
 * treated as transient).
 *
 * The window is about a second wide (terminate to exit) against a five second
 * poll, which is why this showed up as an intermittent line in the log rather
 * than a dead feature.
 */
import { join } from 'path';
import { describe, expect, it, vi } from 'vitest';
import { startInventoryOffload } from './inventory-offload.js';

const FIXTURES = join(__dirname, 'fixtures', 'inventory-worker');
const IN_THREAD = { sessions: [{ name: 'zeph-in-thread' }], rejected: [] };
const inThread = () => IN_THREAD as never;
/** Long enough for a worker to boot, short enough to not stall the suite. */
const TIMEOUT = 300;

const degraded = (log: ReturnType<typeof vi.fn>): boolean =>
    log.mock.calls.some((c) => /in-thread from now on/.test(String(c[0])));

describe('inventory offload — a timed-out worker is not a failed worker', () => {
    it('keeps using workers after a sweep times out and the next one starts', async () => {
        const log = vi.fn();
        // Hangs first, so sweep 1 times out and the worker is terminated.
        const offload = startInventoryOffload(inThread, log, join(FIXTURES, 'hangs.cjs'), TIMEOUT);
        try {
            await expect(offload.collect()).rejects.toThrow(/exceeded/);
            // The daemon's next poll lands here, while worker 1 is still dying.
            // Its id goes in the pending map before worker 1's exit arrives.
            const second = offload.collect();
            // Rejecting means it reached a worker and timed out there. Resolving
            // would mean the offload had given up and served the in-thread result.
            await expect(second).rejects.toThrow(/exceeded/);
            // Give worker 1's exit event every chance to land and be misjudged.
            await new Promise((r) => setTimeout(r, 200));
            expect(degraded(log)).toBe(false);
        } finally {
            offload.close();
        }
    });

    // The behaviour that must NOT regress: a worker that dies on its own while
    // owing an answer is still a real failure, and still degrades for good.
    it('still degrades when a worker dies owing an answer', async () => {
        const log = vi.fn();
        const offload = startInventoryOffload(inThread, log, join(FIXTURES, 'dies.cjs'), TIMEOUT);
        try {
            expect(await offload.collect()).toBe(IN_THREAD);
            expect(degraded(log)).toBe(true);
        } finally {
            offload.close();
        }
    });

    // close() terminates too, and must not be read as a failure either.
    it('does not log a failure when close terminates a working worker', async () => {
        const log = vi.fn();
        const offload = startInventoryOffload(inThread, log, join(FIXTURES, 'echo.cjs'), TIMEOUT);
        await offload.collect();
        offload.close();
        await new Promise((r) => setTimeout(r, 200));
        expect(log).not.toHaveBeenCalled();
    });
});
