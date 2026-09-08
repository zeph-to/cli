/**
 * Claude Code session transcript (`~/.claude/projects/<hash>/<uuid>.jsonl`) →
 * the small events the agent chat timeline draws.
 *
 * Two pure pieces, deliberately split: reading bytes off a growing file, and
 * deciding what of it is worth putting on the wire. Neither touches the socket,
 * so both are testable without tmux, WebSocket, or a clock.
 *
 * Everything here is sized by what a real transcript actually contains, measured
 * 2026-09-08 over 1443 files in `~/.claude/projects`: the largest file was
 * 75.9 MB (p90 1.1 MB) and the longest single line 915,292 bytes. Those two
 * numbers are why the reader starts near the end and refuses oversized lines
 * before parsing them — a tail that starts at byte 0, or that hands a ~1 MB
 * string to `JSON.parse` and only then decides to drop it, has already paid the
 * cost the cap exists to avoid.
 */

import { openSync, readSync, closeSync, statSync } from 'node:fs';

/**
 * How far back from the end of the file the first read starts.
 *
 * Not zero: a fresh viewer that sees nothing until the *next* tool call is a
 * blank screen for whoever just picked up their phone mid-turn. Not the whole
 * file either — that is up to 75.9 MB. A fixed window from the end costs the
 * same on an 8 KB transcript and a 76 MB one.
 */
export const TRANSCRIPT_BACKFILL_BYTES = 256 * 1024;

/** Ceiling on one tick's read, so a burst of appends cannot be swallowed whole. */
export const MAX_TAIL_BYTES_PER_TICK = 256 * 1024;

/**
 * A line longer than this is abandoned unparsed, the reader skipping to the next
 * newline. The measured worst case is a 915 KB `tool_result`, whose body this
 * module drops anyway — buffering one to completion would be paying megabytes to
 * learn a tool id.
 */
export const MAX_TRANSCRIPT_LINE_CHARS = 1024 * 1024;

/** Ceiling on any single string that reaches the wire. */
export const MAX_EVENT_FIELD_CHARS = 512;

/**
 * Where the reader is in one file.
 *
 * `size`/`mtimeMs` are the skip check: when neither moved there is nothing to
 * read, and the tick returns without allocating. Since idle is this watcher's
 * normal state, that check is what keeps it off the GC's back.
 */
export interface TailState {
    readonly offset: number;
    readonly size: number;
    readonly mtimeMs: number;
    /** Bytes after the last newline seen — an incomplete line, held for the next tick. */
    readonly carry: string;
    /** Inside an oversized line: discard bytes until the next newline. */
    readonly resyncing: boolean;
}

export interface TailRead {
    /** Whole lines, in file order. Never includes a partial line. */
    readonly lines: string[];
    readonly state: TailState;
    readonly bytesRead: number;
    /** Lines abandoned for exceeding MAX_TRANSCRIPT_LINE_CHARS. */
    readonly droppedLines: number;
}

/**
 * How much of `buffer[0..read)` ends on a UTF-8 character boundary.
 *
 * A sequence is at most 4 bytes, so at most 3 trailing bytes can belong to a
 * character whose remainder has not arrived. Walk back over continuation bytes
 * (`10xxxxxx`) to the lead byte and ask how long its character should be; if the
 * buffer holds all of it, the read is already complete.
 */
const completeUtf8Length = (buffer: Buffer, read: number): number => {
    for (let back = 1; back <= 3 && back <= read; back++) {
        const byte = buffer[read - back]!;
        if ((byte & 0b1100_0000) === 0b1000_0000) continue; // continuation — keep walking
        const width = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
        return back >= width ? read : read - back;
    }
    return read;
};

/**
 * No state yet. `null` rather than a sentinel-filled record: "never read this
 * file" and "read it and got nothing" are different, and an out-of-band value
 * that has to stay below every real offset is a trap for the next `>=`.
 */
export const initialTailState = (): TailState | null => null;

/**
 * Read what was appended since `prev`, or `null` when there is nothing to do —
 * the file is unreadable, or neither its size nor its mtime moved.
 *
 * `null` is the common case (an idle session) and is deliberately allocation
 * free: no buffer, no string, no array.
 */
export const readTranscriptDelta = (path: string, prev: TailState | null): TailRead | null => {
    let stat;
    try {
        stat = statSync(path);
    } catch {
        return null;
    }

    const { size, mtimeMs } = stat;

    // Caught up AND untouched. `offset >= size` matters on its own: a tick that
    // stopped at MAX_TAIL_BYTES_PER_TICK leaves bytes behind on a file that has
    // not changed since, and skipping there would strand them until the next append.
    if (prev && prev.offset >= size && size === prev.size && mtimeMs === prev.mtimeMs) return null;

    // A file that shrank was replaced or truncated in place. Note this does NOT
    // cover a `/clear`, which writes a *different* file: the old one simply stops
    // growing, and nothing here notices. Re-resolving the session id belongs to
    // the caller and is not implemented yet.
    //
    // Either way — first attach or rotation — everything remembered about the old
    // contents is meaningless, so the read restarts from a window off the end.
    const restart = !prev || size < prev.offset;

    const start = restart ? Math.max(0, size - TRANSCRIPT_BACKFILL_BYTES) : prev.offset;
    // A window that starts mid-line yields a fragment of a record that began
    // before it, so that fragment is dropped rather than parsed.
    const truncatedStart = restart && start > 0;
    const carry = restart ? '' : prev.carry;
    let resyncing = restart ? false : prev.resyncing;

    const want = Math.min(size - start, MAX_TAIL_BYTES_PER_TICK);
    if (want <= 0) {
        return {
            lines: [],
            state: { offset: start, size, mtimeMs, carry, resyncing },
            bytesRead: 0,
            droppedLines: 0,
        };
    }

    const buffer = Buffer.allocUnsafe(want);
    let read = 0;
    let fd: number | undefined;
    try {
        fd = openSync(path, 'r');
        read = readSync(fd, buffer, 0, want, start);
    } catch {
        return null;
    } finally {
        if (fd !== undefined) closeSync(fd);
    }

    // A tick that stops at MAX_TAIL_BYTES_PER_TICK can land inside a multi-byte
    // character. Decoding to that boundary turns both halves into U+FFFD, and the
    // line then fails JSON.parse and vanishes without even being counted as
    // dropped — a silent hole that only shows up on non-ASCII transcripts under
    // bursty appends. Back the read up to the last complete sequence instead; the
    // bytes are not lost, the next tick starts on them.
    const usable = read < want ? read : completeUtf8Length(buffer, read);
    const chunk = buffer.toString('utf8', 0, usable);
    const lines: string[] = [];
    let droppedLines = 0;
    let pending = carry;
    let cursor = 0;

    while (cursor <= chunk.length) {
        const nl = chunk.indexOf('\n', cursor);
        if (nl === -1) {
            pending += chunk.slice(cursor);
            break;
        }

        const complete = pending + chunk.slice(cursor, nl);
        cursor = nl + 1;
        pending = '';

        if (resyncing) {
            // This newline ends the oversized line; the next one starts clean.
            resyncing = false;
            continue;
        }
        if (complete.length > MAX_TRANSCRIPT_LINE_CHARS) {
            droppedLines += 1;
            continue;
        }
        lines.push(complete);
    }

    // The window began mid-line, so whatever came before the first newline is a
    // fragment of a record that started before `start`.
    if (truncatedStart && lines.length > 0) lines.shift();

    if (pending.length > MAX_TRANSCRIPT_LINE_CHARS) {
        // Still no newline and already past the cap — stop growing the buffer and
        // discard bytes until the line ends. Holding it to completion would cost
        // megabytes for a record whose body never reaches the wire anyway.
        droppedLines += 1;
        pending = '';
        resyncing = true;
    }

    return {
        lines,
        state: { offset: start + usable, size, mtimeMs, carry: pending, resyncing },
        bytesRead: usable,
        droppedLines,
    };
};

// ── projection ───────────────────────────────────────────────────────────────

/**
 * What the timeline draws. Stateless by design: a `tool_result` arrives as its
 * own event rather than mutating an earlier one, because the call it answers is
 * routinely in a previous tick's batch — merging by `id` is the viewer's job,
 * and it is the only side that holds the whole turn.
 */
export type TurnEvent =
    | { kind: 'tool'; id: string; name: string; target?: string }
    | { kind: 'tool_result'; id: string; ok: boolean }
    | { kind: 'text'; text: string }
    | { kind: 'prompt'; text: string };

/**
 * Which input field reads as "what this call is about". Ordered, first match
 * wins: `description` beats `command` because it is the sentence a human wrote
 * about the command, which is exactly what a collapsed timeline row wants.
 */
const TARGET_KEYS = ['description', 'file_path', 'path', 'pattern', 'query', 'url', 'skill', 'command'] as const;

const clamp = (value: string): string =>
    value.length > MAX_EVENT_FIELD_CHARS ? value.slice(0, MAX_EVENT_FIELD_CHARS) : value;

const targetOf = (input: unknown): string | undefined => {
    if (!input || typeof input !== 'object') return undefined;
    const record = input as Record<string, unknown>;
    for (const key of TARGET_KEYS) {
        const value = record[key];
        if (typeof value === 'string' && value.trim()) return clamp(value.trim());
    }
    return undefined;
};

const contentBlocks = (entry: Record<string, unknown>): Record<string, unknown>[] => {
    const message = entry.message;
    if (!message || typeof message !== 'object') return [];
    const content = (message as Record<string, unknown>).content;
    if (!Array.isArray(content)) return [];
    return content.filter((b): b is Record<string, unknown> => !!b && typeof b === 'object');
};

/**
 * A user entry whose content is a plain string is something the person typed.
 * One carrying an array of `tool_result` blocks is the harness answering the
 * model, and counting it as a prompt would cut every turn into fragments —
 * the same distinction `plugin/hooks/zeph-stop.sh` draws to scope a turn.
 */
const promptTextOf = (entry: Record<string, unknown>): string | null => {
    if (entry.type !== 'user' || entry.isMeta) return null;
    const message = entry.message;
    if (!message || typeof message !== 'object') return null;
    const content = (message as Record<string, unknown>).content;
    return typeof content === 'string' && content.trim() ? content : null;
};

/**
 * Turn raw JSONL lines into wire events.
 *
 * Nothing a tool read or wrote survives this function: only the tool's name, a
 * short label for what it acted on, and whether it worked. That is the whole
 * privacy story of the feature — the transcript holds file contents and command
 * output, and this is the one place that decides none of it leaves the machine.
 *
 * `sinceLastPrompt` is for the backfill window: finished turns already exist in
 * the chat as their completion pushes, so replaying them would double every
 * message. Only the turn still in flight is new information.
 */
export const projectTranscriptEntries = (
    lines: readonly string[],
    opts: { sinceLastPrompt?: boolean } = {},
): TurnEvent[] => {
    const events: TurnEvent[] = [];

    for (const raw of lines) {
        let entry: Record<string, unknown>;
        try {
            const parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== 'object') continue;
            entry = parsed as Record<string, unknown>;
        } catch {
            continue;
        }

        // A subagent's own tool calls belong to the Task/Agent call that spawned
        // it, which the parent transcript already shows as one row.
        if (entry.isSidechain) continue;

        const prompt = promptTextOf(entry);
        if (prompt !== null) {
            events.push({ kind: 'prompt', text: clamp(prompt) });
            continue;
        }

        for (const block of contentBlocks(entry)) {
            if (block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
                const target = targetOf(block.input);
                events.push({ kind: 'tool', id: block.id, name: clamp(block.name), ...(target ? { target } : {}) });
                continue;
            }
            if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
                events.push({ kind: 'tool_result', id: block.tool_use_id, ok: block.is_error !== true });
                continue;
            }
            if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
                events.push({ kind: 'text', text: clamp(block.text) });
            }
            // `thinking` falls through on purpose — the timeline shows what the
            // agent did, not what it considered.
        }
    }

    if (!opts.sinceLastPrompt) return events;

    const lastPrompt = events.map((e) => e.kind).lastIndexOf('prompt');
    return lastPrompt === -1 ? events : events.slice(lastPrompt);
};
