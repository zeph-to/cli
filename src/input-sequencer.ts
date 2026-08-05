/**
 * Inbound ordering guard for keys/text arriving over the ephemeral relay.
 *
 * The outbound stream stamps every frame with `seq` + `epoch` so the viewer
 * can drop what it has already painted (see listener.ts buildStreamFrame's
 * send site); this is the inverse for the inbound direction. A dropped or
 * reordered keystroke is not a cosmetic glitch the way a stale frame is —
 * it lands in a real editor buffer — so the rules differ:
 *
 * - in-order seq delivers immediately (typing latency is the whole point of
 *   this path; nothing is buffered on the happy path)
 * - a gap holds later keys for `holdMs`, then delivers what arrived anyway.
 *   Approximate order beats dropped keys: the relay is at-most-once, so a
 *   never-arriving seq must not wedge everything behind it forever.
 * - a new epoch (sender restart) resets the high-water mark, and the old
 *   epoch's held keys are discarded rather than typed into the new run
 * - a seq at or below the high-water mark is a straggler the hold already
 *   flushed past — typing it now would put it out of order. The transport is
 *   at-most-once, so this is never a transport duplicate; the sender is told
 *   (`stale`) so it can decide whether the key still matters.
 *
 * Every outcome that drops a message is reported — as a non-'ok' AcceptResult
 * for the message being accepted, or through `onDiscard` for held messages
 * swept out by an epoch change or reset. The caller's contract ("every
 * refusal reaches the sender") is only as honest as this accounting.
 */

/** How long a key waits for the gap in front of it to fill. */
export const INPUT_HOLD_MS = 500;

/** Ceiling on the reorder buffer. A gap that never fills lets every later key
 *  pile up for the whole hold, and the flush then delivers them back to back —
 *  one blocking tmux inject each. 32 is far past any real burst at
 *  INPUT_HOLD_MS, so this only bites on a stuck or hostile sender. */
export const MAX_PENDING_INPUTS = 32;

/** Non-'ok' means this message was dropped and the caller owes its sender a
 *  refusal: `overflow` (buffer full), `superseded` (older epoch than the
 *  current run), `stale` (at or below the high-water mark — the hold already
 *  flushed past it). 'ok' covers delivered AND held; held messages that are
 *  later swept out surface through `onDiscard` instead. */
export type AcceptResult = 'ok' | 'overflow' | 'superseded' | 'stale';

/** Cancels a pending flush. */
type CancelFlush = () => void;

/** Injectable timer so tests drive the hold deadline instead of sleeping. */
export type ScheduleFlush = (fn: () => void, ms: number) => CancelFlush;

export type SequencedInput = {
    /** Sender-side monotonic counter within `epoch`. */
    seq: number;
    /** Sender incarnation — a restart bumps it and restarts `seq`. */
    epoch: number;
};

export type InputSequencerOptions<T> = {
    holdMs?: number;
    schedule?: ScheduleFlush;
    /** Called for each HELD message dropped without delivery — an epoch change
     *  or reset() sweeping the buffer. Accept-time drops are reported via the
     *  AcceptResult instead, so no message can vanish through both cracks. */
    onDiscard?: (msg: T) => void;
};

export type InputSequencer<T extends SequencedInput> = {
    accept: (msg: T) => AcceptResult;
    /** Drop everything held (reported via onDiscard) and forget the epoch —
     *  the run is over. */
    reset: () => void;
};

const defaultSchedule: ScheduleFlush = (fn, ms) => {
    const timer = setTimeout(fn, ms);
    // A pending flush must not keep the daemon's event loop alive.
    timer.unref?.();
    return () => clearTimeout(timer);
};

export const createInputSequencer = <T extends SequencedInput>(
    deliver: (msg: T) => void,
    opts: InputSequencerOptions<T> = {},
): InputSequencer<T> => {
    const holdMs = opts.holdMs ?? INPUT_HOLD_MS;
    const schedule = opts.schedule ?? defaultSchedule;

    let epoch: number | null = null;
    let highWater = 0;
    let cancelFlush: CancelFlush | null = null;
    const pending = new Map<number, T>();

    const disarm = (): void => {
        cancelFlush?.();
        cancelFlush = null;
    };

    /** Sweep the hold buffer without delivering — each swept message is a
     *  keystroke its sender still waits on, so each is reported. */
    const discardPending = (): void => {
        const swept = [...pending.values()];
        pending.clear();
        disarm();
        for (const msg of swept) opts.onDiscard?.(msg);
    };

    const emit = (msg: T): void => {
        highWater = msg.seq;
        deliver(msg);
    };

    /** Release the unbroken run sitting on top of the high-water mark. */
    const drain = (): void => {
        for (;;) {
            const next = pending.get(highWater + 1);
            if (!next) break;
            pending.delete(next.seq);
            emit(next);
        }
        if (!pending.size) disarm();
    };

    /** Hold expired: the missing seq is not coming. Deliver the rest in seq
     *  order, which also moves the high-water mark past the hole. */
    const flush = (): void => {
        cancelFlush = null;
        const held = [...pending.values()].sort((a, b) => a.seq - b.seq);
        pending.clear();
        for (const msg of held) emit(msg);
    };

    const accept = (msg: T): AcceptResult => {
        if (epoch === null || msg.epoch > epoch) {
            // First message of a run — whatever seq it carries is in order by
            // definition, so joining a stream mid-flight costs no hold.
            discardPending();
            epoch = msg.epoch;
            highWater = msg.seq - 1;
        } else if (msg.epoch < epoch) {
            return 'superseded';
        }
        if (msg.seq <= highWater || pending.has(msg.seq)) return 'stale';
        if (msg.seq === highWater + 1) {
            emit(msg);
            drain();
            return 'ok';
        }
        // Drop the NEW message, not a held one: the buffer already holds the
        // keys closest to the gap, and evicting those would reorder what is
        // about to be typed.
        if (pending.size >= MAX_PENDING_INPUTS) return 'overflow';
        pending.set(msg.seq, msg);
        // One deadline per gap: it dates from when the hole opened, so a
        // steady stream of later keys can't extend the wait indefinitely.
        if (!cancelFlush) cancelFlush = schedule(flush, holdMs);
        return 'ok';
    };

    return {
        accept,
        reset: () => {
            discardPending();
            epoch = null;
            highWater = 0;
        },
    };
};
