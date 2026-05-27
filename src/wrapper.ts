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
import { spawn, execFileSync } from 'child_process';
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

/** `zeph-<project>` — the canonical tmux session name for the listener to target. */
export const tmuxSessionName = (project: string): string => `zeph-${project}`;

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
    const session = tmuxSessionName(detectProjectName());
    // `tmux new -A`: attach if the named session exists, else create it.
    // The agent command runs as the session's first window.
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
