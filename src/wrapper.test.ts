import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectProjectName, tmuxSessionName } from './wrapper.js';

const ENV_KEYS = ['CLAUDE_PROJECT_DIR', 'CURSOR_PROJECT_DIR', 'WINDSURF_PROJECT_DIR'] as const;
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
