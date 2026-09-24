import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir, userInfo } from 'os';
import { join } from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Regression: socket discovery ran `ps -A` plus one `lsof -p` per tmux
// process (every `tmux new -A` client, not just the server) before it probed
// the default socket. With 14 sessions on a loaded daemon that was 11–19s+,
// so every fresh inventory worker overran its 20s budget, the offload fell
// back to in-thread sweeps, and the main loop stalled long enough for the
// phone to sit on "Waiting for the live stream…".
let defaultSocketUp = true;
let customSocket = '';
const spawnCalls: { cmd: string; args: string[] }[] = [];
vi.mock('child_process', async (importOriginal) => {
    const actual = await importOriginal<typeof import('child_process')>();
    return {
        ...actual,
        spawnSync: (cmd: string, args: string[]) => {
            spawnCalls.push({ cmd, args });
            if (cmd === 'tmux' && args[0] === '-S' && args[2] === 'list-sessions') {
                return { status: args[1] === customSocket ? 0 : 1, stdout: '', stderr: '' };
            }
            if (cmd === 'tmux' && args[0] === 'list-sessions') {
                return defaultSocketUp
                    ? { status: 0, stdout: '', stderr: '' }
                    : { status: 1, stdout: '', stderr: 'no server running' };
            }
            if (cmd === 'ps' && args[0] === '-A') {
                return { status: 0, stdout: `  4242 ${userInfo().username} tmux new -A -s zeph-a claude\n`, stderr: '' };
            }
            if (cmd === 'lsof') return { status: 0, stdout: `p4242\nn${customSocket}\n`, stderr: '' };
            return { status: 1, stdout: '', stderr: 'no server' };
        },
    };
});

const TMP = mkdtempSync(join(tmpdir(), 'zeph-tmux-discovery-'));
process.env.HOME = TMP;
process.env.XDG_STATE_HOME = join(TMP, 'state');
// Only reachable through lsof: not under TMPDIR, /var/folders or /tmp.
mkdirSync(join(TMP, `tmux-${userInfo().uid}`));
customSocket = join(TMP, `tmux-${userInfo().uid}`, 'custom');
writeFileSync(customSocket, '');

const { collectSessionsVerbose, invalidateTmuxSocketCache } = await import('./listener.js');

const calls = (cmd: string) => spawnCalls.filter((c) => c.cmd === cmd).length;
const listPanes = () => spawnCalls.find((c) => c.cmd === 'tmux' && c.args.includes('list-panes'));

describe('tmux socket discovery', () => {
    beforeEach(() => {
        spawnCalls.length = 0;
        invalidateTmuxSocketCache();
    });

    it('uses a live default socket without scanning processes', () => {
        defaultSocketUp = true;
        collectSessionsVerbose();
        expect(calls('lsof')).toBe(0);
        expect(spawnCalls.some((c) => c.cmd === 'ps' && c.args[0] === '-A')).toBe(false);
        expect(listPanes()?.args[0]).toBe('list-panes');
    });

    it('still falls back to process discovery when the default socket is down', () => {
        defaultSocketUp = false;
        collectSessionsVerbose();
        expect(calls('lsof')).toBe(1);
        expect(listPanes()?.args.slice(0, 2)).toEqual(['-S', customSocket]);
    });
});
