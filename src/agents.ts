import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

// Agent detection shared by install / uninstall / verify. Kept in one place
// so the three commands can never disagree about which agents exist or how
// they're detected.

/**
 * Per-agent GLOBAL skill directories, keyed by the same `id` used in
 * `detectAgents`. Scan targets for `command-scan.ts` — keep next to the
 * detection table so the two can never disagree about which agents exist.
 *
 * Global only: project-level dirs depend on a session's cwd, and the catalog is
 * device-level (one scan per listener, shared by every session on the machine).
 *
 * pi's two entries come from its own docs (`docs/skills.md § Locations`,
 * pi 0.85.1): global is `~/.pi/agent/skills/` and `~/.agents/skills/`, while
 * `.pi/skills/` is the PROJECT dir — scanning `~/.pi/skills` found only three
 * dangling symlinks and reported pi as having no skills at all.
 */
export const AGENT_SKILL_DIRS: Record<string, string[]> = {
    claude: ['.claude/skills'],
    codex: ['.codex/skills'],
    pi: ['.pi/agent/skills', '.agents/skills'],
};

export interface Agent {
    name: string;
    id: string;
    detected: boolean;
}

const HOME = homedir();

/**
 * Absolute path of a command on PATH, or null when it isn't there.
 * `execFileSync`, not a shell: `process.execve` needs a real path (it does no
 * PATH lookup of its own), and building `which ${cmd}` as a shell string would
 * let a path containing a space split into two words.
 */
export const resolveCommand = (cmd: string): string | null => {
    try {
        return execFileSync('which', [cmd], { encoding: 'utf-8' }).trim() || null;
    } catch {
        return null;
    }
};

export const hasCommand = (cmd: string): boolean => resolveCommand(cmd) !== null;

export const detectAgents = (): Agent[] => [
    { name: 'Claude Code', id: 'claude', detected: hasCommand('claude') },
    { name: 'Cursor', id: 'cursor', detected: existsSync(join(HOME, '.cursor')) },
    { name: 'Windsurf', id: 'windsurf', detected: existsSync(join(HOME, '.codeium')) },
    { name: 'Gemini CLI', id: 'gemini', detected: hasCommand('gemini') },
    { name: 'Codex CLI', id: 'codex', detected: hasCommand('codex') },
    { name: 'Copilot CLI', id: 'copilot', detected: existsSync(join(HOME, '.copilot')) },
    { name: 'Cline', id: 'cline', detected: existsSync(join(HOME, '.cline')) },
    { name: 'Aider', id: 'aider', detected: hasCommand('aider') },
    { name: 'Pi', id: 'pi', detected: existsSync(join(HOME, '.pi')) || hasCommand('pi') },
    { name: 'OpenCode', id: 'opencode', detected: existsSync(join(HOME, '.config', 'opencode')) || hasCommand('opencode') },
];
