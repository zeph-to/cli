import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from './args.js';
import {
    classifyCommand, isSunset, RETIRED_ASK_STATE, SUNSET_DATE, SUNSET_ENDED, SUNSET_NOTICE, sunsetGate, type SunsetIO,
} from './sunset.js';

const BEFORE = new Date('2026-10-31T23:59:59.999Z');
const ON_D = new Date('2026-11-01T00:00:00.000Z');
const AFTER = new Date('2027-03-01T12:00:00.000Z');

/** A gate run against a fixed clock; `lines` collects stderr, `out` stdout. */
const run = (now: Date, ...argv: string[]) => {
    const lines: string[] = [];
    const out: string[] = [];
    const io: SunsetIO = { now: () => now, stdout: (line) => out.push(line), stderr: (line) => lines.push(line) };
    const args = parseArgs(['node', 'zeph', ...argv]);
    return { code: sunsetGate(args._command as string, args, io), lines, out };
};

const AGENT_ASK = ['ask', '--title', 'q', '--accepts-exit'];

const AGENT_COMMANDS = [
    ['send', 'zeph-api', 'hi'],
    ['rename', 'x'],
    ['forget', 'x'],
    ['cc'], ['claude'], ['codex'], ['cursor'], ['gemini'], ['pi'], ['opencode'], ['hermes'],
    ['sh'],
    ['listener'],
    ['listener', '--restart'],
    ['listener', '--install-service'],
    ['install'], ['setup'],
    ['verify'],
];

const HOOK_ENTRY_POINTS = [
    ['remote-hook', 'codex'],
    ['notify', '--title', 'Task done', '--auto', '--pushmode-default', 'normal'],
    ['notify', '--title', 'x', '--session', 's1'],
    ['notify', '--title', 'Waiting', '--body', 'b', '--priority', 'high', '--hook'],
    ['ask', '--title', 'Run rm?', '--actions', 'ok:Allow,no:Deny'],
];

const DATA_COMMANDS = [
    ['notify', '--title', 'hi'],
    ['notify', '--title', 'err', '--priority', 'high'],
    ['list'], ['dismiss', 'p1'], ['test'], ['login'], ['check-update'],
    ['uninstall'], ['uninstall', '--dry-run'], ['uninstall', '--purge'],
    ['mcp'],
    ['listener', '--stop'], ['listener', '--uninstall-service'], ['listener', '--service-status'],
];

afterEach(() => vi.restoreAllMocks());

describe('isSunset', () => {
    it('is false until the UTC day of SUNSET_DATE and true from its first instant', () => {
        expect(SUNSET_DATE).toBe('2026-11-01');
        expect(isSunset(BEFORE)).toBe(false);
        expect(isSunset(ON_D)).toBe(true);
        expect(isSunset(AFTER)).toBe(true);
    });

    it('compares the UTC day, not the local one', () => {
        // 2026-11-01 02:00 at +09:00 is still 2026-10-31 in UTC.
        expect(isSunset(new Date('2026-11-01T02:00:00+09:00'))).toBe(false);
        // 2026-10-31 20:00 at -05:00 is already 2026-11-01 in UTC.
        expect(isSunset(new Date('2026-10-31T20:00:00-05:00'))).toBe(true);
    });
});

describe('messages', () => {
    it('are neutral: the end date and uninstall, nothing else', () => {
        expect(SUNSET_NOTICE).toBe(
            'Zeph agent features end on 2026-11-01 (00:00 UTC). Run `zeph uninstall` to remove hooks and the background service.',
        );
        expect(SUNSET_ENDED).toBe(
            'Zeph agent features ended on 2026-11-01. Run `zeph uninstall` to remove hooks and the background service.',
        );
    });
});

describe('before the date', () => {
    it('lets an agent ask run after one notice', () => {
        const { code, lines, out } = run(BEFORE, ...AGENT_ASK);
        expect(code).toBeNull();
        expect(lines).toEqual([SUNSET_NOTICE]);
        expect(out).toEqual([]);
    });

    it.each(AGENT_COMMANDS)('%s prints one notice to stderr and proceeds', (...argv) => {
        const { code, lines } = run(BEFORE, ...argv);
        expect(code).toBeNull();
        expect(lines).toEqual([SUNSET_NOTICE]);
    });

    it.each(HOOK_ENTRY_POINTS)('%s stays silent and proceeds', (...argv) => {
        const { code, lines } = run(BEFORE, ...argv);
        expect(code).toBeNull();
        expect(lines).toEqual([]);
    });

    it.each(DATA_COMMANDS)('%s is untouched', (...argv) => {
        const { code, lines } = run(BEFORE, ...argv);
        expect(code).toBeNull();
        expect(lines).toEqual([]);
    });
});

describe('on and after the date', () => {
    it.each(AGENT_COMMANDS)('%s prints the ended line and exits 0 without running', (...argv) => {
        for (const now of [ON_D, AFTER]) {
            const { code, lines } = run(now, ...argv);
            expect(code).toBe(0);
            expect(lines).toEqual([SUNSET_ENDED]);
        }
    });

    it.each(HOOK_ENTRY_POINTS)('%s exits 0 silently', (...argv) => {
        for (const now of [ON_D, AFTER]) {
            const { code, lines } = run(now, ...argv);
            expect(code).toBe(0);
            expect(lines).toEqual([]);
        }
    });

    it.each(DATA_COMMANDS)('%s keeps working', (...argv) => {
        for (const now of [ON_D, AFTER]) {
            const { code, lines } = run(now, ...argv);
            expect(code).toBeNull();
            expect(lines).toEqual([]);
        }
    });

    it('answers an agent ask with one not-answered NORMAL line and exit 1', () => {
        for (const now of [ON_D, AFTER]) {
            const { code, lines, out } = run(now, ...AGENT_ASK);
            expect(code).toBe(1);
            expect(lines).toEqual([SUNSET_ENDED]);
            expect(out).toEqual([RETIRED_ASK_STATE]);
            expect(JSON.parse(RETIRED_ASK_STATE)).toEqual({ answered: false, timedOut: false, zephState: 'NORMAL' });
        }
    });

    it('refuses install and setup instead of writing hooks', () => {
        for (const command of ['install', 'setup']) {
            expect(run(AFTER, command, '--key', 'ak_1').code).toBe(0);
        }
    });

    it('never gates uninstall, which removes the hooks and the login service', () => {
        for (const now of [BEFORE, ON_D, AFTER]) {
            for (const flags of [[], ['--dry-run'], ['--purge']]) {
                expect(classifyCommand('uninstall', parseArgs(['node', 'zeph', 'uninstall', ...flags]))).toBe('data');
                expect(run(now, 'uninstall', ...flags).code).toBeNull();
            }
        }
    });

    it('makes no request for a gated command', () => {
        const fetchSpy = vi.spyOn(globalThis, 'fetch');
        for (const argv of [...AGENT_COMMANDS, AGENT_ASK, ...HOOK_ENTRY_POINTS]) run(AFTER, ...argv);
        expect(fetchSpy).not.toHaveBeenCalled();
    });
});

describe('classifyCommand', () => {
    it('treats ask as a hook entry point unless it carries --accepts-exit', () => {
        expect(classifyCommand('ask', parseArgs(['node', 'zeph', 'ask', '--title', 'q']))).toBe('hook');
        expect(classifyCommand('ask', parseArgs(['node', 'zeph', 'ask', '--title', 'q', '--accepts-exit']))).toBe('agent');
    });

    it('treats a plain notify as data and notify --auto, --hook or --session as a hook', () => {
        expect(classifyCommand('notify', parseArgs(['node', 'zeph', 'notify', '--title', 'x']))).toBe('data');
        expect(classifyCommand('notify', parseArgs(['node', 'zeph', 'notify', '--auto']))).toBe('hook');
        expect(classifyCommand('notify', parseArgs(['node', 'zeph', 'notify', '--session', 's']))).toBe('hook');
        expect(classifyCommand('notify', parseArgs(['node', 'zeph', 'notify', '--priority', 'high', '--hook']))).toBe('hook');
    });
});
