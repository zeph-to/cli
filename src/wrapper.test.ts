import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectProjectDir, detectProjectName, handOffExec, sanitizeLabel, splitAgentOptions, targetForAgent, tmuxSessionName } from './wrapper.js';
import type { ProcessHandOff } from './wrapper.js';

// TMUX is in here for two reasons: targetForAgent branches on it, and a
// developer running the suite from inside tmux would otherwise have it set
// ambiently and fail every "outside tmux" case.
const ENV_KEYS = ['CLAUDE_PROJECT_DIR', 'CURSOR_PROJECT_DIR', 'WINDSURF_PROJECT_DIR', 'TMUX'] as const;
const originalEnv: Record<string, string | undefined> = {};
let originalCwd: string;

beforeEach(() => {
    for (const k of ENV_KEYS) {
        originalEnv[k] = process.env[k];
        delete process.env[k];
    }
    originalCwd = process.cwd();
});

afterEach(() => {
    for (const k of ENV_KEYS) {
        if (originalEnv[k] === undefined) delete process.env[k];
        else process.env[k] = originalEnv[k];
    }
    process.chdir(originalCwd);
});

describe('tmuxSessionName', () => {
    it('prefixes with zeph-', () => {
        expect(tmuxSessionName('myapp')).toBe('zeph-myapp');
    });
});

describe('detectProjectName', () => {
    it('uses CLAUDE_PROJECT_DIR basename when set', () => {
        process.env.CLAUDE_PROJECT_DIR = '/Users/me/code/my-project';
        expect(detectProjectName()).toBe('my-project');
    });

    it('strips trailing slashes from env path', () => {
        process.env.CLAUDE_PROJECT_DIR = '/Users/me/code/my-project/';
        expect(detectProjectName()).toBe('my-project');
    });

    it('CLAUDE_PROJECT_DIR wins over CURSOR_PROJECT_DIR', () => {
        process.env.CLAUDE_PROJECT_DIR = '/a/claude';
        process.env.CURSOR_PROJECT_DIR = '/b/cursor';
        expect(detectProjectName()).toBe('claude');
    });

    it('falls back to CURSOR_PROJECT_DIR when CLAUDE is unset', () => {
        process.env.CURSOR_PROJECT_DIR = '/work/cursor-proj';
        expect(detectProjectName()).toBe('cursor-proj');
    });

    it('falls back to WINDSURF_PROJECT_DIR when neither claude nor cursor is set', () => {
        process.env.WINDSURF_PROJECT_DIR = '/work/wind-proj';
        expect(detectProjectName()).toBe('wind-proj');
    });

    it('falls back to cwd basename when no env is set and not a git repo', () => {
        // /tmp is not a git repo on most CI / dev boxes — git rev-parse fails,
        // and detectProjectName drops to cwd basename.
        process.chdir('/tmp');
        expect(detectProjectName()).toBe('tmp');
    });
});

describe('targetForAgent', () => {
    // Inside tmux the wrapper must not open a nested session — the listener
    // can't reach a session it didn't name, and nested prefixes are confusing.
    it('runs the agent in the current pane when already inside tmux', () => {
        process.env.TMUX = '/private/tmp/tmux-501/default,43544,87';
        expect(targetForAgent('claude', ['--resume'])).toEqual({ kind: 'direct', cmd: 'claude', args: ['--resume'] });
    });

    it('opens a named tmux session when outside tmux', () => {
        process.env.CLAUDE_PROJECT_DIR = '/work/zeph-target-probe';
        const { kind, cmd, args } = targetForAgent('claude', []);
        expect(kind).toBe('tmux-new');
        expect(cmd).toBe('tmux');
        expect(args.slice(0, 4)).toEqual(['new', '-A', '-s', 'zeph-zeph-target-probe']);
    });

    // tmux joins trailing argv into one shell-command, so passthrough args are
    // quoted into a single string rather than passed as separate argv entries.
    it('shell-quotes passthrough args that carry spaces or quotes', () => {
        process.env.CLAUDE_PROJECT_DIR = '/work/zeph-quote-probe';
        const [, , , , shellCmd] = targetForAgent('claude', ['--resume', 'a b']).args;
        expect(shellCmd).toBe("claude --resume 'a b'");
    });

    it('leaves shell-safe args unquoted', () => {
        process.env.CLAUDE_PROJECT_DIR = '/work/zeph-plain-probe';
        const [, , , , shellCmd] = targetForAgent('claude', ['--resume']).args;
        expect(shellCmd).toBe('claude --resume');
    });

    // `--label` pins the name: the caller wants this exact session next to
    // the user's own `zeph pi`, not a slot in the -2/-3 family.
    it('--label names the session zeph-<project>-<label> and skips the family scan', () => {
        process.env.CLAUDE_PROJECT_DIR = '/work/pi-config';
        const { kind, args } = targetForAgent('pi', ['-n', 'x'], 'pi', { label: '20260914-PLAN-11-32-44-pi' });
        expect(kind).toBe('tmux-new');
        expect(args.slice(0, 4)).toEqual(['new', '-A', '-s', 'zeph-pi-config-20260914-PLAN-11-32-44-pi']);
    });

    // `-d` needs no TTY and fails loudly on a taken name; `-c` pins the cwd
    // because the tmux server's default-path is wherever it was first started.
    it('--detach creates the session without attaching, in the current directory', () => {
        process.env.CLAUDE_PROJECT_DIR = '/work/pi-config';
        const { kind, cmd, args } = targetForAgent('pi', ['/skill:02-implement a.md'], 'pi', { detach: true, label: 'impl' });
        expect(kind).toBe('tmux-detached');
        expect(cmd).toBe('tmux');
        expect(args).toEqual(['new', '-d', '-s', 'zeph-pi-config-impl', '-c', '/work/pi-config', "pi '/skill:02-implement a.md'"]);
    });

    // `new -d` only creates, so the reuse candidate `findAvailableSession`
    // prefers (a detached session) would just fail on the name.
    it('--detach without a label takes a name no live session holds', () => {
        process.env.CLAUDE_PROJECT_DIR = '/work/zeph-detach-free-probe';
        const { kind, session } = targetForAgent('pi', [], 'pi', { detach: true });
        expect(kind).toBe('tmux-detached');
        expect(session).toBe('zeph-zeph-detach-free-probe');
    });

    it('the target carries its session name instead of leaving it to argv position', () => {
        process.env.CLAUDE_PROJECT_DIR = '/work/pi-config';
        expect(targetForAgent('pi', [], 'pi', { label: 'impl' }).session).toBe('zeph-pi-config-impl');
        expect(targetForAgent('pi', [], 'pi').session).toMatch(/^zeph-pi-config/);
    });

    // A label asks for a named session; the in-pane shortcut would drop it silently.
    it('--label inside tmux still opens a tmux session', () => {
        process.env.TMUX = '/private/tmp/tmux-501/default,43544,87';
        process.env.CLAUDE_PROJECT_DIR = '/work/pi-config';
        expect(targetForAgent('pi', [], 'pi', { label: 'impl' }).kind).toBe('tmux-new');
    });

    // A Claude Code session launching the implementer runs inside tmux itself;
    // a detached launch never nests, so the direct-run shortcut must not fire.
    it('--detach still opens a tmux session when already inside tmux', () => {
        process.env.TMUX = '/private/tmp/tmux-501/default,43544,87';
        process.env.CLAUDE_PROJECT_DIR = '/work/pi-config';
        expect(targetForAgent('pi', [], 'pi', { detach: true, label: 'impl' }).kind).toBe('tmux-detached');
    });
});

describe('splitAgentOptions', () => {
    it('reads --detach and --label off the front and leaves the agent args alone', () => {
        expect(splitAgentOptions(['--detach', '--label', 'impl', '-n', 'x', '/skill:simplify'])).toEqual({
            opts: { detach: true, label: 'impl' },
            rest: ['-n', 'x', '/skill:simplify'],
        });
        expect(splitAgentOptions(['--label=impl', '--resume'])).toEqual({ opts: { label: 'impl' }, rest: ['--resume'] });
    });

    it('stops at the first agent arg — a later --detach belongs to the agent', () => {
        expect(splitAgentOptions(['--resume', '--detach'])).toEqual({ opts: {}, rest: ['--resume', '--detach'] });
        expect(splitAgentOptions([])).toEqual({ opts: {}, rest: [] });
    });

    it('rejects an empty or flag-shaped label instead of naming the session zeph-<project>-', () => {
        expect(splitAgentOptions(['--label', '', 'x']).error).toMatch(/empty/);
        expect(splitAgentOptions(['--label=  ']).error).toMatch(/empty/);
        expect(splitAgentOptions(['--label', '--detach']).error).toMatch(/needs a value/);
        expect(splitAgentOptions(['--label']).error).toMatch(/needs a value/);
    });
});

describe('sanitizeLabel', () => {
    it('turns what tmux forbids in a session name into dashes', () => {
        expect(sanitizeLabel(' PLAN-11.32:44 ')).toBe('PLAN-11-32-44');
    });
});

describe('detectProjectDir', () => {
    it('is the directory the session name comes from — env first, then cwd outside a repo', () => {
        process.env.CLAUDE_PROJECT_DIR = '/Users/me/code/my-project/';
        expect(detectProjectDir()).toBe('/Users/me/code/my-project');
        delete process.env.CLAUDE_PROJECT_DIR;
        process.chdir('/tmp');
        expect(detectProjectDir()).toBe(process.cwd());
    });
});

describe('handOffExec', () => {
    // A stand-in for process.execve, which the real signature types as never-
    // returning — a stub cannot honour that, so the cast is the whole fake.
    const execve = ((): never => { throw new Error('execve stub'); }) as ProcessHandOff;
    const tmuxNew = { kind: 'tmux-new' as const, stdinTTY: true, stdoutTTY: true };

    // The wrapper otherwise sits resident for the whole session doing nothing
    // but waiting on tmux. Handing the process over deletes it outright.
    it('never hands off a detached launch — the wrapper returns after tmux answers', () => {
        expect(handOffExec({ execve, kind: 'tmux-detached', stdinTTY: true, stdoutTTY: true })).toBeNull();
    });

    it('returns the exec when execve exists and both streams are a terminal', () => {
        expect(handOffExec({ execve, ...tmuxNew })).toBe(execve);
    });

    // node <22.15 and Windows have no execve — those keep the spawn+wait path.
    it('refuses without execve', () => {
        expect(handOffExec({ execve: undefined, ...tmuxNew })).toBeNull();
    });

    // Losing stdout would lose whatever ensureListenerRunning printed: execve
    // runs no cleanup, and only a TTY is written synchronously on POSIX.
    it('refuses when stdout is not a terminal, whichever target it is', () => {
        expect(handOffExec({ execve, ...tmuxNew, stdoutTTY: false })).toBeNull();
        expect(handOffExec({ execve, kind: 'direct', stdinTTY: true, stdoutTTY: false })).toBeNull();
    });

    // `tmux new` needs a terminal to attach to — that failure is the one the
    // spawn+wait path exists to explain, so it must not be handed off.
    it('refuses a tmux target without a stdin terminal', () => {
        expect(handOffExec({ execve, ...tmuxNew, stdinTTY: false })).toBeNull();
    });

    // Running the agent in the pane we are already in attaches nothing, so
    // stdin being a pipe is not this decision's business.
    it('hands off a direct target even without a stdin terminal', () => {
        expect(handOffExec({ execve, kind: 'direct', stdinTTY: undefined, stdoutTTY: true })).toBe(execve);
    });

    // process.stdin.isTTY is `undefined`, not false, when stdin is a pipe.
    it('treats an undefined isTTY as not a terminal', () => {
        expect(handOffExec({ execve, ...tmuxNew, stdinTTY: undefined })).toBeNull();
    });
});
