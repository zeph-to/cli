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

/** The parent's `Agent` tool call — the only proof a spawn happened at all. */
const appendLaunch = (parentPath: string): void => {
    const line = JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Agent', input: {} }] },
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
