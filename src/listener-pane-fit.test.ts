import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

// A detached window a phone starts watching is sized to the phone, and gets
// its width back when the phone leaves. tmux is faked: the window's width and
// attached-client count are the only state the contract turns on.
const FIELD_SEP = '␟';
const SESSION = 'zeph-a';
const win = { attached: 0, width: 120 };
const tmuxCalls: string[][] = [];

const fakeTmux = (args: readonly string[]) => {
    const a = args[0] === '-S' ? args.slice(2) : [...args];
    tmuxCalls.push(a);
    if (a[0] === 'list-panes') {
        const row = [SESSION, String(win.attached), '1700000000', '1700000000', '0', '0', '%0', 'node', 'claude', '/tmp/proj', '1234', '', '', '', ''];
        return { status: 0, stdout: row.join(FIELD_SEP) + '\n', stderr: '' };
    }
    if (a[0] === 'display-message') {
        const format = a[a.length - 1];
        if (format.includes('#{window_width}')) {
            return { status: 0, stdout: [win.attached, 1, win.width].join(FIELD_SEP), stderr: '' };
        }
        if (format.includes('#{session_name}')) return { status: 0, stdout: ['node', SESSION, ''].join(FIELD_SEP), stderr: '' };
        return { status: 0, stdout: ['node', 'claude', '/tmp/proj', '1234', ''].join(FIELD_SEP), stderr: '' };
    }
    if (a[0] === 'resize-window') {
        win.width = Number(a[a.indexOf('-x') + 1]);
        return { status: 0, stdout: '', stderr: '' };
    }
    if (a[0] === 'capture-pane') return { status: 0, stdout: 'idle pane\n', stderr: '' };
    if (a[0] === 'set-option' || a[0] === 'list-sessions') return { status: 0, stdout: '', stderr: '' };
    return { status: 1, stdout: '', stderr: '' };
};

vi.mock('child_process', async (importOriginal) => {
    const actual = await importOriginal<typeof import('child_process')>();
    return {
        ...actual,
        spawnSync: (cmd: string, args?: readonly string[]) =>
            cmd === 'tmux' ? fakeTmux(args ?? []) : { status: 1, stdout: '', stderr: '' },
    };
});

const { handleStreamControl, stopAllStreams, computeListenerDeviceId } = await import('./listener.js');

describe('stream — a watched detached window fits the phone', () => {
    const device = computeListenerDeviceId();
    const control = (subtype: string, extra: Record<string, unknown> = {}) =>
        handleStreamControl({ subtype, targetDeviceId: device, sessionName: SESSION, renew: true, ...extra }, () => {});
    const resizes = () => tmuxCalls.filter((c) => c[0] === 'resize-window').map((c) => c[c.indexOf('-x') + 1]);

    beforeEach(() => {
        vi.useFakeTimers();
        vi.spyOn(console, 'log').mockImplementation(() => {});
        win.attached = 0;
        win.width = 120;
        tmuxCalls.length = 0;
    });
    afterEach(() => {
        stopAllStreams();
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('sizes the window to the phone on start and gives the width back on stop', () => {
        control('agent.stream.start', { cols: 45 });
        expect(win.width).toBe(45);

        control('agent.stream.stop');
        expect(win.width).toBe(120);
        expect(tmuxCalls).toContainEqual(['set-option', '-w', '-u', '-t', '%0', 'window-size']);
    });

    it('does not bounce the width when the same phone subscribes again', () => {
        control('agent.stream.start', { cols: 45 });
        control('agent.stream.start', { cols: 45 });
        expect(resizes()).toEqual(['45']);
    });

    it('follows the phone on renew and lets go once a desktop attaches', () => {
        control('agent.stream.start', { cols: 45 });
        control('agent.stream.renew', { cols: 80 });
        expect(win.width).toBe(80);

        win.attached = 1;
        control('agent.stream.renew', { cols: 80 });
        expect(resizes()).toEqual(['45', '80']);
        expect(tmuxCalls.at(-2)).toEqual(['set-option', '-w', '-u', '-t', '%0', 'window-size']);
    });

    it('resizes nothing for a viewer that sends no width', () => {
        control('agent.stream.start');
        control('agent.stream.stop');
        expect(resizes()).toEqual([]);
    });
});
