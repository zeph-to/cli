import { describe, expect, it } from 'vitest';

import { createInputSequencer, INPUT_HOLD_MS, MAX_PENDING_INPUTS } from './input-sequencer.js';

type Key = { seq: number; epoch: number; key: string };

/**
 * Deterministic stand-in for setTimeout: the hold deadline is the whole
 * contract here, so tests advance it explicitly rather than sleeping.
 */
const createFakeClock = () => {
    let now = 0;
    const tasks: Array<{ at: number; fn: () => void; done: boolean }> = [];
    return {
        schedule: (fn: () => void, ms: number) => {
            const task = { at: now + ms, fn, done: false };
            tasks.push(task);
            return () => { task.done = true; };
        },
        advance: (ms: number) => {
            now += ms;
            for (const task of tasks) {
                if (task.done || task.at > now) continue;
                task.done = true;
                task.fn();
            }
        },
    };
};

const setup = (holdMs = INPUT_HOLD_MS) => {
    const clock = createFakeClock();
    const delivered: string[] = [];
    const seq = createInputSequencer<Key>((msg) => delivered.push(msg.key), {
        holdMs,
        schedule: clock.schedule,
    });
    return { clock, delivered, seq };
};

describe('input sequencer — inbound key ordering', () => {
    it('delivers in-order messages immediately', () => {
        const { delivered, seq } = setup();
        seq.accept({ seq: 1, epoch: 7, key: 'a' });
        seq.accept({ seq: 2, epoch: 7, key: 'b' });
        seq.accept({ seq: 3, epoch: 7, key: 'c' });
        expect(delivered).toEqual(['a', 'b', 'c']);
    });

    it('starts an epoch at whatever seq arrives first', () => {
        // The daemon can join a stream mid-flight (reconnect, restart); making
        // it wait for seq 1 that will never come would stall every key.
        const { delivered, seq } = setup();
        seq.accept({ seq: 42, epoch: 7, key: 'a' });
        expect(delivered).toEqual(['a']);
    });

    it('holds a gap, then releases the run once it fills', () => {
        const { clock, delivered, seq } = setup();
        seq.accept({ seq: 1, epoch: 7, key: 'a' });
        seq.accept({ seq: 3, epoch: 7, key: 'c' });
        expect(delivered).toEqual(['a']); // 3 waits for 2
        seq.accept({ seq: 2, epoch: 7, key: 'b' });
        expect(delivered).toEqual(['a', 'b', 'c']);
        // The armed hold must not re-deliver what the fill already released.
        clock.advance(INPUT_HOLD_MS);
        expect(delivered).toEqual(['a', 'b', 'c']);
    });

    it('flushes in seq order when the gap never fills', () => {
        // A lost key is worse than a mis-ordered one: after the hold, type
        // what did arrive rather than sitting on it forever.
        const { clock, delivered, seq } = setup();
        seq.accept({ seq: 1, epoch: 7, key: 'a' });
        seq.accept({ seq: 4, epoch: 7, key: 'd' });
        seq.accept({ seq: 3, epoch: 7, key: 'c' });
        expect(delivered).toEqual(['a']);
        clock.advance(INPUT_HOLD_MS - 1);
        expect(delivered).toEqual(['a']);
        clock.advance(1);
        expect(delivered).toEqual(['a', 'c', 'd']);
    });

    it('keeps holding a later gap after an earlier one flushed', () => {
        const { clock, delivered, seq } = setup();
        seq.accept({ seq: 1, epoch: 7, key: 'a' });
        seq.accept({ seq: 3, epoch: 7, key: 'c' });
        clock.advance(INPUT_HOLD_MS);
        expect(delivered).toEqual(['a', 'c']);
        seq.accept({ seq: 5, epoch: 7, key: 'e' });
        expect(delivered).toEqual(['a', 'c']);
        clock.advance(INPUT_HOLD_MS);
        expect(delivered).toEqual(['a', 'c', 'e']);
    });

    it('drops duplicates and stale seqs', () => {
        const { clock, delivered, seq } = setup();
        seq.accept({ seq: 1, epoch: 7, key: 'a' });
        seq.accept({ seq: 2, epoch: 7, key: 'b' });
        seq.accept({ seq: 2, epoch: 7, key: 'b-dup' });
        seq.accept({ seq: 1, epoch: 7, key: 'a-dup' });
        expect(delivered).toEqual(['a', 'b']);
        // A retransmit of a still-pending seq is a duplicate too.
        seq.accept({ seq: 4, epoch: 7, key: 'd' });
        seq.accept({ seq: 4, epoch: 7, key: 'd-dup' });
        clock.advance(INPUT_HOLD_MS);
        expect(delivered).toEqual(['a', 'b', 'd']);
    });

    it('drops a key that arrives after its gap was flushed past', () => {
        const { clock, delivered, seq } = setup();
        seq.accept({ seq: 1, epoch: 7, key: 'a' });
        seq.accept({ seq: 3, epoch: 7, key: 'c' });
        clock.advance(INPUT_HOLD_MS);
        expect(delivered).toEqual(['a', 'c']);
        // Injecting 'b' now would type it AFTER 'c' — worse than losing it.
        seq.accept({ seq: 2, epoch: 7, key: 'b' });
        expect(delivered).toEqual(['a', 'c']);
    });

    it('resets the high-water mark and pending buffer on a new epoch', () => {
        const { clock, delivered, seq } = setup();
        seq.accept({ seq: 9, epoch: 7, key: 'a' });
        seq.accept({ seq: 11, epoch: 7, key: 'stranded' });
        // Sender restarted: seq counts from 1 again under a fresh epoch, and
        // the old epoch's held message must never be typed into the new one.
        seq.accept({ seq: 1, epoch: 8, key: 'b' });
        seq.accept({ seq: 2, epoch: 8, key: 'c' });
        clock.advance(INPUT_HOLD_MS);
        expect(delivered).toEqual(['a', 'b', 'c']);
    });

    it('ignores messages from a superseded epoch', () => {
        const { delivered, seq } = setup();
        seq.accept({ seq: 1, epoch: 8, key: 'a' });
        seq.accept({ seq: 2, epoch: 7, key: 'stale' });
        expect(delivered).toEqual(['a']);
    });

    it('drops the newest message once the pending buffer is full', () => {
        // A gap that never fills lets every later key accumulate for the whole
        // hold; without a ceiling one sender can queue an unbounded burst of
        // blocking tmux injections for the flush to run back to back.
        expect(MAX_PENDING_INPUTS).toBe(32);
        const { clock, delivered, seq } = setup();
        seq.accept({ seq: 1, epoch: 7, key: 'a' });
        // seq 2 never arrives, so everything from here on buffers.
        for (let i = 0; i < MAX_PENDING_INPUTS; i++) {
            expect(seq.accept({ seq: 3 + i, epoch: 7, key: `k${i}` })).toBe('ok');
        }
        expect(seq.accept({ seq: 3 + MAX_PENDING_INPUTS, epoch: 7, key: 'overflow' })).toBe('overflow');
        clock.advance(INPUT_HOLD_MS);
        expect(delivered).toHaveLength(1 + MAX_PENDING_INPUTS);
        expect(delivered).not.toContain('overflow');
    });

    it('accepts again once the flush drains the buffer', () => {
        // The cap is backpressure, not a permanent gag.
        const { clock, delivered, seq } = setup();
        seq.accept({ seq: 1, epoch: 7, key: 'a' });
        for (let i = 0; i < MAX_PENDING_INPUTS; i++) seq.accept({ seq: 3 + i, epoch: 7, key: `k${i}` });
        expect(seq.accept({ seq: 99, epoch: 7, key: 'rejected' })).toBe('overflow');
        clock.advance(INPUT_HOLD_MS);
        expect(seq.accept({ seq: 200, epoch: 7, key: 'later' })).toBe('ok');
        clock.advance(INPUT_HOLD_MS);
        expect(delivered).toContain('later');
    });

    it('forgets its epoch and pending buffer on reset', () => {
        const { clock, delivered, seq } = setup();
        seq.accept({ seq: 1, epoch: 7, key: 'a' });
        seq.accept({ seq: 3, epoch: 7, key: 'stranded' });
        seq.reset();
        clock.advance(INPUT_HOLD_MS);
        expect(delivered).toEqual(['a']);
        // Same epoch, and a seq the pre-reset high-water mark would have
        // swallowed — after a reset it is the start of a fresh run.
        seq.accept({ seq: 2, epoch: 7, key: 'b' });
        expect(delivered).toEqual(['a', 'b']);
    });
});
