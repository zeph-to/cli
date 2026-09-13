import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it, beforeEach, vi } from 'vitest';

/**
 * Claude Code subagents in the sweep — the ones with no pane (slice 01).
 *
 * The fixture is a real `$HOME/.claude/projects` tree, because that layout IS
 * the thing under test: the resolver walks it to find the parent transcript and
 * the scanner walks it again for the subagent files beside it. Mocking the
 * filesystem here would only prove the mock matches this test.
 */
const FIELD_SEP = '␟';
const TMP = mkdtempSync(join(tmpdir(), 'zeph-cc-subagent-'));
process.env.HOME = TMP;
process.env.XDG_STATE_HOME = join(TMP, 'state');

const PANE_CWD = '/tmp/proj';
const SESSION_ID = '962a64bb-b1bd-4a4c-9ce5-d4bab12e1567';
const PROJECT_DIR = join(TMP, '.claude', 'projects', PANE_CWD.replace(/[/.]/g, '-'));

/** The parent transcript, plus one live subagent it says it launched. */
const writeTranscripts = (opts: { withSubagent: boolean }): void => {
    mkdirSync(PROJECT_DIR, { recursive: true });
    const subagentDir = join(PROJECT_DIR, SESSION_ID, 'subagents');
    rmSync(join(PROJECT_DIR, SESSION_ID), { recursive: true, force: true });
    const launch = JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Agent', input: {} }] },
    });
    writeFileSync(join(PROJECT_DIR, `${SESSION_ID}.jsonl`), opts.withSubagent ? `${launch}\n` : '');
    if (!opts.withSubagent) return;
    mkdirSync(subagentDir, { recursive: true });
    writeFileSync(
        join(subagentDir, 'agent-a90c3941.jsonl'),
        `${JSON.stringify({ type: 'assistant', isSidechain: true })}\n`,
    );
    writeFileSync(
        join(subagentDir, 'agent-a90c3941.meta.json'),
        JSON.stringify({ agentType: 'codebase-researcher', description: 'Map subagent surfaces' }),
    );
};

const PANE = { session: 'zeph-a', paneId: '%0', idx: 0, current: 'node', start: 'claude', pid: 100 };

const fakeTmux = (args: readonly string[]) => {
    const a = args[0] === '-S' ? args.slice(2) : args;
    if (a[0] === 'list-panes') {
        const row = [PANE.session, '0', '1700000000', '1700000000', '0', String(PANE.idx),
            PANE.paneId, PANE.current, PANE.start, PANE_CWD, String(PANE.pid), ''].join(FIELD_SEP);
        return { status: 0, stdout: `${row}\n`, stderr: '' };
    }
    if (a[0] === 'capture-pane') return { status: 0, stdout: 'pane text\n', stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
};

vi.mock('child_process', async (importOriginal) => {
    const actual = await importOriginal<typeof import('child_process')>();
    return {
        ...actual,
        spawnSync: (cmd: string, args?: readonly string[]) =>
            cmd === 'tmux' ? fakeTmux(args ?? []) : { status: 1, stdout: '', stderr: '' },
    };
});

const listener = await import('./listener.js');

describe('in-process subagents in the inventory sweep', () => {
    beforeEach(() => {
        vi.spyOn(console, 'log').mockImplementation(() => {});
        listener.recordTargets(null);
    });

    it('reports a Claude Code subagent as a view-only row of its parent', () => {
        writeTranscripts({ withSubagent: true });

        const { sessions, targets } = listener.collectSessionsVerbose();
        const subagent = sessions.find((s) => s.parentName === 'zeph-a');

        expect(subagent).toMatchObject({
            name: 'zeph-a.1',
            agentKind: 'claude',
            label: 'Map subagent surfaces',
            state: 'working',
        });
        // No pane means no tmux target, which is what keeps every write path
        // refusing this row (`tmuxTargetFor` answers null for a subagent name).
        expect(targets['zeph-a.1']).toBeUndefined();
        expect(listener.tmuxTargetFor('zeph-a.1')).toBeNull();
    });

    it('remembers where a subagent writes, so a watcher can follow it without a pane', () => {
        writeTranscripts({ withSubagent: true });

        const { subagentTranscripts } = listener.collectSessionsVerbose();
        listener.recordSubagentTranscripts(subagentTranscripts);

        expect(listener.subagentTranscriptFor('zeph-a.1')).toContain('agent-a90c3941.jsonl');
        expect(listener.subagentTranscriptFor('zeph-a.9')).toBeNull();
        // A pane subagent resolves through tmux, not through this map.
        expect(listener.subagentTranscriptFor('zeph-a')).toBeNull();
    });

    it('answers the watch seams for a subagent that has no pane', () => {
        writeTranscripts({ withSubagent: true });
        listener.recordSubagentTranscripts(listener.collectSessionsVerbose().subagentTranscripts);

        // Both are what turn-watch asks every tick. tmux cannot answer either
        // for `zeph-a.1` — it reads the `.1` as a pane index of `zeph-a`.
        expect(listener.hasSession('zeph-a.1')).toBe(true);
        expect(listener.resolveWatchTranscript('zeph-a.1')).toContain('subagents/agent-a90c3941.jsonl');
        expect(listener.hasSession('zeph-a.9')).toBe(false);
    });

    it('holds a subagent watch to its own transcript, never the parent it came from', () => {
        writeTranscripts({ withSubagent: true });
        listener.recordSubagentTranscripts(listener.collectSessionsVerbose().subagentTranscripts);

        // The re-resolve that follows a parent's `/clear` runs through the same
        // call: if it ever answered with the parent file, a viewer would be
        // reading the main session's work under the subagent's name.
        const first = listener.resolveWatchTranscript('zeph-a.1');
        expect(listener.resolveWatchTranscript('zeph-a.1')).toBe(first);
        expect(first).not.toContain(`${SESSION_ID}.jsonl`);
    });

    it('forgets a subagent that left the last sweep', () => {
        writeTranscripts({ withSubagent: true });
        listener.recordSubagentTranscripts(listener.collectSessionsVerbose().subagentTranscripts);

        writeTranscripts({ withSubagent: false });
        listener.recordSubagentTranscripts(listener.collectSessionsVerbose().subagentTranscripts);

        expect(listener.subagentTranscriptFor('zeph-a.1')).toBeNull();
    });

    it('reports only the parent when the session has launched no subagent', () => {
        writeTranscripts({ withSubagent: false });

        const { sessions } = listener.collectSessionsVerbose();

        expect(sessions.map((s) => s.name)).toEqual(['zeph-a']);
    });
});
