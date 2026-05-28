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
import { basename } from 'path';

/** First non-empty value among the supported per-agent project dir env vars. */
const PROJECT_DIR_ENVS = ['CLAUDE_PROJECT_DIR', 'CURSOR_PROJECT_DIR', 'WINDSURF_PROJECT_DIR'] as const;

/** Resolve a project name for the tmux session: env > git root > cwd basename. */
export const detectProjectName = (): string => {
    for (const key of PROJECT_DIR_ENVS) {
        const v = process.env[key];
        if (v) return basename(v.replace(/\/+$/, '')) || 'project';
    }
    try {
        const root = execFileSync('git', ['rev-parse', '--show-toplevel'], {
            encoding: 'utf-8',
            stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
        if (root) return basename(root) || 'project';
    } catch { /* not a git repo — fall through */ }
    return basename(process.cwd()) || 'project';
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

const targetForAgent = (agent: string): SpawnTarget => {
    // Already inside tmux → no nested session, just run the agent in the
    // current pane. Nested tmux prefix collisions are confusing and the
    // listener can't reach a session it didn't name anyway.
    if (process.env.TMUX) {
        return { cmd: agent, args: [] };
    }
    const base = tmuxSessionName(detectProjectName());
    // Auto-suffix when the default name is taken by another attached
    // session — lets the user keep `zeph cc` workflow simple and still
    // get independent sessions when opening multiple terminals in the
    // same project.
    const session = findAvailableSession(base);
    // `tmux new -A`: attach if the named session exists, else create it.
    return { cmd: 'tmux', args: ['new', '-A', '-s', session, agent] };
};

/**
 * Launch the agent in a named tmux session (or directly if nested) and
 * forward its exit code. Returns when the agent exits.
 */
export const handleAgentSession = (agent: string): Promise<number> => {
    return new Promise<number>((resolve) => {
        const { cmd, args } = targetForAgent(agent);
        const child = spawn(cmd, args, { stdio: 'inherit' });
        child.on('exit', (code) => resolve(code ?? 0));
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
