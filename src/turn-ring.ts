import {
    appendFileSync,
    chmodSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    renameSync,
    statSync,
    unlinkSync,
    writeFileSync,
} from 'fs';
import { createHash, randomBytes } from 'crypto';
import { join } from 'path';
import { stateDir } from './gate.js';
import type { TurnEvent } from './transcript-tail.js';

/**
 * What the daemon has already sent a chat viewer, kept on disk so a
 * re-subscribe can replay it.
 *
 * Why this exists at all: the live lane is ephemeral, and the transcript
 * backfill deliberately replays only since the last prompt — finished turns are
 * supposed to already exist in the chat as their completion pushes. Under the
 * `quiet` push dial they do not exist, because that dial suppresses every
 * auto-push without a `high` marker. A turn's closing words were therefore
 * visible while it ran and gone the moment the viewer re-armed, with no record
 * on the phone, on the server, or in the 256KB backfill window.
 *
 * Re-deriving those turns from the transcript is not an option: measured over
 * this machine's transcripts larger than the window, the last 256KB holds a
 * median of one human prompt and none at all in 8 of 19 files — a single
 * `tool_result` line can be most of a megabyte. Projected events are a tool
 * name, a short label and a verdict, so the same bytes hold turns rather than
 * fragments of one.
 *
 * It lives beside `known-sessions.json` under `stateDir()` rather than in
 * `~/.zeph`, for the same reason that file does: this is derived session state
 * that expires, not configuration or keys.
 *
 * Everything here is best-effort. A ring that cannot be written costs the
 * scrollback, never the live send — the daemon's job is to keep talking.
 */

/**
 * One ring file. Trimming is by bytes and not by event count on purpose: a
 * prose event carries up to `MAX_EVENT_TEXT_CHARS` (5000) while a tool event's
 * label is clamped at `MAX_EVENT_FIELD_CHARS` (512), so a count would bound two
 * things an order of magnitude apart.
 */
export const MAX_TURN_RING_BYTES = 256 * 1024;

/** Sessions with a ring. Past this the oldest by mtime are dropped. */
export const MAX_TURN_RING_FILES = 20;

/** A week unwatched. Scrollback older than that is history, not context. */
export const TURN_RING_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const turnRingDir = (): string => join(stateDir(), 'turns');

/**
 * The session name is chosen by whoever sent the watch request, so it never
 * reaches the filesystem — a hash does. Same move as `hashListenerId`, at twice
 * the width: 64 bits, because these names collide within one machine's
 * directory rather than identifying one device.
 */
export const turnRingPath = (sessionName: string): string =>
    join(turnRingDir(), `${createHash('sha256').update(sessionName).digest('hex').slice(0, 16)}.jsonl`);

const isExpired = (path: string, now: number): boolean => {
    try {
        return now - statSync(path).mtimeMs > TURN_RING_TTL_MS;
    } catch {
        return false;
    }
};

const removeQuietly = (path: string): void => {
    try {
        unlinkSync(path);
    } catch {
        /* already gone, or not ours to delete */
    }
};

/** Keep the newest lines that fit under `MAX_TURN_RING_BYTES`. False when the cap still stands broken. */
const trimToCap = (path: string): boolean => {
    let raw: string;
    try {
        if (statSync(path).size <= MAX_TURN_RING_BYTES) return true;
        raw = readFileSync(path, 'utf-8');
    } catch {
        return false;
    }
    const lines = raw.split('\n').filter((line) => line.length > 0);
    let bytes = 0;
    let start = lines.length;
    // Walk back from the newest, taking lines until the next one would not fit.
    while (start > 0) {
        const size = Buffer.byteLength(lines[start - 1]!, 'utf-8') + 1;
        if (bytes + size > MAX_TURN_RING_BYTES) break;
        bytes += size;
        start--;
    }
    // A single line longer than the whole cap takes nothing, which would empty
    // the ring — and empty it again on every later append. The newest line
    // always survives; the one after it trims this one away in turn.
    start = Math.min(start, lines.length - 1);
    const kept = lines
        .slice(start)
        .map((line) => `${line}\n`)
        .join('');
    // Through a temp file, unlike the append: a kill mid-append costs the last
    // line, a kill mid-rewrite would cost the whole ring.
    // Random name, exclusive create: a predictable `${path}.tmp` is a file
    // another process on this machine can pre-create as a symlink and have this
    // write follow. `wx` fails instead of following one.
    const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
    try {
        writeFileSync(tmp, kept, { mode: 0o600, flag: 'wx' });
        renameSync(tmp, path);
        return true;
    } catch {
        removeQuietly(tmp);
        // The append landed but the cap did not. Saying the write succeeded
        // would let the file grow past its bound with nothing ever noticing.
        return false;
    }
};

/**
 * Record events this watch just sent. Call it with the same array that went out
 * — the ring's whole meaning is "what the viewer already received", and a replay
 * is that array sent again.
 */
export const appendTurnRing = (sessionName: string, events: readonly TurnEvent[]): boolean => {
    if (!events.length) return true;
    let path: string;
    try {
        // Inside the guard: the name arrives off the wire, and a non-string one
        // makes `createHash().update()` throw where "best-effort" is the whole
        // contract — a ring that cannot be written must never take a tick down.
        path = turnRingPath(sessionName);
        mkdirSync(turnRingDir(), { recursive: true, mode: 0o700 });
        appendFileSync(path, events.map((event) => `${JSON.stringify(event)}\n`).join(''), { mode: 0o600 });
        // `mode` on mkdir/append applies only when the entry is created, so a
        // directory or file that already exists keeps whatever it had — a
        // pre-created 0755 `turns/` would never become 0700 on its own. The
        // modes are the only thing standing between another local account and a
        // week of tool targets, prompts and URLs, so they are set every time
        // (`config.ts:84` chmods its own file for the same reason).
        chmodSync(turnRingDir(), 0o700);
        chmodSync(path, 0o600);
    } catch {
        // The caller says so once per session rather than per tick: a full disk
        // costs the scrollback, and silence about it costs the diagnosis.
        return false;
    }
    return trimToCap(path);
};

/**
 * What this session's viewers have already been sent, oldest first.
 *
 * An expired ring is deleted here rather than merely ignored: returning an empty
 * array and leaving the file would let the next append land on top of pre-expiry
 * content, and the TTL would bound nothing.
 */
export const readTurnRing = (sessionName: string, now: number = Date.now()): TurnEvent[] => {
    let raw: string;
    let path: string;
    try {
        // Same reason as the append: the name is wire input, and hashing a
        // non-string throws.
        path = turnRingPath(sessionName);
        if (isExpired(path, now)) {
            removeQuietly(path);
            return [];
        }
        raw = readFileSync(path, 'utf-8');
    } catch {
        return [];
    }
    const events: TurnEvent[] = [];
    for (const line of raw.split('\n')) {
        if (!line) continue;
        try {
            const parsed: unknown = JSON.parse(line);
            // `null`, `5`, `[]` and `{}` are all valid JSON. Without a shape
            // check a hand-edited or planted ring hands slice 02 a non-event to
            // seal and send. `kind` is what every branch downstream switches on,
            // so that is what makes a line an event — the same row-level filter
            // `session-registry.ts:52-62` applies to its own file.
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
            if (typeof (parsed as { kind?: unknown }).kind !== 'string') continue;
            events.push(parsed as TurnEvent);
        } catch {
            // A line the daemon was killed halfway through: skip it, keep the
            // rest — again the transcript reader's rule.
        }
    }
    return events;
};

/** Drop expired rings, then the oldest ones past `MAX_TURN_RING_FILES`. */
export const sweepTurnRings = (now: number = Date.now()): void => {
    const dir = turnRingDir();
    let names: string[];
    try {
        names = readdirSync(dir);
    } catch {
        return;
    }
    const live: { path: string; mtimeMs: number }[] = [];
    for (const name of names) {
        const path = join(dir, name);
        // A kill between the trim's write and its rename strands a temp file.
        // Nothing else would ever remove it, and left in place it counts
        // against MAX_TURN_RING_FILES and evicts a live ring early. Matching the
        // ring's own name shape rather than just the extension also means a
        // stray file dropped in here is cleaned up rather than counted.
        if (!/^[0-9a-f]{16}\.jsonl$/.test(name)) {
            removeQuietly(path);
            continue;
        }
        let mtimeMs: number;
        try {
            mtimeMs = statSync(path).mtimeMs;
        } catch {
            continue;
        }
        if (now - mtimeMs > TURN_RING_TTL_MS) removeQuietly(path);
        else live.push({ path, mtimeMs });
    }
    if (live.length <= MAX_TURN_RING_FILES) return;
    live.sort((a, b) => a.mtimeMs - b.mtimeMs);
    for (const stale of live.slice(0, live.length - MAX_TURN_RING_FILES)) removeQuietly(stale.path);
};

/**
 * Forget one session's scrollback outright — the machine was told to forget the
 * session. False when the file is still there, which the caller has to say out
 * loud: answering "forgotten" while a week of prompts and tool targets sits on
 * disk is the one wrong answer here.
 */
export const removeTurnRing = (sessionName: string): boolean => {
    let path: string;
    try {
        path = turnRingPath(sessionName);
    } catch {
        return true; // a name that cannot even be hashed has no ring
    }
    try {
        unlinkSync(path);
        return true;
    } catch (err) {
        // Already gone is the outcome the caller asked for. Checking existence
        // first and then unlinking would call a file that vanished in between a
        // failure, and answer "your scrollback is still there" about nothing.
        return (err as NodeJS.ErrnoException)?.code === 'ENOENT';
    }
};

/**
 * The three operations a watcher needs, as one injectable surface.
 *
 * The watcher takes this rather than importing the module so its tests can hold
 * the ring in memory — what the disk does is settled here, and re-proving it
 * through a socket-and-transcript harness would only make those tests slower and
 * no more truthful.
 */
export interface TurnRing {
    read: (sessionName: string) => TurnEvent[];
    /** False when nothing was written — a full disk, a directory that is not ours. */
    append: (sessionName: string, events: readonly TurnEvent[]) => boolean;
    sweep: () => void;
}

export const diskTurnRing: TurnRing = {
    read: (sessionName) => readTurnRing(sessionName),
    append: (sessionName, events) => appendTurnRing(sessionName, events),
    sweep: () => sweepTurnRings(),
};
