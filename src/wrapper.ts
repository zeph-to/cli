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
import { spawn, execFileSync, spawnSync } from 'child_process';
import { existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync } from 'fs';
import { homedir } from 'os';
import { basename, join } from 'path';

/** First non-empty value among the supported per-agent project dir env vars. */
const PROJECT_DIR_ENVS = ['CLAUDE_PROJECT_DIR', 'CURSOR_PROJECT_DIR', 'WINDSURF_PROJECT_DIR'] as const;

const FALLBACK_NAME = 'project';

/** basename(), with a stable fallback for edge paths like `/`. */
const safeBasename = (path: string): string => basename(path) || FALLBACK_NAME;

/** Resolve a project name for the tmux session: env > git root > cwd basename. */
export const detectProjectName = (): string => {
    for (const key of PROJECT_DIR_ENVS) {
        const v = process.env[key];
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

const ZEPH_DIR = join(homedir(), '.zeph');
const LISTENER_PID_FILE = join(ZEPH_DIR, 'listener.pid');
const LISTENER_LOG_FILE = join(ZEPH_DIR, 'listener.log');

/** True when the PID file points at a still-alive process. */
const listenerAlive = (): boolean => {
    try {
        const pid = Number(readFileSync(LISTENER_PID_FILE, 'utf-8').trim());
        if (!Number.isFinite(pid) || pid <= 0) return false;
        // Signal 0 = existence check; throws when the process is gone.
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
};

/**
 * Path to the running cli.js entry. We're invoked AS cli.js (the bin
 * shim defined in package.json), so process.argv[1] is our entry point.
 * Resolves whether the user calls `zeph cc` via the npm-installed shim
 * or directly via `node dist/cli.js cc`.
 */
const resolveCliPath = (): string | null => {
    const entry = process.argv[1];
    if (!entry) return null;
    // Sanity check: only autostart when we recognise the entry — refuse
    // to spawn an unknown binary from a weird invocation.
    if (!/cli\.(js|ts|mjs|cjs)$/.test(entry)) return null;
    return entry;
};

/**
 * Spawn `zeph listener` in the background if it isn't already running on
 * this machine. The intent is that the user only ever has to know about
 * `zeph cc` — the phone-to-tmux bridge tags along automatically. Output
 * goes to `~/.zeph/listener.log` so it isn't lost on detach; the listener
 * itself writes its own PID to `~/.zeph/listener.pid` on startup and
 * removes it on graceful exit, so subsequent `zeph cc` invocations skip
 * the spawn when a listener is already up.
 *
 * Failure here is non-fatal — `zeph cc` still launches the agent. The
 * user just loses the phone-bridge feature until they restart.
 */
/**
 * Rotate the listener log once it grows past 5 MB. The daemon runs for
 * days and writes 2-3 lines per 5-s cycle, so without rotation the file
 * climbs into the tens of megabytes range pretty quickly. We keep the
 * previous run's tail under `.old` for post-mortem and start fresh.
 */
const LISTENER_LOG_MAX_BYTES = 5 * 1024 * 1024;

const rotateListenerLogIfLarge = (): void => {
    try {
        if (!existsSync(LISTENER_LOG_FILE)) return;
        if (statSync(LISTENER_LOG_FILE).size <= LISTENER_LOG_MAX_BYTES) return;
        renameSync(LISTENER_LOG_FILE, LISTENER_LOG_FILE + '.old');
    } catch { /* best-effort */ }
};

const ensureListenerRunning = (): void => {
    if (listenerAlive()) return;
    const cliPath = resolveCliPath();
    if (!cliPath || !existsSync(cliPath)) return;
    try {
        mkdirSync(ZEPH_DIR, { recursive: true });
        rotateListenerLogIfLarge();
        const out = openSync(LISTENER_LOG_FILE, 'a');
        const child = spawn(process.execPath, [cliPath, 'listener'], {
            detached: true,
            stdio: ['ignore', out, out],
            env: { ...process.env, ZEPH_LISTENER_AUTOSTART: '1' },
        });
        child.unref();
        console.log(`zeph: listener autostarted in background (log: ${LISTENER_LOG_FILE})`);
    } catch (err) {
        console.error(`zeph: listener autostart failed: ${(err as Error).message}`);
    }
};

/**
 * Launch the agent in a named tmux session (or directly if nested) and
 * forward its exit code. `extra` is appended to the agent invocation, so
 * `zeph cc --resume foo` runs `claude --resume foo` inside the session.
 * Returns when the agent exits.
 */
export const handleAgentSession = (agent: string, extra: string[] = []): Promise<number> => {
    // Best-effort: make sure the phone-bridge daemon is running before we
    // launch the agent. The user shouldn't need to remember a second
    // command for the picker on their phone to work.
    ensureListenerRunning();
    return new Promise<number>((resolve) => {
        const { cmd, args } = targetForAgent(agent, extra);
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
