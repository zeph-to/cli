import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

// Main-pane pinning: a bare `-t <session>` resolves to whichever pane has
// FOCUS, so a split pane (pi-interactive-subagents opens one the moment it
// spawns a subagent) silently steals phone capture and phone input. Every
// tmux call must carry the pinned pane id instead, and a pane id that a tmux
// server restart handed to another session must never receive an inject.
//
// The fake models panes explicitly: `-t <paneId>` answers that pane, and a
// bare `-t <session>` would answer the FIRST pane — a naive implementation
// that kept passing session names around cannot pass the assertions below
// because the fake refuses to guess.

const FIELD_SEP = '␟';

interface FakePane {
    session: string;
    paneId: string;
    win: number;
    idx: number;
    current: string;
    start: string;
    path: string;
    pid: number;
    /** 12th sweep field: @zeph_pane_label, set by pi subagents. */
    label?: string;
}

let panes: FakePane[] = [];
/** Pane ids whose display-message answers a DIFFERENT session name — what a
 *  tmux server restart looks like: the id now lives in someone else's session. */
let staleOwner: Record<string, string> = {};
/** Pane ids display-message can no longer find (pane gone between sweeps). */
const deadIds = new Set<string>();
let tmuxCalls: string[][] = [];

const paneByIdOrSession = (t: string): FakePane | undefined =>
    panes.find((p) => p.paneId === t) ?? panes.find((p) => p.session === t);

const fakeTmux = (args: readonly string[]) => {
    const a = args[0] === '-S' ? args.slice(2) : args;
    tmuxCalls.push([...a]);
    if (a[0] === 'list-panes') {
        const rows = panes.map((p) =>
            [p.session, '0', '1700000000', '1700000000', String(p.win), String(p.idx),
                p.paneId, p.current, p.start, p.path, String(p.pid), p.label ?? ''].join(FIELD_SEP));
        return { status: 0, stdout: rows.join('\n') + '\n', stderr: '' };
    }
    // Socket discovery probes (bare `list-sessions`) and the diag dump.
    if (a[0] === 'list-sessions') return { status: 0, stdout: '', stderr: '' };
    if (a[0] === 'display-message') {
        const t = a[a.indexOf('-t') + 1];
        const fmt = a[a.length - 1];
        if (deadIds.has(t)) return { status: 1, stdout: '', stderr: "can't find pane" };
        // The inject guard's two-field probe: foreground command + owning session.
        if (fmt.includes('#{session_name}')) {
            const p = paneByIdOrSession(t);
            if (!p) return { status: 1, stdout: '', stderr: "can't find pane" };
            const owner = staleOwner[p.paneId] ?? p.session;
            return { status: 0, stdout: [p.current, owner].join(FIELD_SEP), stderr: '' };
        }
        if (fmt.includes('#{pane_pid}')) {
            const p = paneByIdOrSession(t);
            if (!p) return { status: 1, stdout: '', stderr: "can't find pane" };
            return { status: 0, stdout: [p.current, p.start, p.path, String(p.pid)].join(FIELD_SEP), stderr: '' };
        }
        return { status: 1, stdout: '', stderr: '' };
    }
    if (a[0] === 'capture-pane') {
        const t = a[a.indexOf('-t') + 1];
        // Only a PINNED pane id captures — a bare session name is exactly the
        // mis-target this file exists to catch, so it fails instead of guessing.
        return panes.some((p) => p.paneId === t)
            ? { status: 0, stdout: 'pane text\n', stderr: '' }
            : { status: 1, stdout: '', stderr: "can't find pane" };
    }
    // send-keys / set-buffer / paste-buffer / delete-buffer / has-session succeed.
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

const TMP = mkdtempSync(join(tmpdir(), 'zeph-pane-target-'));
process.env.HOME = TMP;
process.env.XDG_STATE_HOME = join(TMP, 'state');

const {
    collectSessionsVerbose,
    recordTargets,
    handleScreenRequest,
    handleStreamControl,
    handleCommandInput,
    stopAllStreams,
    computeListenerDeviceId,
} = await import('./listener.js');

const pane = (over: Partial<FakePane> & { session: string; paneId: string }): FakePane => ({
    win: 0, idx: 0, current: 'node', start: 'pi', path: '/tmp/proj', pid: 100, ...over,
});

/** Main + a second pane (what pi-interactive-subagents' `split-window -d`
 *  leaves behind: a bash→pi subagent, not an agent pane by start command). */
const twoPaneSetup = () => {
    panes = [
        pane({ session: 'zeph-a', paneId: '%1', idx: 0 }),
        pane({ session: 'zeph-a', paneId: '%2', idx: 1, current: 'bash', start: 'bash', pid: 200 }),
    ];
    const inv = collectSessionsVerbose();
    recordTargets(inv.targets);
    return inv;
};

const writes = () =>
    tmuxCalls.filter((c) => ['send-keys', 'set-buffer', 'paste-buffer', 'delete-buffer'].includes(c[0] as string));

describe('main-pane pinning (tmuxTargetFor)', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.spyOn(console, 'log').mockImplementation(() => {});
        panes = [];
        staleOwner = {};
        deadIds.clear();
        tmuxCalls = [];
    });
    afterEach(() => {
        stopAllStreams();
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('pins the lowest agent pane as the session target, not the focused one', () => {
        const inv = twoPaneSetup();
        expect(inv.sessions).toHaveLength(1);
        expect(inv.sessions[0]?.name).toBe('zeph-a');
        expect(inv.targets).toEqual({ 'zeph-a': '%1' });
    });

    it('a focused second pane redirects neither capture nor input', () => {
        const device = computeListenerDeviceId();
        twoPaneSetup();
        const sent: Array<Record<string, unknown>> = [];
        const send = (d: Record<string, unknown>) => { sent.push(d); };
        handleStreamControl(
            { subtype: 'agent.stream.start', targetDeviceId: device, sessionName: 'zeph-a', renew: true },
            send,
        );
        tmuxCalls = [];
        expect(handleCommandInput(
            { subtype: 'agent.command.input', targetDeviceId: device, sessionName: 'zeph-a', keys: ['down'], seq: 1, epoch: 100 },
            send,
        )).toBe(true);
        expect(writes().length).toBeGreaterThan(0);
        for (const w of writes()) expect(w.join(' ')).not.toContain('-t zeph-a');
        expect(writes().some((w) => w.join(' ').includes('-t %1'))).toBe(true);
        expect(sent.some((f) => f.error === 'input_rejected')).toBe(false);
        // The capture path pins the same way.
        tmuxCalls = [];
        handleScreenRequest({ subtype: 'agent.screen.request', requestId: 'r1', sessionName: 'zeph-a', targetDeviceId: device });
        const cap = tmuxCalls.find((c) => c[0] === 'capture-pane');
        expect(cap?.join(' ')).toContain('-t %1');
    });

    it('sweep cost: one list-panes + one capture for a single-pane session (baseline was list-sessions + display + capture = 3)', () => {
        panes = [pane({ session: 'zeph-a', paneId: '%1' })];
        collectSessionsVerbose();
        expect(tmuxCalls.filter((c) => c[0] === 'list-panes')).toHaveLength(1);
        const cap = tmuxCalls.filter((c) => c[0] === 'capture-pane');
        expect(cap).toHaveLength(1);
        expect(cap[0]?.join(' ')).toContain('-t %1');
    });

    it('a pane id reused by another session after a tmux restart never receives an inject', () => {
        const device = computeListenerDeviceId();
        twoPaneSetup();
        staleOwner['%1'] = 'zeph-other';
        const sent: Array<Record<string, unknown>> = [];
        const send = (d: Record<string, unknown>) => { sent.push(d); };
        handleStreamControl(
            { subtype: 'agent.stream.start', targetDeviceId: device, sessionName: 'zeph-a', renew: true },
            send,
        );
        tmuxCalls = [];
        handleCommandInput(
            { subtype: 'agent.command.input', targetDeviceId: device, sessionName: 'zeph-a', keys: ['down'], seq: 1, epoch: 100 },
            send,
        );
        expect(writes()).toEqual([]);
        expect(sent.some((f) => f.error === 'input_rejected')).toBe(true);
    });

    it('a pane id that no longer exists never receives an inject', () => {
        const device = computeListenerDeviceId();
        twoPaneSetup();
        deadIds.add('%1');
        const sent: Array<Record<string, unknown>> = [];
        const send = (d: Record<string, unknown>) => { sent.push(d); };
        handleStreamControl(
            { subtype: 'agent.stream.start', targetDeviceId: device, sessionName: 'zeph-a', renew: true },
            send,
        );
        tmuxCalls = [];
        handleCommandInput(
            { subtype: 'agent.command.input', targetDeviceId: device, sessionName: 'zeph-a', body: 'hello', seq: 2, epoch: 100 },
            send,
        );
        expect(writes()).toEqual([]);
        expect(sent.some((f) => f.error === 'input_rejected')).toBe(true);
    });

    it('a session whose panes hold no agent is rejected, named by the lowest pane', () => {
        panes = [
            pane({ session: 'zeph-a', paneId: '%1', current: 'zsh', start: 'zsh' }),
            pane({ session: 'zeph-a', paneId: '%2', idx: 1, current: 'vim', start: 'vim' }),
        ];
        const inv = collectSessionsVerbose();
        expect(inv.sessions).toEqual([]);
        expect(inv.rejected).toEqual([
            { name: 'zeph-a', reason: 'no agent in pane (start=zsh, current=zsh)' },
        ]);
        expect(inv.targets).toEqual({});
    });
});
