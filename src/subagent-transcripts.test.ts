import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';

import {
    MAX_SUBAGENT_ROWS,
    isSubagentTranscriptPath,
    SUBAGENT_LIVE_MS,
    SUBAGENT_WORKING_MS,
    initialSubagentScanState,
    scanSubagents,
    subagentDirFor,
} from './subagent-transcripts.js';

const NOW = Date.UTC(2026, 8, 13, 12, 0, 0);

const dirs: string[] = [];

/** A parent transcript plus its `subagents/` directory, as Claude Code lays them out. */
const projectFixture = (): { parentPath: string; subagentDir: string } => {
    const root = mkdtempSync(join(tmpdir(), 'zeph-subagents-'));
    dirs.push(root);
    const sessionId = '962a64bb-b1bd-4a4c-9ce5-d4bab12e1567';
    const parentPath = join(root, `${sessionId}.jsonl`);
    writeFileSync(parentPath, '');
    // Through the module's own resolver: a fixture that spells the layout out
    // again would keep passing after the scanner started looking elsewhere.
    return { parentPath, subagentDir: subagentDirFor(parentPath) };
};

/** One `agent-<id>.jsonl` aged `ageMs` before NOW, plus the sidecar that names it. */
const writeSubagentFile = (
    dir: string,
    agentId: string,
    ageMs: number,
    meta?: Record<string, string>,
): string => {
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `agent-${agentId}.jsonl`);
    writeFileSync(path, `${JSON.stringify({ type: 'assistant', agentId, isSidechain: true })}\n`);
    if (meta) writeFileSync(join(dir, `agent-${agentId}.meta.json`), JSON.stringify(meta));
    const seconds = (NOW - ageMs) / 1000;
    utimesSync(path, seconds, seconds);
    return path;
};

/** Lines a subagent writes as it works: one `at`-stamped call each. Appending
 *  moves the file's mtime to the real clock, so it is put back afterwards —
 *  every other case in this file ages files against the fixed NOW. */
const writeSubagentWork = (dir: string, agentId: string, calls: number, firstAt: string, ageMs = 1_000): void => {
    const lines = Array.from({ length: calls }, (_, i) =>
        JSON.stringify({
            type: 'assistant',
            isSidechain: true,
            timestamp: i === 0 ? firstAt : new Date(Date.parse(firstAt) + i * 1_000).toISOString(),
            message: {
                role: 'assistant',
                content: [{ type: 'tool_use', id: `toolu_${i}`, name: 'Bash', input: { description: 'work' } }],
            },
        }),
    );
    const path = join(dir, `agent-${agentId}.jsonl`);
    writeFileSync(path, `${lines.join('\n')}\n`, { flag: 'a' });
    const seconds = (NOW - ageMs) / 1000;
    utimesSync(path, seconds, seconds);
};

/** The parent's `Agent` tool call — the only proof a spawn happened at all. */
const appendLaunch = (parentPath: string): void => {
    const line = JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Agent', input: {} }] },
    });
    writeFileSync(parentPath, `${line}\n`, { flag: 'a' });
};

/** The body Claude Code wraps a background subagent's end in — measured shape,
 *  trimmed to the fields that identify it. */
const notificationText = (agentId: string, status: string): string =>
    `<task-notification>\n<task-id>${agentId}</task-id>\n<tool-use-id>toolu_x</tool-use-id>\n`
    + `<status>${status}</status>\n<summary>Agent "work" finished</summary>\n</task-notification>`;

/** A background subagent ending: the parent receives the notice as a user turn. */
const appendTaskNotification = (parentPath: string, agentId: string, status: string, atMs: number): void => {
    const line = JSON.stringify({
        type: 'user',
        timestamp: new Date(atMs).toISOString(),
        origin: { kind: 'task-notification' },
        message: { role: 'user', content: notificationText(agentId, status) },
    });
    writeFileSync(parentPath, `${line}\n`, { flag: 'a' });
};

/** A foreground subagent ending: its `Agent` call returns, carrying the agent id. */
const appendForegroundResult = (parentPath: string, agentId: string, atMs: number): void => {
    const line = JSON.stringify({
        type: 'user',
        timestamp: new Date(atMs).toISOString(),
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'done' }] },
        toolUseResult: { status: 'completed', agentId, totalToolUseCount: 3 },
    });
    writeFileSync(parentPath, `${line}\n`, { flag: 'a' });
};

afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('isSubagentTranscriptPath', () => {
    it('tells a subagent transcript from the parent it sits under', () => {
        const { parentPath, subagentDir } = projectFixture();

        expect(isSubagentTranscriptPath(join(subagentDir, 'agent-x.jsonl'))).toBe(true);
        expect(isSubagentTranscriptPath(parentPath)).toBe(false);
    });
});

describe('scanSubagents', () => {
    it('reports a live subagent as a view-only row named after its parent', () => {
        const { parentPath, subagentDir } = projectFixture();
        writeSubagentFile(subagentDir, 'a1b2c3', 1_000, {
            agentType: 'cavecrew-investigator',
            description: 'Describe screenshot',
        });
        appendLaunch(parentPath);

        const rows = scanSubagents('zeph-zeph-to', parentPath, initialSubagentScanState(), { now: NOW });

        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
            name: 'zeph-zeph-to.1',
            agentId: 'a1b2c3',
            label: 'Describe screenshot',
            working: true,
        });
        expect(rows[0]!.transcriptPath).toContain('agent-a1b2c3.jsonl');
    });

    it('names a subagent by its type when the sidecar carries no description', () => {
        const { parentPath, subagentDir } = projectFixture();
        writeSubagentFile(subagentDir, 'typed', 1_000, { agentType: 'reviewer' });

        const rows = scanSubagents('zeph-x', parentPath, initialSubagentScanState(), { now: NOW });

        expect(rows[0]!.label).toBe('reviewer');
    });

    it('falls back to a positional label when there is no sidecar at all', () => {
        const { parentPath, subagentDir } = projectFixture();
        writeSubagentFile(subagentDir, 'nameless', 1_000);

        const rows = scanSubagents('zeph-x', parentPath, initialSubagentScanState(), { now: NOW });

        expect(rows[0]!.label).toBe('Agent 1');
    });

    it('picks up a sidecar that lands after the subagent was first seen', () => {
        const { parentPath, subagentDir } = projectFixture();
        writeSubagentFile(subagentDir, 'late', 1_000);
        const state = initialSubagentScanState();

        expect(scanSubagents('zeph-x', parentPath, state, { now: NOW })[0]!.label).toBe('Agent 1');
        writeSubagentFile(subagentDir, 'late', 1_000, { description: 'Map subagent surfaces' });

        expect(scanSubagents('zeph-x', parentPath, state, { now: NOW })[0]!.label).toBe('Map subagent surfaces');
    });

    it('keeps a subagent at the number it was first given', () => {
        const { parentPath, subagentDir } = projectFixture();
        writeSubagentFile(subagentDir, 'first', 60_000);
        const state = initialSubagentScanState();

        expect(scanSubagents('zeph-x', parentPath, state, { now: NOW })[0]!.name).toBe('zeph-x.1');

        // A second subagent starts later and is written more recently, so a
        // by-mtime numbering would renumber the first one.
        writeSubagentFile(subagentDir, 'second', 1_000);
        const rows = scanSubagents('zeph-x', parentPath, state, { now: NOW });

        expect(rows.map((r) => `${r.agentId}:${r.name}`)).toEqual(['first:zeph-x.1', 'second:zeph-x.2']);
    });

    it('never takes a number a pane subagent of the same session already owns', () => {
        const { parentPath, subagentDir } = projectFixture();
        writeSubagentFile(subagentDir, 'inprocess', 1_000);

        const rows = scanSubagents('zeph-x', parentPath, initialSubagentScanState(), {
            now: NOW,
            reserved: new Set([1, 2]),
        });

        expect(rows[0]!.name).toBe('zeph-x.3');
    });

    it('drops subagents whose transcripts went quiet long ago', () => {
        const { parentPath, subagentDir } = projectFixture();
        writeSubagentFile(subagentDir, 'ancient', 2 * 60 * 60_000);
        writeSubagentFile(subagentDir, 'recent', 1_000);

        const rows = scanSubagents('zeph-x', parentPath, initialSubagentScanState(), { now: NOW });

        expect(rows.map((r) => r.agentId)).toEqual(['recent']);
    });

    it('keeps a subagent addressable after it leaves the roster, so its reader is not cut off', () => {
        const { parentPath, subagentDir } = projectFixture();
        writeSubagentFile(subagentDir, 'thinking', SUBAGENT_LIVE_MS * 2);

        const rows = scanSubagents('zeph-x', parentPath, initialSubagentScanState(), { now: NOW });

        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ agentId: 'thinking', live: false });
    });

    it('marks a subagent idle once its transcript stops growing', () => {
        const { parentPath, subagentDir } = projectFixture();
        writeSubagentFile(subagentDir, 'paused', SUBAGENT_WORKING_MS * 2);

        const rows = scanSubagents('zeph-x', parentPath, initialSubagentScanState(), { now: NOW });

        expect(rows[0]!.working).toBe(false);
    });

    it('keeps the most recently active subagents when there are more than fit', () => {
        const { parentPath, subagentDir } = projectFixture();
        for (let i = 0; i < MAX_SUBAGENT_ROWS + 3; i++) writeSubagentFile(subagentDir, `agent${i}`, (i + 1) * 1_000);

        const rows = scanSubagents('zeph-x', parentPath, initialSubagentScanState(), { now: NOW });

        const roster = rows.filter((r) => r.live);

        expect(roster).toHaveLength(MAX_SUBAGENT_ROWS);
        expect(roster.map((r) => r.agentId)).not.toContain(`agent${MAX_SUBAGENT_ROWS + 2}`);
    });

    it('gives up a number that a pane subagent takes over later', () => {
        const { parentPath, subagentDir } = projectFixture();
        writeSubagentFile(subagentDir, 'inprocess', 1_000);
        const state = initialSubagentScanState();

        expect(scanSubagents('zeph-x', parentPath, state, { now: NOW })[0]!.name).toBe('zeph-x.1');

        // A pi pane split off after the fact: its pane id decides its name, so
        // this row is the one that has to move.
        const rows = scanSubagents('zeph-x', parentPath, state, { now: NOW, reserved: new Set([1]) });

        expect(rows[0]!.name).toBe('zeph-x.2');
    });

    it('says once when the parent launched a subagent but no transcript directory exists', () => {
        // Claude Code owns that directory's layout. If it moves, this scanner
        // finds nothing and the feature disappears without an error — so the
        // one state that proves the layout changed gets said out loud.
        const { parentPath } = projectFixture();
        appendLaunch(parentPath);
        const state = initialSubagentScanState();
        const logged: string[] = [];
        const opts = { now: NOW, log: (m: string) => logged.push(m) };

        expect(scanSubagents('zeph-x', parentPath, state, opts)).toEqual([]);
        expect(scanSubagents('zeph-x', parentPath, state, opts)).toEqual([]);

        expect(logged).toHaveLength(1);
        expect(logged[0]).toContain('subagents');
    });

    it('does not read a quoted tool name in the transcript as a launch', () => {
        const { parentPath } = projectFixture();
        writeFileSync(
            parentPath,
            `${JSON.stringify({
                type: 'assistant',
                message: { role: 'assistant', content: [{ type: 'text', text: 'the line reads "name":"Agent" here' }] },
            })}\n`,
        );
        const logged: string[] = [];

        scanSubagents('zeph-x', parentPath, initialSubagentScanState(), { now: NOW, log: (m) => logged.push(m) });

        expect(logged).toEqual([]);
    });

    // What the phone shows beside a subagent's name: a session that is quiet
    // because its subagent is thinking looks the same as one that is stuck,
    // until the count moves.
    it('counts the calls a subagent has made, and when it started', () => {
        const { parentPath, subagentDir } = projectFixture();
        writeSubagentFile(subagentDir, 'busy', 1_000);
        writeSubagentWork(subagentDir, 'busy', 3, '2026-09-13T12:00:00.000Z');

        const rows = scanSubagents('zeph-x', parentPath, initialSubagentScanState(), { now: NOW });

        expect(rows[0]).toMatchObject({ toolCount: 3, startedAt: '2026-09-13T12:00:00.000Z' });
    });

    it('keeps counting across sweeps instead of re-reading the file', () => {
        const { parentPath, subagentDir } = projectFixture();
        writeSubagentFile(subagentDir, 'busy', 1_000);
        writeSubagentWork(subagentDir, 'busy', 2, '2026-09-13T12:00:00.000Z');
        const state = initialSubagentScanState();

        expect(scanSubagents('zeph-x', parentPath, state, { now: NOW })[0]!.toolCount).toBe(2);
        writeSubagentWork(subagentDir, 'busy', 2, '2026-09-13T12:00:10.000Z');

        // The second sweep reads only what was appended — the count is carried,
        // not recomputed, which is what keeps a megabyte transcript cheap.
        expect(scanSubagents('zeph-x', parentPath, state, { now: NOW })[0]!.toolCount).toBe(4);
        expect(scanSubagents('zeph-x', parentPath, state, { now: NOW })[0]!.startedAt).toBe(
            '2026-09-13T12:00:00.000Z',
        );
    });

    it('says nothing about work it cannot see', () => {
        const { parentPath, subagentDir } = projectFixture();
        // A subagent whose transcript holds no stamped call yet: the file is
        // there, the work is not — a zero would read as "did nothing".
        writeSubagentFile(subagentDir, 'fresh', 1_000);

        const rows = scanSubagents('zeph-x', parentPath, initialSubagentScanState(), { now: NOW });

        expect(rows[0]!.toolCount).toBe(0);
        expect(rows[0]!.startedAt).toBeNull();
    });

    // A finished subagent's transcript simply stops growing, which is also what
    // a thinking one looks like. The parent is told when it ends, in one of two
    // shapes, and that is what takes it off the roster — not five quiet minutes.
    describe('ends a subagent when the parent is told it finished', () => {
        it('on a background task notification', () => {
            const { parentPath, subagentDir } = projectFixture();
            writeSubagentFile(subagentDir, 'bg', 10_000);
            appendLaunch(parentPath);
            appendTaskNotification(parentPath, 'bg', 'completed', NOW - 5_000);

            const rows = scanSubagents('zeph-x', parentPath, initialSubagentScanState(), { now: NOW });

            // Off the roster, still addressable: a viewer reading it keeps reading.
            expect(rows).toHaveLength(1);
            expect(rows[0]).toMatchObject({ agentId: 'bg', live: false, working: false });
        });

        it('on every way a background subagent can stop, not only success', () => {
            const { parentPath, subagentDir } = projectFixture();
            for (const status of ['failed', 'killed', 'stopped']) {
                writeSubagentFile(subagentDir, status, 10_000);
                appendTaskNotification(parentPath, status, status, NOW - 5_000);
            }

            const rows = scanSubagents('zeph-x', parentPath, initialSubagentScanState(), { now: NOW });

            expect(rows.map((r) => r.live)).toEqual([false, false, false]);
        });

        it('on a foreground call returning its result', () => {
            const { parentPath, subagentDir } = projectFixture();
            writeSubagentFile(subagentDir, 'fg', 10_000);
            appendForegroundResult(parentPath, 'fg', NOW - 5_000);

            const rows = scanSubagents('zeph-x', parentPath, initialSubagentScanState(), { now: NOW });

            expect(rows[0]).toMatchObject({ agentId: 'fg', live: false });
        });

        it('finds out on a later sweep, after the parent had already been read', () => {
            const { parentPath, subagentDir } = projectFixture();
            writeSubagentFile(subagentDir, 'bg', 10_000);
            appendLaunch(parentPath);
            const state = initialSubagentScanState();
            expect(scanSubagents('zeph-x', parentPath, state, { now: NOW })[0]!.live).toBe(true);

            appendTaskNotification(parentPath, 'bg', 'completed', NOW - 5_000);

            expect(scanSubagents('zeph-x', parentPath, state, { now: NOW })[0]!.live).toBe(false);
        });

        // SendMessage resumes a finished subagent into the same transcript. A
        // write after the notice is new work, and the notice no longer describes it.
        it('brings a subagent back when it writes again after the notice', () => {
            const { parentPath, subagentDir } = projectFixture();
            writeSubagentFile(subagentDir, 'bg', 1_000);
            appendTaskNotification(parentPath, 'bg', 'completed', NOW - 5_000);

            const rows = scanSubagents('zeph-x', parentPath, initialSubagentScanState(), { now: NOW });

            expect(rows[0]).toMatchObject({ agentId: 'bg', live: true, working: true });
        });

        // The subagent's last write can land a few milliseconds after the parent
        // records its end — measured on real transcripts, the final flush trails.
        it('still ends a subagent whose last write trails the notice by a moment', () => {
            const { parentPath, subagentDir } = projectFixture();
            writeSubagentFile(subagentDir, 'bg', 10_000);
            appendTaskNotification(parentPath, 'bg', 'completed', NOW - 10_000 - 40);

            const rows = scanSubagents('zeph-x', parentPath, initialSubagentScanState(), { now: NOW });

            expect(rows[0]!.live).toBe(false);
        });

        it('does not read a notice that is only quoted as one', () => {
            const { parentPath, subagentDir } = projectFixture();
            writeSubagentFile(subagentDir, 'bg', 10_000);
            // The parent's own reply repeating the notice text, as this very
            // conversation does when it reports a subagent finishing.
            const quoted = JSON.stringify({
                type: 'assistant',
                timestamp: new Date(NOW - 5_000).toISOString(),
                message: { role: 'assistant', content: [{ type: 'text', text: notificationText('bg', 'completed') }] },
            });
            writeFileSync(parentPath, `${quoted}\n`, { flag: 'a' });

            const rows = scanSubagents('zeph-x', parentPath, initialSubagentScanState(), { now: NOW });

            expect(rows[0]!.live).toBe(true);
        });
    });

    it('stays quiet for a session that never launched a subagent', () => {
        const { parentPath } = projectFixture();
        const logged: string[] = [];

        const rows = scanSubagents('zeph-x', parentPath, initialSubagentScanState(), {
            now: NOW,
            log: (m) => logged.push(m),
        });

        expect(rows).toEqual([]);
        expect(logged).toEqual([]);
    });
});
