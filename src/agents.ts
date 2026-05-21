import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

// Agent detection shared by install / uninstall / verify. Kept in one place
// so the three commands can never disagree about which agents exist or how
// they're detected.

export interface Agent {
    name: string;
    id: string;
    detected: boolean;
}

const HOME = homedir();

export const hasCommand = (cmd: string): boolean => {
    try {
        execSync(`which ${cmd}`, { stdio: 'pipe' });
        return true;
    } catch {
        return false;
    }
};

export const detectAgents = (): Agent[] => [
    { name: 'Claude Code', id: 'claude', detected: hasCommand('claude') },
    { name: 'Cursor', id: 'cursor', detected: existsSync(join(HOME, '.cursor')) },
    { name: 'Windsurf', id: 'windsurf', detected: existsSync(join(HOME, '.codeium')) },
    { name: 'Gemini CLI', id: 'gemini', detected: hasCommand('gemini') },
    { name: 'Codex CLI', id: 'codex', detected: hasCommand('codex') },
    { name: 'Copilot CLI', id: 'copilot', detected: existsSync(join(HOME, '.copilot')) },
    { name: 'Cline', id: 'cline', detected: existsSync(join(HOME, '.cline')) },
    { name: 'Aider', id: 'aider', detected: hasCommand('aider') },
];
