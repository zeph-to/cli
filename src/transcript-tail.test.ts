import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
    initialTailState,
    readTranscriptDelta,
    projectTranscriptEntries,
    MAX_TRANSCRIPT_LINE_CHARS,
    MAX_TAIL_BYTES_PER_TICK,
    TRANSCRIPT_BACKFILL_BYTES,
    MAX_EVENT_FIELD_CHARS,
} from './transcript-tail.js';

let dir: string;
let file: string;

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'zeph-tail-'));
    file = join(dir, 'session.jsonl');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** One JSONL line, newline included. */
const line = (obj: unknown): string => `${JSON.stringify(obj)}\n`;

const userLine = (text: string) => line({ type: 'user', message: { role: 'user', content: text } });

const toolUseLine = (id: string, name: string, input: Record<string, unknown>) =>
    line({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
    });

const toolResultLine = (id: string, isError?: boolean) =>
    line({
        type: 'user',
        message: {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: id, content: 'ok', ...(isError === undefined ? {} : { is_error: isError }) }],
        },
    });

const textLine = (text: string) =>
    line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });

// ── readTranscriptDelta ──────────────────────────────────────────────────────

describe('readTranscriptDelta', () => {
    it('backfills from the end of a large file, never from byte 0', () => {
        // A file far larger than the backfill window. Reading from 0 is the P0 this guards.
        const filler = line({ type: 'system', pad: 'x'.repeat(4096) });
        const repeats = Math.ceil((TRANSCRIPT_BACKFILL_BYTES * 2) / filler.length);
        writeFileSync(file, filler.repeat(repeats) + userLine('hello'));

        const read = readTranscriptDelta(file, initialTailState());

        expect(read).not.toBeNull();
        expect(read!.bytesRead).toBeLessThanOrEqual(TRANSCRIPT_BACKFILL_BYTES);
        // The window lands mid-line; that partial first line must not reach the parser.
        expect(read!.lines.every((l) => l.startsWith('{'))).toBe(true);
        expect(read!.lines.at(-1)).toContain('hello');
    });

    it('reads a small file whole, keeping the very first line', () => {
        writeFileSync(file, userLine('first') + textLine('second'));

        const read = readTranscriptDelta(file, initialTailState());

        expect(read!.lines).toHaveLength(2);
        expect(read!.lines[0]).toContain('first');
    });

    it('returns null when neither size nor mtime moved — no read, no allocation', () => {
        writeFileSync(file, userLine('hello'));
        const first = readTranscriptDelta(file, initialTailState())!;

        expect(readTranscriptDelta(file, first.state)).toBeNull();
    });

    it('carries a partial trailing line into the next read', () => {
        writeFileSync(file, userLine('done'));
        const first = readTranscriptDelta(file, initialTailState())!;

        appendFileSync(file, '{"type":"assis');
        const second = readTranscriptDelta(file, first.state)!;
        expect(second.lines).toHaveLength(0);

        appendFileSync(file, 'tant","message":{"role":"assistant","content":[]}}\n');
        const third = readTranscriptDelta(file, second.state)!;
        expect(third.lines).toHaveLength(1);
        expect(third.lines[0]).toContain('assistant');
    });

    it('drops a line past MAX_TRANSCRIPT_LINE_CHARS and resyncs at the next newline', () => {
        writeFileSync(file, userLine('before'));
        const first = readTranscriptDelta(file, initialTailState())!;

        // A single tool_result can really be ~1MB — measured 915,292 bytes in a live transcript.
        appendFileSync(file, line({ type: 'user', huge: 'x'.repeat(MAX_TRANSCRIPT_LINE_CHARS + 1024) }));
        appendFileSync(file, textLine('after'));

        const rest: string[] = [];
        let state = first.state;
        let dropped = 0;
        // The oversized line spans several ticks; drain until the file is caught up.
        for (let i = 0; i < 40; i++) {
            const read = readTranscriptDelta(file, state);
            if (!read) break;
            rest.push(...read.lines);
            dropped += read.droppedLines;
            state = read.state;
        }

        expect(dropped).toBe(1);
        expect(rest).toHaveLength(1);
        expect(rest[0]).toContain('after');
    });

    it('never reads more than MAX_TAIL_BYTES_PER_TICK in one tick', () => {
        writeFileSync(file, userLine('seed'));
        const first = readTranscriptDelta(file, initialTailState())!;

        const chunk = textLine('y'.repeat(2048));
        appendFileSync(file, chunk.repeat(Math.ceil((MAX_TAIL_BYTES_PER_TICK * 2) / chunk.length)));

        const second = readTranscriptDelta(file, first.state)!;
        expect(second.bytesRead).toBeLessThanOrEqual(MAX_TAIL_BYTES_PER_TICK);

        // The remainder is not lost — the next tick continues where this one stopped.
        const third = readTranscriptDelta(file, second.state)!;
        expect(third.lines.length).toBeGreaterThan(0);
    });

    it('restarts from the top when the file was truncated or replaced', () => {
        writeFileSync(file, userLine('old') + textLine('older'));
        const first = readTranscriptDelta(file, initialTailState())!;

        writeFileSync(file, userLine('fresh'));
        const second = readTranscriptDelta(file, first.state)!;

        expect(second.lines).toHaveLength(1);
        expect(second.lines[0]).toContain('fresh');
    });

    it('does not corrupt a multi-byte character split across a tick boundary', () => {
        writeFileSync(file, userLine('seed'));
        const first = readTranscriptDelta(file, initialTailState())!;

        // Korean text makes every character 3 bytes, so a read capped mid-string
        // lands inside one with high probability.
        const chunk = textLine('한'.repeat(700));
        appendFileSync(file, chunk.repeat(Math.ceil((MAX_TAIL_BYTES_PER_TICK * 2) / chunk.length)));

        const collected: string[] = [];
        let state = first.state;
        for (let i = 0; i < 40; i++) {
            const read = readTranscriptDelta(file, state);
            if (!read) break;
            collected.push(...read.lines);
            state = read.state;
        }

        expect(collected.length).toBeGreaterThan(1);
        expect(collected.join('')).not.toContain('\uFFFD');
        // Every line must still be parseable — a split character would break JSON.
        for (const l of collected) expect(() => JSON.parse(l)).not.toThrow();
    });

    it('reports a missing file as null rather than throwing', () => {
        expect(readTranscriptDelta(join(dir, 'gone.jsonl'), initialTailState())).toBeNull();
    });
});

// ── projectTranscriptEntries ─────────────────────────────────────────────────

describe('projectTranscriptEntries', () => {
    it('projects a tool call to name + target, and its result to ok', () => {
        const events = projectTranscriptEntries([
            toolUseLine('t1', 'Read', { file_path: '/tmp/a.ts' }),
            toolResultLine('t1'),
        ]);

        expect(events).toEqual([
            { kind: 'tool', id: 't1', name: 'Read', target: '/tmp/a.ts' },
            { kind: 'tool_result', id: 't1', ok: true },
        ]);
    });

    it('marks a failed tool result', () => {
        const events = projectTranscriptEntries([toolResultLine('t9', true)]);
        expect(events).toEqual([{ kind: 'tool_result', id: 't9', ok: false }]);
    });

    it('prefers a Bash description over the raw command as the target', () => {
        const events = projectTranscriptEntries([
            toolUseLine('t2', 'Bash', { command: 'rm -rf /tmp/x', description: 'Remove scratch dir' }),
        ]);

        expect(events[0]).toMatchObject({ name: 'Bash', target: 'Remove scratch dir' });
    });

    it('never carries tool_result bodies or tool inputs onto the wire', () => {
        const secret = 'SECRET-FILE-CONTENT';
        const events = projectTranscriptEntries([
            toolUseLine('t3', 'Write', { file_path: '/tmp/b.ts', content: secret }),
            line({
                type: 'user',
                message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't3', content: secret }] },
            }),
        ]);

        expect(JSON.stringify(events)).not.toContain(secret);
    });

    it('truncates long fields to MAX_EVENT_FIELD_CHARS', () => {
        const events = projectTranscriptEntries([
            toolUseLine('t4', 'Read', { file_path: '/'.repeat(MAX_EVENT_FIELD_CHARS + 500) }),
            textLine('z'.repeat(MAX_EVENT_FIELD_CHARS + 500)),
        ]);

        for (const e of events) {
            for (const value of Object.values(e)) {
                if (typeof value === 'string') expect(value.length).toBeLessThanOrEqual(MAX_EVENT_FIELD_CHARS);
            }
        }
    });

    it('treats a real user prompt as a prompt but a tool_result carrier as not one', () => {
        const events = projectTranscriptEntries([userLine('do the thing'), toolResultLine('t5')]);

        expect(events[0]).toEqual({ kind: 'prompt', text: 'do the thing' });
        expect(events[1]!.kind).toBe('tool_result');
    });

    it('keeps only the in-flight turn when backfilling, so finished turns stay the pushes they already are', () => {
        const events = projectTranscriptEntries(
            [
                userLine('old turn'),
                toolUseLine('t6', 'Read', { file_path: '/old.ts' }),
                textLine('old answer'),
                userLine('current turn'),
                toolUseLine('t7', 'Read', { file_path: '/new.ts' }),
            ],
            { sinceLastPrompt: true },
        );

        expect(events.map((e) => e.kind)).toEqual(['prompt', 'tool']);
        expect(JSON.stringify(events)).not.toContain('/old.ts');
        expect(JSON.stringify(events)).toContain('/new.ts');
    });

    it('skips sidechain entries — a subagent shows up as its own Agent tool call, not as its internals', () => {
        const events = projectTranscriptEntries([
            line({
                type: 'assistant',
                isSidechain: true,
                message: { role: 'assistant', content: [{ type: 'tool_use', id: 's1', name: 'Grep', input: {} }] },
            }),
            toolUseLine('t8', 'Agent', { description: 'find callers' }),
        ]);

        expect(events).toEqual([{ kind: 'tool', id: 't8', name: 'Agent', target: 'find callers' }]);
    });

    it('ignores unparseable and non-message lines instead of throwing', () => {
        const events = projectTranscriptEntries(['not json', line({ type: 'ai-title', aiTitle: 'x' }), textLine('ok')]);

        expect(events).toEqual([{ kind: 'text', text: 'ok' }]);
    });

    it('drops thinking blocks — they are not what the timeline shows', () => {
        const events = projectTranscriptEntries([
            line({
                type: 'assistant',
                message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'private reasoning' }] },
            }),
        ]);

        expect(events).toEqual([]);
    });
});
