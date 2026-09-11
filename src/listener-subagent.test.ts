import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

/**
 * Subagent panes as view-only wire entities (slice 02). The detection seam is
 * the ps table: `foregroundAgentFor` is mocked to answer from a fixture table
 * instead of spawning a real `ps`, so a test pane becomes "a pane whose tty's
 * foreground group runs pi" by pid arithmetic alone.
 */
const FIELD_SEP = '␟';
const TMP = mkdtempSync(join(tmpdir(), 'zeph-subagent-'));
process.env.XDG_STATE_HOME = join(TMP, 'state');

vi.mock('./remote-agents.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./remote-agents.js')>();
    let table: import('./remote-agents.js').ProcTable | null = null;
    return {
        ...actual,
        foregroundAgentFor: (pid: number) => actual.foregroundAgentFor(pid, table),
        __setProcTable: (t: import('./remote-agents.js').ProcTable | null) => {
            table = t;
        },
    };
});

interface FakePane {
    session: string;
    paneId: string;
    idx: number;
    current: string;
    start: string;
    pid: number;
    /** 12th sweep field — @zeph_pane_label, set by the subagent itself. */
    label?: string;
}

/** The subagent detection fixture, in `ps -axo pid=,ppid=,pgid=,tpgid=,lstart=,comm=` shape:
 *  - 600/601/602: login zsh → bash script → pi, fg group 900 (a pi subagent pane)
 *  - 610: a login zsh whose fg group is its own (a plain prompt — never a subagent)
 *  - 620/621: login zsh → pi in fg group 901 (a second pi subagent pane) */
const PS_TABLE = [
    '  600     1   600   900 Fri Aug  7 11:12:59 2026 zsh',
    '  601   600   900   900 Fri Aug  7 11:12:59 2026 bash',
    '  602   601   900   900 Fri Aug  7 11:12:59 2026 pi',
    '  610     1   610   610 Fri Aug  7 11:12:59 2026 zsh',
    '  620     1   620   901 Fri Aug  7 11:12:59 2026 zsh',
    '  621   620   901   901 Fri Aug  7 11:12:59 2026 pi',
].join('\n');

let panes: FakePane[] = [];

const resetPanes = (): void => {
    panes = [
        { session: 'zeph-a', paneId: '%0', idx: 0, current: 'node', start: 'claude', pid: 100 },
        // Pane index runs opposite to pane id (measured on a live pi session:
        // the newest subagent split sits at the lowest index), so ordering by
        // index would put %9 before %5.
        { session: 'zeph-a', paneId: '%5', idx: 3, current: 'bash', start: 'zsh', pid: 600 },
        { session: 'zeph-a', paneId: '%7', idx: 2, current: 'zsh', start: 'zsh', pid: 610 },
        { session: 'zeph-a', paneId: '%9', idx: 1, current: 'bash', start: 'zsh', pid: 620, label: 'Scout' },
    ];
};

let tmuxCalls: string[][] = [];

const paneByIdOrSession = (t: string): FakePane | undefined =>
    panes.find((p) => p.paneId === t) ?? panes.find((p) => p.session === t);

const fakeTmux = (args: readonly string[]) => {
    const a = args[0] === '-S' ? args.slice(2) : args;
    tmuxCalls.push([...a]);
    if (a[0] === 'list-panes') {
        const rows = panes
            .sort((x, y) => x.idx - y.idx)
            .map((p) =>
                [p.session, '0', '1700000000', '1700000000', '0', String(p.idx),
                    p.paneId, p.current, p.start, '/tmp/proj', String(p.pid), p.label ?? ''].join(FIELD_SEP));
        return { status: 0, stdout: rows.join('\n') + '\n', stderr: '' };
    }
    if (a[0] === 'list-sessions') return { status: 0, stdout: '', stderr: '' };
    if (a[0] === 'display-message') {
        const t = a[a.indexOf('-t') + 1];
        const fmt = a[a.length - 1];
        const p = paneByIdOrSession(t);
        if (!p) return { status: 1, stdout: '', stderr: "can't find pane" };
        if (fmt.includes('#{session_name}')) {
            return { status: 0, stdout: [p.current, p.session].join(FIELD_SEP), stderr: '' };
        }
        if (fmt.includes('#{pane_pid}')) {
            return { status: 0, stdout: [p.current, p.start, '/tmp/proj', String(p.pid)].join(FIELD_SEP), stderr: '' };
        }
        return { status: 1, stdout: '', stderr: '' };
    }
    if (a[0] === 'capture-pane') {
        const t = a[a.indexOf('-t') + 1];
        return panes.some((p) => p.paneId === t)
            ? { status: 0, stdout: 'pane text\n', stderr: '' }
            : { status: 1, stdout: '', stderr: "can't find pane" };
    }
    if (a[0] === 'has-session') {
        const t = a[a.indexOf('-t') + 1];
        return panes.some((p) => p.session === t)
            ? { status: 0, stdout: '', stderr: '' }
            : { status: 1, stdout: '', stderr: '' };
    }
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
const remoteAgents = (await import('./remote-agents.js')) as typeof import('./remote-agents.js') & {
    __setProcTable: (t: import('./remote-agents.js').ProcTable | null) => void;
};

const WRITES = new Set(['send-keys', 'set-buffer', 'paste-buffer', 'kill-session']);

/** tmux calls that could mutate a pane, since the last mark. */
const writesSince = (mark: number): string[][] => tmuxCalls.slice(mark).filter((c) => WRITES.has(c[0] === '-S' ? c[2] : c[0]));
const callCount = (): number => tmuxCalls.length;

describe('subagent panes — sweep, view-only, addressing', () => {
    const device = listener.computeListenerDeviceId();

    beforeEach(() => {
        vi.spyOn(console, 'log').mockImplementation(() => {});
        resetPanes();
        remoteAgents.__setProcTable(remoteAgents.parseProcTable(PS_TABLE));
        listener.recordInventory(null);
        listener.recordTargets(null);
        tmuxCalls.length = 0;
    });
    afterEach(() => {
        listener.stopAllStreams();
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    /** One sweep, recorded the way the WS loop does it. */
    const sweep = () => {
        const result = listener.collectSessionsVerbose();
        listener.recordInventory(result.sessions);
        listener.recordTargets(result.targets);
        return result;
    };

    it('reports foreground-agent panes as subagent sessions of the parent', () => {
        const result = sweep();
        const subs = result.sessions.filter((s) => s.parentName);
        expect(subs.map((s) => s.name)).toEqual(['zeph-a.5', 'zeph-a.9']);
        expect(subs.every((s) => s.parentName === 'zeph-a')).toBe(true);
        expect(subs.every((s) => s.agentKind === 'pi')).toBe(true);
        expect(subs.every((s) => s.project === 'a')).toBe(true);
        // Fallback label numbers per kind; the labelled pane keeps its own.
        expect(subs.map((s) => s.label)).toEqual(['Pi 1', 'Scout']);
        // Addressing: each sub resolves to ITS pane, the parent to its main.
        expect(result.targets['zeph-a']).toBe('%0');
        expect(result.targets['zeph-a.5']).toBe('%5');
        expect(result.targets['zeph-a.9']).toBe('%9');
        const main = result.sessions.find((s) => s.name === 'zeph-a');
        expect(main?.parentName).toBeUndefined();
    });

    it('a pane at its login-shell prompt is never a subagent', () => {
        const result = sweep();
        expect(result.sessions.some((s) => s.name === 'zeph-a.7')).toBe(false);
    });

    it('a session whose main pane holds no agent reports no subagents either', () => {
        panes = panes.map((p) => ({ ...p, start: 'zsh' })); // no start_command anywhere
        const result = sweep();
        expect(result.sessions).toHaveLength(0);
        expect(result.rejected.map((r) => r.name)).toEqual(['zeph-a']);
        expect(Object.keys(result.targets).filter((n) => n.startsWith('zeph-a.'))).toEqual([]);
    });

    it('input to a subagent is refused view-only before any tmux spawn', async () => {
        sweep();
        const mark = callCount();
        const ok = await listener.handlePush(
            { pushId: 'p1', type: 'agent.command', agentSessionName: 'zeph-a.5', body: 'hi' },
            {},
        );
        expect(ok).toBe(false);
        expect(writesSince(mark)).toEqual([]);
        expect(callCount()).toBe(mark); // not even a probe
    });

    it('an unresolvable subagent name never reaches tmux at all', async () => {
        sweep();
        const mark = callCount();
        const ok = await listener.handlePush(
            { pushId: 'p2', type: 'agent.command', agentSessionName: 'zeph-a.99', body: 'hi' },
            {},
        );
        expect(ok).toBe(false);
        expect(callCount()).toBe(mark);
    });

    it('exit, resume and forget answer subagent_view_only outside the rate bucket', () => {
        sweep();
        const mark = callCount();
        let sent: Array<Record<string, unknown>> = [];
        expect(listener.handleSessionExitRequest(
            { subtype: 'agent.session.exit.request', requestId: 'e1', sessionName: 'zeph-a.5', targetDeviceId: device },
            (d) => sent.push(d),
        )).toBe(true);
        expect(sent[0].error).toBe('subagent_view_only');
        expect(listener.handleSessionResumeRequest(
            { subtype: 'agent.session.resume.request', requestId: 'r1', sessionName: 'zeph-a.5', targetDeviceId: device },
            (d) => sent.push(d),
        )).toBe(true);
        expect(sent[1].error).toBe('subagent_view_only');
        expect(listener.handleSessionForgetRequest(
            { subtype: 'agent.session.forget.request', requestId: 'f1', sessionName: 'zeph-a.5', targetDeviceId: device },
            (d) => sent.push(d),
        )).toBe(true);
        expect(sent[2].error).toBe('subagent_view_only');
        expect(writesSince(mark)).toEqual([]);
        expect(callCount()).toBe(mark);
    });

    it('a mapped subagent pane streams view-only', async () => {
        vi.useFakeTimers();
        sweep();
        const sent: Array<Record<string, unknown>> = [];
        const reply = listener.handleStreamControl(
            { subtype: 'agent.stream.start', targetDeviceId: device, sessionName: 'zeph-a.5' },
            (d) => sent.push(d),
        );
        expect(reply).toBe(true);
        await vi.advanceTimersByTimeAsync(listener.STREAM_INTERVAL_MS + 50);
        expect(sent.length).toBeGreaterThan(0);
        expect(sent.some((d) => (d as { sessionName?: string }).sessionName === 'zeph-a.5')).toBe(true);
        // Frames capture the SUB pane, never the parent's.
        expect(tmuxCalls.some((c) => c.includes('capture-pane') && c.includes('-t') && c[c.indexOf('-t') + 1] === '%5')).toBe(true);
    });

    it('when the parent session dies its subagents vanish with it', () => {
        sweep();
        panes = panes.filter((p) => p.session !== 'zeph-a');
        remoteAgents.__setProcTable(null);
        const result = sweep();
        expect(result.sessions).toHaveLength(0);
        expect(result.targets['zeph-a.5']).toBeUndefined();
        const mark = callCount();
        // The stale sub name now resolves to nothing: a push is a no-op.
        void listener.handlePush(
            { pushId: 'p3', type: 'agent.command', agentSessionName: 'zeph-a.5', body: 'hi' },
            {},
        );
        expect(writesSince(mark)).toEqual([]);
    });
});
