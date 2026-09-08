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

/**
 * Ceiling on a tool's label — its name, and the short string saying what it
 * acted on. A path or a one-line description; anything longer is a runaway
 * input, not a label.
 */
export const MAX_EVENT_FIELD_CHARS = 512;

/**
 * Ceiling on prose — what the agent wrote, and what the person asked.
 *
 * Deliberately far above the label cap: 512 characters is a filename, and
 * applying it here cut every reply off mid-sentence. 5000 is what the
 * completion push already carries for the same text (`zeph-stop.sh`), so the
 * live lane and the push that replaces it agree on how much of a reply is
 * worth sending.
 */
export const MAX_EVENT_TEXT_CHARS = 5000;

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
    /** Which file this offset belongs to. A new inode is a new file at the same path. */
    readonly ino: number;
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

    const { size, mtimeMs, ino } = stat;

    // Caught up AND untouched. `offset >= size` matters on its own: a tick that
    // stopped at MAX_TAIL_BYTES_PER_TICK leaves bytes behind on a file that has
    // not changed since, and skipping there would strand them until the next
    // append. `ino` matters here too, not only below: a replacement that matched
    // the old size and mtime would otherwise skip out before the rotation check
    // downstream ever ran.
    if (prev && prev.offset >= size && size === prev.size && mtimeMs === prev.mtimeMs && ino === prev.ino) {
        return null;
    }

    // A new inode at the same path is a different file, and a file that shrank
    // below the offset was truncated in place. Size alone misses the first case:
    // a replacement that happens to be longer than the old read position reads as
    // an ordinary append, and the offset then points into the middle of a record
    // that was never there.
    //
    // Neither covers a `/clear`, which writes a file under a *different* name —
    // the old one simply stops growing. Following that means re-resolving the
    // session id, which is the caller's job (`turn-watch` re-resolves on a
    // cadence) because only it knows which session this path was for.
    //
    // Either way — first attach or rotation — everything remembered about the old
    // contents is meaningless, so the read restarts from a window off the end.
    const restart = !prev || size < prev.offset || ino !== prev.ino;

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
            state: { offset: start, size, mtimeMs, ino, carry, resyncing },
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
        state: { offset: start + usable, size, mtimeMs, ino, carry: pending, resyncing },
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
 * wins: `description` leads because it is the sentence a human wrote about the
 * call, which is exactly what a collapsed timeline row wants.
 *
 * `command` is deliberately absent. It would only ever be reached for a Bash
 * call with no `description`, and measured over the 60 most recent transcripts
 * that is 0 of 2985 calls — while a command line is the single field here most
 * likely to carry a secret (an `Authorization` header, a token in a URL, a
 * profile name). Zero measured value against the worst downside on the list.
 *
 * This list is Claude Code's vocabulary. Another agent names its inputs
 * differently, so a second agent means a second projector, not a longer list —
 * see the note on `projectTranscriptEntries`.
 */
const TARGET_KEYS = ['description', 'file_path', 'path', 'pattern', 'query', 'url', 'skill'] as const;

const clamp = (value: string, max = MAX_EVENT_FIELD_CHARS): string =>
    value.length > max ? value.slice(0, max) : value;

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
/**
 * Harness plumbing that Claude Code writes into the conversation as if a person
 * had said it: background-task notifications, injected reminders, the caveat
 * wrapper around a slash command's own output.
 *
 * Dropping these is not cosmetic. A `<task-notification>` rendered as a prompt
 * bubble puts internal ids, tool-use ids and whatever a tool reported on a
 * phone screen, attributed to the user — and there is no bound on what a future
 * notification carries.
 */
const SYNTHETIC_BLOCKS = /<(task-notification|system-reminder|local-command-caveat|local-command-stdout|command-message|command-name|command-args)>[\s\S]*?<\/\1>/g;

/** `<command-name>/simplify</command-name>` — the one wrapper worth keeping, as what it names. */
const COMMAND_NAME = /<command-name>([^<]*)<\/command-name>/;

/**
 * Whether this entry is a person speaking.
 *
 * `origin.kind` is the honest answer where Claude Code writes it: `human` for
 * both a typed message and a slash command, something else for everything the
 * harness injects. Absent — an older version — it falls through to the tag
 * check below, so a build that does not stamp provenance still cannot leak a
 * notification it happens to phrase as a user turn.
 */
const isHumanTurn = (entry: Record<string, unknown>): boolean => {
    if (entry.promptSource === 'system') return false;
    const origin = entry.origin;
    if (origin && typeof origin === 'object') {
        const kind = (origin as Record<string, unknown>).kind;
        if (typeof kind === 'string') return kind === 'human';
    }
    return true;
};

const promptTextOf = (entry: Record<string, unknown>): string | null => {
    if (entry.type !== 'user' || entry.isMeta) return null;
    if (!isHumanTurn(entry)) return null;
    const message = entry.message;
    if (!message || typeof message !== 'object') return null;
    const content = (message as Record<string, unknown>).content;
    if (typeof content === 'string') return nonEmpty(stripAttachmentMarkers(content));
    // An array is usually the harness answering the model, but the same shape
    // carries what a person typed when they attached something — the prompt
    // arrives as text blocks beside the attachment. Take those; a message with
    // no text block at all is a pure tool_result carrier and not a prompt.
    if (!Array.isArray(content)) return null;
    const text = content
        .filter((b): b is Record<string, unknown> => !!b && typeof b === 'object' && b.type === 'text')
        .map((b) => (typeof b.text === 'string' ? b.text : ''))
        .join('\n')
        .trim();
    return text ? nonEmpty(stripAttachmentMarkers(text)) : null;
};

/**
 * Drop the `[Image: source: /abs/path]` markers Claude Code substitutes for an
 * attached image.
 *
 * They are a local filesystem path and nothing else: useless on the phone, which
 * cannot open it, and a directory listing of this machine if it goes anywhere
 * else. The attachment itself is not on this wire — showing that one exists is a
 * separate feature, not a reason to ship the path.
 */
const stripAttachmentMarkers = (text: string): string => {
    const command = text.match(COMMAND_NAME)?.[1]?.trim();
    const body = text.replace(SYNTHETIC_BLOCKS, '');
    // A slash command is a person's turn, and its name is the whole of what they
    // said — the wrapper around it is not.
    const withCommand = command ? `${command}\n${body}` : body;
    return withCommand.replace(/\[Image:[^\]]*\]/g, '').replace(/\n{3,}/g, '\n\n');
};

/** Trimmed, or null when nothing survived — a message that was only an attachment. */
const nonEmpty = (text: string): string | null => {
    const trimmed = text.trim();
    return trimmed ? trimmed : null;
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
 *
 * The prompt a person typed IS carried, unlike anything a tool read or wrote.
 * It is their own words, it is the same class of content the completion push
 * already sends, and without it the timeline is a list of tool names with no
 * record of what was asked.
 *
 * Everything here — the block shapes, the entry types, `TARGET_KEYS` — is Claude
 * Code's transcript format. Supporting another agent (pi, Codex) means a
 * projector of its own alongside this one, reached the way `REMOTE_AGENTS`
 * already reaches per-agent session resolvers; `turn-watch` takes the reader as
 * a dependency and needs no change for it.
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
            events.push({ kind: 'prompt', text: clamp(prompt, MAX_EVENT_TEXT_CHARS) });
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
            // Prose, only from the model. A user entry reaching here has already
            // been offered to `promptTextOf`; treating its text blocks as
            // assistant output is how an attachment marker ends up rendered as
            // the agent's own words.
            if (
                entry.type === 'assistant' &&
                block.type === 'text' &&
                typeof block.text === 'string' &&
                block.text.trim()
            ) {
                events.push({ kind: 'text', text: clamp(block.text, MAX_EVENT_TEXT_CHARS) });
            }
            // `thinking` falls through on purpose — the timeline shows what the
            // agent did, not what it considered.
        }
    }

    if (!opts.sinceLastPrompt) return events;

    const lastPrompt = events.map((e) => e.kind).lastIndexOf('prompt');
    return lastPrompt === -1 ? events : events.slice(lastPrompt);
};
