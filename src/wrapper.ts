/**
 * `zeph cc` / `zeph codex` / `zeph gemini` — spawn an agent inside a named
 * tmux session so the resident listener (`zeph listener`) can address it
 * by session name to inject messages later.
 *
 * The tmux session name follows `zeph-<project>` where <project> resolves
 * from CLAUDE/CURSOR/WINDSURF_PROJECT_DIR → git repo root → cwd basename.
 * When the wrapper is invoked from inside an existing tmux session
 * ($TMUX set) it skips the outer tmux to avoid nesting and execs the
 * agent directly — letting power users keep their own multiplexer setup.
 */
import { execFileSync, spawn, spawnSync } from 'child_process';
import { basename } from 'path';
import { isNewer } from './check-update.js';
import { PROJECT_DIR_ENV_VARS, resolvedEnv, VERSION } from './config.js';
import {
    LISTENER_LOG_FILE,
    runningListenerPid,
    runningListenerVersion,
    spawnListenerDetached,
    stopListener,
} from './listener-process.js';
import type { RemoteAgent } from './remote-agents.js';

const FALLBACK_NAME = 'project';

/** basename(), with a stable fallback for edge paths like `/`. */
const safeBasename = (path: string): string => basename(path) || FALLBACK_NAME;

/** Resolve a project name for the tmux session: env > git root > cwd basename. */
export const detectProjectName = (): string => {
    for (const key of PROJECT_DIR_ENV_VARS) {
        const v = resolvedEnv(key);
        if (v) return safeBasename(v.replace(/\/+$/, ''));
    }
    try {
        const root = execFileSync('git', ['rev-parse', '--show-toplevel'], {
            encoding: 'utf-8',
            stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
        if (root) return safeBasename(root);
    } catch { /* not a git repo — fall through */ }
    return safeBasename(process.cwd());
};

/** `zeph-<project>` — the canonical tmux session base name. */
export const tmuxSessionName = (project: string): string => `zeph-${project}`;

const MAX_SUFFIX_ATTEMPTS = 20;

/**
 * Pick a tmux session name that won't steal focus from another live
 * `zeph cc`. Strategy:
 *   - If `<base>` doesn't exist → use it (create new).
 *   - If `<base>` exists but is detached → use it (reattach).
 *   - If `<base>` exists *and* has a client attached → try `<base>-2`,
 *     `<base>-3`, … so the new `zeph cc` gets an independent session
 *     instead of joining the existing one.
 * Falls back to `<base>` after 20 attempts (shouldn't realistically hit).
 *
 * Detection uses `tmux has-session` and `tmux list-clients`; both are
 * dependency-free against the user's running tmux server.
 */
export const findAvailableSession = (base: string): string => {
    for (let i = 0; i < MAX_SUFFIX_ATTEMPTS; i++) {
        const name = i === 0 ? base : `${base}-${i + 1}`;
        const has = spawnSync('tmux', ['has-session', '-t', name], {
            stdio: ['ignore', 'ignore', 'ignore'],
        });
        if (has.status !== 0) return name; // doesn't exist — fresh session
        const clients = spawnSync('tmux', ['list-clients', '-t', name, '-F', '#{client_tty}'], {
            encoding: 'utf-8',
            stdio: ['ignore', 'pipe', 'ignore'],
        });
        const attached = (clients.stdout ?? '').trim().length > 0;
        if (!attached) return name; // exists but detached — reattach
    }
    return base;
};

interface SpawnTarget {
    cmd: string;
    args: string[];
}

/** POSIX shell-quote so passthrough args survive being joined into a tmux shell-command string. */
const SHELL_SAFE = /^[\w\-./=:@%+,]+$/;
const shellQuote = (s: string): string =>
    s.length > 0 && SHELL_SAFE.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;

const targetForAgent = (agent: string, extra: string[]): SpawnTarget => {
    // Already inside tmux → no nested session, just run the agent in the
    // current pane. Nested tmux prefix collisions are confusing and the
    // listener can't reach a session it didn't name anyway.
    if (process.env.TMUX) {
        return { cmd: agent, args: extra };
    }
    const base = tmuxSessionName(detectProjectName());
    // Auto-suffix when the default name is taken by another attached
    // session — lets the user keep `zeph cc` workflow simple and still
    // get independent sessions when opening multiple terminals in the
    // same project.
    const session = findAvailableSession(base);
    // `tmux new -A`: attach if the named session exists, else create it.
    // tmux joins trailing argv into a single shell-command, so flags like
    // `--resume` would be eaten by tmux's own parser. Build one quoted
    // shell string instead, which tmux passes through verbatim.
    const shellCmd = [agent, ...extra].map(shellQuote).join(' ');
    return { cmd: 'tmux', args: ['new', '-A', '-s', session, shellCmd] };
};

// ── Background listener auto-start ────────────────────────────────────

/**
 * Whether the daemon on record is running a different build than the one
 * we're launching from. `npm i -g @zeph-to/cli` swaps dist/ but leaves the
 * live process untouched, so a daemon can stay days behind the installed
 * package — answering pushes (chat looks fine) while silently ignoring every
 * message subtype added since it booted. That is exactly how a pre-1.24
 * listener left the phone's live terminal spinning until a reboot.
 *
 * A missing stamp means the daemon predates version stamping, which puts it
 * behind by definition — treat unknown as drifted.
 *
 * Strictly "installed is newer", never a plain inequality: one account can
 * have several installs at different versions (nvm node versions, a repo
 * build alongside the global one), and `!==` would make each `zeph cc` kill
 * and respawn the other's daemon forever. An older `zeph cc` leaves a newer
 * daemon alone — downgrading it would reintroduce the very gap this closes.
 */
export const listenerVersionDrifted = (running: string | null, installed: string): boolean =>
    running === null || isNewer(installed, running);

/**
 * Make sure the phone-bridge daemon is running AND is the build we just
 * launched from. `zeph cc` is the right moment to replace a drifted one: the
 * user is starting fresh work rather than mid-task, so the ~1s restart window
 * (in which a push would be dropped — WS fan-out has no queue) costs nothing.
 */
export const ensureListenerRunning = async (): Promise<void> => {
    const pid = runningListenerPid();
    if (pid !== null) {
        const running = runningListenerVersion();
        if (!listenerVersionDrifted(running, VERSION)) return;
        console.log(`zeph: listener ${running ?? '(pre-1.26)'} is stale — restarting on ${VERSION}`);
        await stopListener(pid);
    }
    if (spawnListenerDetached()) {
        if (pid === null) console.log(`zeph: listener autostarted in background (log: ${LISTENER_LOG_FILE})`);
    } else {
        console.error('zeph: listener autostart failed — run `zeph listener` manually.');
    }
};

/**
 * Launch the agent in a named tmux session (or directly if nested) and
 * forward its exit code. `extra` is appended to the agent invocation, so
 * `zeph cc --resume foo` runs `claude --resume foo` inside the session.
 * Returns when the agent exits.
 */
export const handleAgentSession = async (agent: RemoteAgent, extra: string[] = []): Promise<number> => {
    // Best-effort: make sure the phone-bridge daemon is running, and running
    // the build we were launched from. The user shouldn't need to remember a
    // second command for the picker on their phone to work.
    await ensureListenerRunning();
    return new Promise<number>((resolve) => {
        const { cmd, args } = targetForAgent(agent.binary, extra);
        const start = Date.now();
        const child = spawn(cmd, args, { stdio: 'inherit' });
        child.on('exit', (code) => {
            const dur = Date.now() - start;
            // Short-lived non-zero exits are the symptom of "ran from a
            // pane that isn't a real TTY" (iTerm tmux integration pane,
            // some IDE terminals). The user otherwise just sees their
            // shell return with `[exited]` and no clue what went wrong.
            if (code && code !== 0 && dur < 2000) {
                console.error(
                    `zeph: ${cmd} ${args.join(' ')} exited ${code} after ${dur}ms.\n` +
                    `  If this terminal is itself inside tmux (or an iTerm/Warp\n` +
                    `  tmux-integration pane), run \`zeph cc\` from a plain shell\n` +
                    `  pane instead — \`tmux new\` needs a real TTY to attach.`,
                );
            }
            resolve(code ?? 0);
        });
        child.on('error', (err: NodeJS.ErrnoException) => {
            if (err.code === 'ENOENT') {
                console.error(`zeph: '${cmd}' not found on PATH`);
                resolve(127);
            } else {
                console.error(`zeph: failed to spawn ${cmd}: ${err.message}`);
                resolve(1);
            }
        });
    });
};
