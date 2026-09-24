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
let namedSocket = '';
let deadSocket = '';
const liveSockets = new Set<string>();
const spawnCalls: { cmd: string; args: string[] }[] = [];
vi.mock('child_process', async (importOriginal) => {
    const actual = await importOriginal<typeof import('child_process')>();
    return {
        ...actual,
        spawnSync: (cmd: string, args: string[]) => {
            spawnCalls.push({ cmd, args });
            if (cmd === 'tmux' && args[0] === '-S' && args[2] === 'list-sessions') {
                return { status: liveSockets.has(args[1]) ? 0 : 1, stdout: '', stderr: '' };
            }
            if (cmd === 'tmux' && args[0] === 'list-sessions') {
                return defaultSocketUp
                    ? { status: 0, stdout: '', stderr: '' }
                    : { status: 1, stdout: '', stderr: 'no server running' };
            }
            if (cmd === 'ps' && args[0] === '-A') {
                const me = userInfo().username;
                return {
                    status: 0,
                    stdout: [4242, 4243, 4244].map((pid) => `  ${pid} ${me} tmux new -A -s zeph-${pid} claude\n`).join(''),
                    stderr: '',
                };
            }
            if (cmd === 'lsof') {
                // Each tmux process holds its own socket; the first one's is dead.
                const socket = args[1] === '4242' ? deadSocket : customSocket;
                return { status: 0, stdout: `p${args[1]}\nn${socket}\n`, stderr: '' };
            }
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
deadSocket = join(TMP, `tmux-${userInfo().uid}`, 'dead');
writeFileSync(deadSocket, '');
// Where `tmux -L work` puts its socket: beside `default` in the per-user dir.
process.env.TMUX_TMPDIR = join(TMP, 'tmpdir');
mkdirSync(join(TMP, 'tmpdir', `tmux-${userInfo().uid}`), { recursive: true });
namedSocket = join(TMP, 'tmpdir', `tmux-${userInfo().uid}`, 'work');
writeFileSync(namedSocket, '');

const { collectSessionsVerbose, invalidateTmuxSocketCache } = await import('./listener.js');

const calls = (cmd: string) => spawnCalls.filter((c) => c.cmd === cmd).length;
const listPanes = () => spawnCalls.find((c) => c.cmd === 'tmux' && c.args.includes('list-panes'));

describe('tmux socket discovery', () => {
    beforeEach(() => {
        spawnCalls.length = 0;
        liveSockets.clear();
        invalidateTmuxSocketCache();
    });

    it('uses a live default socket without scanning processes', () => {
        defaultSocketUp = true;
        collectSessionsVerbose();
        expect(calls('lsof')).toBe(0);
        expect(spawnCalls.some((c) => c.cmd === 'ps' && c.args[0] === '-A')).toBe(false);
        expect(listPanes()?.args[0]).toBe('list-panes');
    });

    it('finds a `tmux -L` socket from the socket dir without scanning processes', () => {
        defaultSocketUp = false;
        liveSockets.add(namedSocket);
        collectSessionsVerbose();
        expect(calls('lsof')).toBe(0);
        expect(listPanes()?.args.slice(0, 2)).toEqual(['-S', namedSocket]);
    });

    it('falls back to process discovery last, stopping at the first live socket', () => {
        defaultSocketUp = false;
        liveSockets.add(customSocket);
        collectSessionsVerbose();
        // Three tmux processes: the first socket is dead, the second answers,
        // so the third is never scanned.
        expect(calls('lsof')).toBe(2);
        expect(listPanes()?.args.slice(0, 2)).toEqual(['-S', customSocket]);
    });
});
