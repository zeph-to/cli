/**
 * Live agent-chat timeline: tail this machine's Claude Code transcripts and push
 * the small events off them over the relay the daemon already holds open.
 *
 * Sibling of the tmux mirror in `listener.ts`, deliberately not the same thing.
 * The mirror sends a picture of a terminal; this sends what the agent *did*, so
 * a phone can read a session the way the Claude app reads one — without the
 * viewer having to parse ANSI, and without any of it becoming a push (no quota,
 * no notification).
 *
 * Registry, lifecycle and framing mirror `activeStreams`/`stopStream`, because
 * a second shape for the same job is a second set of leaks to find. What differs
 * is the source: a file that grows, not a pane that repaints. `transcript-tail`
 * owns that difference and stays pure; this file owns the socket and the clock.
 *
 * Every dependency that touches the world arrives through `TurnWatchDeps`, so
 * the tests drive real ticks with a fake transcript and no WebSocket at all.
 */

import {
    initialTailState,
    projectTranscriptEntries,
    readTranscriptDelta,
    type TailState,
    type TurnEvent,
} from './transcript-tail.js';
import type { TurnRing } from './turn-ring.js';

/**
 * Watchers this daemon will run at once — the same ceiling, for the same reason,
 * as `MAX_CONCURRENT_STREAMS`. One machine can host a dozen tmux sessions, and
 * a viewer that opened them all would otherwise have every one polling forever.
 */
export const MAX_TURN_WATCHERS = 3;

/**
 * Poll cadence. The plan's user-visible bar is "a tool call shows up within 2s";
 * at 500 ms the read itself is never the reason it misses. Slower than the
 * mirror's 400 ms on purpose — this loop answers "what happened", not "what does
 * the screen look like", and nothing here is animated.
 */
export const TURN_POLL_INTERVAL_MS = 500;

/**
 * How long a watch survives without a renew.
 *
 * `watch.stop` is best-effort by construction: a swiped-away native sheet, a
 * killed tab, or a dropped socket destroys the viewer before it can say
 * anything. The lease — not the stop message — is what guarantees this daemon
 * stops reading. Matches the terminal stream's `STREAM_SUB_TTL_SECONDS`.
 */
export const TURN_LEASE_MS = 60_000;

/**
 * How often a live watch re-asks which transcript its session is writing.
 *
 * `/clear` and a compaction start a new session file under a new name; the old
 * one simply stops growing, so a watcher pinned to the path it resolved at
 * `start` goes quiet forever and looks exactly like an idle agent. Nothing in
 * the file itself can signal this — the answer lives in the session registry —
 * so it is asked for on a cadence rather than discovered.
 *
 * This is not a cheap question, and the number is chosen against its real cost:
 * `resolveTranscript` runs `readPaneInfo`, an uncached blocking
 * `spawnSync('tmux', …)` (`listener.ts`), and the pid-record memo behind it
 * expires every 4s (`remote-agents.ts` SNAPSHOT_TTL_MS), so a recheck is one
 * tmux spawn plus a real directory read — not a memo hit. At 10s per watcher and
 * at most three watchers that stays under what the session report already spends
 * on its own (`SESSION_REPORT_INTERVAL_MS` = 5s, one sweep for the whole
 * machine), while keeping how long a cleared session stays dark to one interval.
 */
export const TRANSCRIPT_RECHECK_MS = 10_000;

/**
 * Consecutive seal failures before the watch gives up and says so.
 *
 * Dropping a batch that will not seal is right; dropping every batch forever is
 * an empty timeline the viewer cannot tell from an idle session. The mirror
 * draws the same line with `STREAM_MAX_ENCRYPT_FAILURES`: fail closed, then stop
 * and send an error the other side can render.
 *
 * A live tick stops at its first unsealable page (see `readAndEmit`), so one
 * busy tick spends one failure; a replay's pages each spend one, as they did
 * before live ticks were paged.
 */
export const MAX_TURN_SEAL_FAILURES = 3;

/**
 * Ceiling on one replay, in events.
 *
 * The viewer keeps a bounded window of live turns, and a replay that filled it
 * on its own would push the turn actually in flight out of the very screen the
 * replay exists to fill. Below the web cap on purpose, so the live tail still
 * has room after a full replay.
 */
export const MAX_REPLAY_EVENTS = 400;

/**
 * Plaintext bytes per frame. Ephemeral frames ride API Gateway's 32KB WebSocket
 * limit, and sealing base64-expands what goes in it — so this is deliberately
 * below `SCREEN_PEEK_MAX_BYTES` (24KB, `listener.ts`), which bounds frames that
 * are never sealed.
 */
export const MAX_TURN_FRAME_BYTES = 12 * 1024;

/** Wire shape of one batch of timeline events. */
export type TurnDeltaFrame = {
    subtype: 'agent.turn.delta';
    sessionName: string;
    /** Incarnation of this watch. See `AgentTurnDeltaFrame` (zeph `libs/feed-ui`)
     *  for why the pair exists; the mirror stamps frames the same way
     *  (`StreamFramePayload.epoch`). */
    epoch: number;
    seq: number;
    /** Plaintext batch — present only when the subscriber supplied no key. */
    events?: TurnEvent[];
    /** Sealed batch — the same array, encrypted for the subscriber. */
    encrypted?: unknown;
};

/** What a viewer sends to start, keep, or end a watch. */
export interface TurnWatchControl {
    subtype?: string;
    targetDeviceId?: string;
    sessionName?: string;
    /**
     * The viewer's device public key. Present when that device can open what it
     * asks to be sealed; absent on a device with no keypair, which then reads
     * the same events in the clear — the convention `useAgentDiff` and
     * `TerminalStreamView` already follow on the web side. Encryption is a paid
     * feature, so refusing to serve an unsealed viewer would quietly make the
     * whole timeline paid too.
     */
    subscriberPublicKey?: string;
}

export type SendTurnFrame = (data: Record<string, unknown>) => void;

export interface TurnWatchDeps {
    /** This machine's listener device id — control messages that name another are not ours. */
    deviceId: () => string;
    /** tmux session name → transcript file, or null when this session has none (a non-Claude agent). */
    resolveTranscript: (sessionName: string) => string | null;
    /** Whether tmux still holds this session. A watch outlives its pane otherwise. */
    sessionExists: (sessionName: string) => boolean;
    /**
     * Load-or-create this device's keypair. Rejecting means this daemon cannot
     * seal at all, which a viewer that asked for a seal must be told about
     * rather than discovering three dropped batches later.
     */
    initCrypto: () => Promise<void>;
    /** Seal a batch for the subscriber. Rejecting drops the batch; it never falls back to plaintext. */
    seal: (plaintext: string, subscriberPublicKey: string) => Promise<unknown>;
    log: (message: string) => void;
    /** Where a watch's events are kept so a later watch can replay them. */
    ring: TurnRing;
    now?: () => number;
}

interface Watcher {
    sessionName: string;
    transcriptPath: string;
    subscriberPublicKey?: string;
    tail: TailState | null;
    timer: NodeJS.Timeout | undefined;
    expiresAt: number;
    seq: number;
    epoch: number;
    sealFailures: number;
    /** When the transcript path was last re-resolved. */
    checkedAt: number;
    send: SendTurnFrame;
    /** The first read backfills, so it keeps only the turn still in flight. */
    backfilling: boolean;
    /** Whether this watch has already said its ring cannot be written. */
    ringWriteFailed?: boolean;
    events: number;
    startedAt: number;
}

type WatchSubtype = 'agent.turn.watch.start' | 'agent.turn.watch.stop' | 'agent.turn.watch.renew';

const isWatchSubtype = (subtype: unknown): subtype is WatchSubtype =>
    subtype === 'agent.turn.watch.start' ||
    subtype === 'agent.turn.watch.stop' ||
    subtype === 'agent.turn.watch.renew';

/**
 * The part of a backfill the ring has not already sent.
 *
 * A restart re-reads the same region of the transcript the ring was filled
 * from, so without this the first frames after every re-open would repeat the
 * turn the replay just drew. An event with no `at` is kept: a transcript entry
 * with no timestamp gives the cut nothing to compare, and showing a turn twice
 * is recoverable where dropping one is not.
 *
 * The line is read off the ring at cut time rather than tracked as the watcher
 * sends, so it says exactly what has been recorded — a live batch the seal
 * refused was never appended and so never moves it. (A replayed page is the
 * other case: it came out of the ring, so it counts whether or not this viewer
 * received it, and the next re-open replays it again.) Reading it here also
 * removes a race, since `beginWatch` starts the replay without awaiting it and
 * a cached line could still be unset when the first poll lands.
 */
const afterRingTail = (events: TurnEvent[], held: readonly TurnEvent[]): TurnEvent[] => {
    let tail: string | undefined;
    for (const event of held) {
        if (event.at && (!tail || event.at > tail)) tail = event.at;
    }
    return tail ? events.filter((event) => !event.at || event.at > tail) : events;
};

/**
 * Cut a batch into frames of at most MAX_TURN_FRAME_BYTES of plaintext. One
 * event bigger than the whole budget still goes, alone: prose is clamped at
 * MAX_EVENT_TEXT_CHARS characters, not bytes, so a Korean paragraph can reach
 * ~15KB — the budget keeps a *batch* inside the transport, it is not a promise
 * about every single event.
 */
const pagesOf = (events: readonly TurnEvent[]): TurnEvent[][] => {
    // A page serialises as `[e1,e2,…]`: each event plus its comma, and one more
    // byte for the brackets' remainder — so a page starts at 1, not 0.
    const pages: TurnEvent[][] = [];
    let page: TurnEvent[] = [];
    let bytes = 1;
    for (const event of events) {
        const size = Buffer.byteLength(JSON.stringify(event), 'utf-8') + 1;
        if (page.length && bytes + size > MAX_TURN_FRAME_BYTES) {
            pages.push(page);
            page = [];
            bytes = 1;
        }
        page.push(event);
        bytes += size;
    }
    if (page.length) pages.push(page);
    return pages;
};

/**
 * A registry of transcript watchers plus the control handler that drives it.
 *
 * A factory rather than module state so a test can hold its own, and so two of
 * them never share a clock or a socket by accident.
 */
export const createTurnWatchers = (deps: TurnWatchDeps) => {
    const now = deps.now ?? Date.now;
    const watchers = new Map<string, Watcher>();
    /** Still the same incarnation it was at `epoch` — not stopped, not re-seeded since. */
    const isCurrent = (watcher: Watcher, epoch: number): boolean =>
        watchers.get(watcher.sessionName) === watcher && watcher.epoch === epoch;

    const stop = (sessionName: string, reason: string): void => {
        const watcher = watchers.get(sessionName);
        if (!watcher) return;
        clearTimeout(watcher.timer);
        // Drop every reference the timer closure was holding alive — the tail
        // state carries a partial-line buffer, and a watcher left in the map is
        // that buffer left in the heap.
        watcher.timer = undefined;
        watchers.delete(sessionName);
        const secs = (now() - watcher.startedAt) / 1000;
        deps.log(
            `⧉ turn-watch ${sessionName} stopped (${reason}): ${watcher.events} events over ${secs.toFixed(1)}s`,
        );
    };

    const stopAll = (reason: string): void => {
        for (const sessionName of [...watchers.keys()]) stop(sessionName, reason);
    };

    /**
     * One read of one transcript. Exported through the returned object so tests
     * drive it directly instead of waiting on a real timer — the same shape the
     * mirror's cadence tests use.
     */
    const tick = async (sessionName: string): Promise<void> => {
        const watcher = watchers.get(sessionName);
        if (!watcher) return;

        if (now() >= watcher.expiresAt) {
            stop(sessionName, 'lease expired');
            return;
        }
        // The pane can go away under a watch that a viewer keeps renewing. Left
        // alone it would poll a dead session's transcript forever — and if the
        // name is reused, poll the wrong one. The mirror reaps on the same tick
        // for the same reason (`listener.ts` lease check).
        if (!deps.sessionExists(sessionName)) {
            stop(sessionName, 'tmux session gone');
            return;
        }

        try {
            await readAndEmit(watcher);
        } finally {
            // Re-arm even if the read threw. A watcher that stops re-arming never
            // reaches its own lease check either, so it would hold one of
            // MAX_TURN_WATCHERS slots until the socket closed.
            if (watchers.get(sessionName) === watcher) arm(watcher);
        }
    };

    const readAndEmit = async (watcher: Watcher): Promise<void> => {
        const { sessionName } = watcher;

        // Follow the session if it started writing somewhere else. Keeping the
        // old path would be a watch that never reports again and never says why.
        if (now() - watcher.checkedAt >= TRANSCRIPT_RECHECK_MS) {
            watcher.checkedAt = now();
            const current = deps.resolveTranscript(sessionName);
            if (current && current !== watcher.transcriptPath) {
                deps.log(`⧉ turn-watch ${sessionName}: transcript rotated — following the new session file`);
                reseed(watcher, current, watcher.subscriberPublicKey, watcher.send);
            }
        }
        const read = readTranscriptDelta(watcher.transcriptPath, watcher.tail);
        // `null` is the idle case and the common one: nothing was appended, so
        // nothing was read, parsed, or allocated.
        if (read) {
            watcher.tail = read.state;
            if (read.droppedLines) {
                deps.log(`⧉ turn-watch ${sessionName}: dropped ${read.droppedLines} oversized line(s)`);
            }
            if (read.lines.length) {
                const projected = projectTranscriptEntries(read.lines, { sinceLastPrompt: watcher.backfilling });
                const backfilling = watcher.backfilling;
                watcher.backfilling = false;
                // Cut before the send, not after: the ring records what went out,
                // so recording the uncut batch would make the next replay resend
                // what this one just skipped.
                const events = backfilling ? afterRingTail(projected, deps.ring.read(sessionName)) : projected;
                // Paged like the replay: a busy tick is otherwise one frame of any
                // size, past the transport's frame limit (see MAX_TURN_FRAME_BYTES).
                // A page that will not seal drops the rest of the tick — as a whole
                // batch was dropped before paging — so a failure counts once per
                // tick. A stop or a re-seed during a seal ends the batch too: the
                // rest belongs to a tail the watcher no longer reads.
                const epoch = watcher.epoch;
                for (const page of pagesOf(events)) {
                    if (!(await emit(watcher, page))) return;
                    recordSent(watcher, page);
                    if (!isCurrent(watcher, epoch)) return;
                }
            }
        }
    };

    const arm = (watcher: Watcher): void => {
        watcher.timer = setTimeout(() => {
            void tick(watcher.sessionName);
        }, TURN_POLL_INTERVAL_MS);
        // A pending read must never hold the process open — the daemon's
        // lifetime is the socket's, not this loop's.
        watcher.timer.unref?.();
    };

    const emit = async (watcher: Watcher, events: TurnEvent[]): Promise<boolean> => {
        const frame: TurnDeltaFrame = {
            subtype: 'agent.turn.delta',
            sessionName: watcher.sessionName,
            epoch: watcher.epoch,
            seq: ++watcher.seq,
        };

        if (watcher.subscriberPublicKey) {
            try {
                frame.encrypted = await deps.seal(JSON.stringify(events), watcher.subscriberPublicKey);
                watcher.sealFailures = 0;
            } catch (err) {
                // Fail closed. A sealed watch that quietly starts sending in the
                // clear is indistinguishable from a relay that stripped the key,
                // so the batch is dropped instead.
                deps.log(
                    `⧉ turn-watch ${watcher.sessionName}: seal failed (${err instanceof Error ? err.message : err}) — batch dropped`,
                );
                if (++watcher.sealFailures >= MAX_TURN_SEAL_FAILURES) {
                    // Silence would read as "this session is idle". Say what
                    // happened and stop, so the viewer can show it and re-arm.
                    watcher.send({
                        subtype: 'agent.turn.watch.error',
                        sessionName: watcher.sessionName,
                        error: 'seal_failed',
                    });
                    stop(watcher.sessionName, 'seal failed');
                }
                return false;
            }
        } else {
            frame.events = events;
        }

        watcher.events += events.length;
        watcher.send(frame as unknown as Record<string, unknown>);
        return true;
    };

    /**
     * Everything a batch that actually went out changes.
     *
     * The ring's whole meaning is "what this viewer has already been handed", so
     * it is written here and nowhere else — a batch the seal refused never
     * reached anyone and must not come back as scrollback.
     */
    const recordSent = (watcher: Watcher, events: TurnEvent[]): void => {
        let wrote = false;
        try {
            wrote = deps.ring.append(watcher.sessionName, events);
        } catch {
            // The ring is injected, so a caller's implementation can throw where
            // this one returns false. Either way the live send has already
            // happened and must not be undone by the record of it.
        }
        // Once per watch, not per tick: a full disk stays full, and a line every
        // 500ms would bury the log it is trying to explain.
        if (!wrote && !watcher.ringWriteFailed) {
            watcher.ringWriteFailed = true;
            // Deliberately not "the scrollback will be short": the same false
            // covers a trim that could not run, where the file is over its cap
            // rather than under-filled. One line that is true of both.
            deps.log(`⧉ turn-watch ${watcher.sessionName}: ring write failed — scrollback for this session is unreliable`);
        }
    };

    /**
     * Send what the ring holds, oldest first, before the transcript is read.
     *
     * This is the reason the ring exists: the backfill replays only since the
     * last prompt, on the assumption that finished turns are already in the chat
     * as their completion pushes — which under the `quiet` dial they are not.
     *
     * Paged, because one frame is bounded by the transport and a week of turns
     * is not. Through `emit`, because that is where a subscriber's seal is
     * applied; not through `recordSent`, because these events are already in the
     * ring and re-appending them would double it on every re-open.
     */
    const replayRing = async (watcher: Watcher): Promise<void> => {
        const held = deps.ring.read(watcher.sessionName);
        if (!held.length) return;
        const recent = held.length > MAX_REPLAY_EVENTS ? held.slice(held.length - MAX_REPLAY_EVENTS) : held;
        // A second `start` on this same watcher re-seeds it and begins its own
        // replay, and the object identity check below cannot see that — it is
        // the same object. The epoch is what a re-seed changes, so a replay
        // that has been superseded stops here instead of interleaving its pages
        // with the newer one's.
        const epoch = watcher.epoch;
        for (const page of pagesOf(recent)) {
            // A refused page is not the end of the history: `emit` already
            // counts seal failures and ends the watch at MAX_TURN_SEAL_FAILURES
            // — which the viewer is told about — so stopping here on one
            // transient failure would leave scrollback silently short,
            // indistinguishable from a quiet session.
            await emit(watcher, page);
            if (!isCurrent(watcher, epoch)) return;
        }
    };

    /**
     * Handle one relay message. Returns true when it was ours, so the caller's
     * handler chain stops — the same contract as `handleStreamControl`.
     */
    const handle = (req: TurnWatchControl, send: SendTurnFrame): boolean => {
        if (!isWatchSubtype(req.subtype)) return false;
        // The relay fans control messages out to every connection this user has,
        // so two machines running the same tmux session name both see this one.
        // Addressing decides here, exactly as it does for stream control.
        if (req.targetDeviceId !== deps.deviceId()) return false;
        if (!req.sessionName) return true;

        if (req.subtype === 'agent.turn.watch.stop') {
            stop(req.sessionName, 'viewer left');
            return true;
        }

        const existing = watchers.get(req.sessionName);
        if (existing) {
            existing.expiresAt = now() + TURN_LEASE_MS;
            if (req.subtype !== 'agent.turn.watch.start') {
                send({ subtype: 'agent.turn.watch.ok', sessionName: req.sessionName });
                return true;
            }
            // A start is a viewer arriving, not a heartbeat — and the viewer it
            // replaces may have left mid-turn without its `stop` landing. Treat
            // it as a fresh watch on a live registry entry: everything the
            // constructor below decides is decided again.
            //
            // Skipping this is what left the timeline blank on the exact path the
            // lease exists for (swipe away, come back inside 60s): the old
            // watcher's offset is already at EOF, so nothing backfills and
            // nothing has been appended yet.
            const transcriptPath = deps.resolveTranscript(req.sessionName);
            if (!transcriptPath) {
                // The session died and a new one took its name, or it was never
                // Claude Code. Either way the old file is not this session's.
                stop(req.sessionName, 'transcript gone');
                send({ subtype: 'agent.turn.watch.error', sessionName: req.sessionName, error: 'no_transcript' });
                return true;
            }
            beginWatch(existing, transcriptPath, req.subscriberPublicKey, send);
            return true;
        }
        if (req.subtype === 'agent.turn.watch.renew') {
            // Nothing to renew — say so rather than silently doing nothing, so
            // the viewer can start one instead of waiting on a watch that ended.
            send({ subtype: 'agent.turn.watch.gone', sessionName: req.sessionName });
            return true;
        }

        if (watchers.size >= MAX_TURN_WATCHERS) {
            send({ subtype: 'agent.turn.watch.error', sessionName: req.sessionName, error: 'watch_limit' });
            return true;
        }

        const transcriptPath = deps.resolveTranscript(req.sessionName);
        if (!transcriptPath) {
            // Not an error: a Codex or Gemini session has no Claude transcript.
            // The viewer needs to say "no live timeline here" rather than show an
            // empty screen that reads as a hang.
            send({ subtype: 'agent.turn.watch.error', sessionName: req.sessionName, error: 'no_transcript' });
            return true;
        }

        const watcher: Watcher = {
            sessionName: req.sessionName,
            transcriptPath,
            subscriberPublicKey: req.subscriberPublicKey,
            tail: initialTailState(),
            timer: undefined,
            expiresAt: now() + TURN_LEASE_MS,
            seq: 0,
            epoch: 0,
            sealFailures: 0,
            checkedAt: 0,
            send,
            backfilling: true,
            events: 0,
            startedAt: now(),
        };
        watchers.set(req.sessionName, watcher);
        // Once per new watch, not per tick: the sweep is a directory read, and a
        // machine that has run agents for months is the only one it matters for.
        deps.ring.sweep();
        beginWatch(watcher, transcriptPath, req.subscriberPublicKey, send);
        return true;
    };

    /**
     * Everything a `start` means, in one place.
     *
     * Both branches of `handle` — a watcher that already exists and one just
     * built — end here, because a start means the same thing either way: point
     * at the transcript, tell the viewer, begin reading. Two copies of that
     * sequence is how the next step added to it ends up in only one of them.
     */
    const beginWatch = (
        watcher: Watcher,
        transcriptPath: string,
        subscriberPublicKey: string | undefined,
        send: SendTurnFrame,
    ): void => {
        reseed(watcher, transcriptPath, subscriberPublicKey, send);
        send({ subtype: 'agent.turn.watch.ok', sessionName: watcher.sessionName });
        void sealThenRead(watcher, subscriberPublicKey);
    };

    /**
     * Point a watcher at a transcript and hand it to a viewer, from scratch.
     *
     * Shared by "new watch" and "a start on an existing one" so the two can never
     * disagree about what a start means — the second case is where the whole
     * backfill contract used to fall through.
     */
    const reseed = (
        watcher: Watcher,
        transcriptPath: string,
        subscriberPublicKey: string | undefined,
        send: SendTurnFrame,
    ): void => {
        // Disarm first. `startTicking` below arms a fresh timer into
        // `watcher.timer`, and whatever was already pending there would be
        // overwritten while still scheduled — it fires, re-arms its own chain,
        // and now the session is polled twice per interval, once more for every
        // re-start, with only the newest handle reachable by `stop`.
        clearTimeout(watcher.timer);
        watcher.timer = undefined;
        watcher.transcriptPath = transcriptPath;
        // Backfill again: the point of a start is that someone is looking now.
        watcher.tail = initialTailState();
        watcher.backfilling = true;
        // A watch is keyed by session, not by viewer, so a keyless device that
        // arrived first must not pin the session to plaintext for one that can
        // read it sealed. A start always re-states who is watching and how.
        watcher.subscriberPublicKey = subscriberPublicKey;
        watcher.send = send;
        watcher.sealFailures = 0;
        // New counter incarnation, so the viewer resets rather than discarding
        // everything below its old high-water mark.
        watcher.epoch += 1;
        watcher.seq = 0;
        watcher.ringWriteFailed = false;
        watcher.checkedAt = now();
        deps.log(`⧉ turn-watch ${watcher.sessionName} started (${subscriberPublicKey ? 'sealed' : 'plaintext'})`);
    };

    /**
     * Settle the encryption question, then read once.
     *
     * Mostly this is the handshake: a viewer that asked for a seal gets the
     * keypair loaded before any batch is built, and a failure ends the watch
     * rather than letting the first batches die one at a time — three silent
     * drops read as an idle session, which is the one thing this surface must
     * never look like when it is broken.
     *
     * The read that follows is immediate so the in-flight turn is on screen when
     * the chat opens, not one poll interval later.
     */
    const sealThenRead = async (watcher: Watcher, subscriberPublicKey: string | undefined): Promise<void> => {
        if (subscriberPublicKey) {
            try {
                await deps.initCrypto();
            } catch (err) {
                deps.log(
                    `⧉ turn-watch ${watcher.sessionName}: device crypto init failed (${err instanceof Error ? err.message : err}) — refusing to watch (fail-closed)`,
                );
                watcher.send({
                    subtype: 'agent.turn.watch.error',
                    sessionName: watcher.sessionName,
                    error: 'e2ee_unavailable',
                });
                stop(watcher.sessionName, 'e2ee unavailable');
                return;
            }
            if (watchers.get(watcher.sessionName) !== watcher) return;
        }
        // Before the read, so the chat draws its history and then its live turn
        // in the order they happened.
        await replayRing(watcher);
        if (watchers.get(watcher.sessionName) !== watcher) return;
        await tick(watcher.sessionName);
    };

    return { handle, stop, stopAll, tick, size: () => watchers.size };
};

export type TurnWatchers = ReturnType<typeof createTurnWatchers>;
