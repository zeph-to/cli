import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendShellAudit, formatShellAuditLine, SHELL_AUDIT_MAX_BYTES, shellAuditPath, type ShellAuditEntry } from './shell-audit.js';

const entry = (override: Partial<ShellAuditEntry> = {}): ShellAuditEntry => ({
    at: new Date('2026-09-27T02:00:00.000Z'),
    session: 'zeph-app-sh',
    target: '%3',
    kind: 'body',
    foreground: 'zsh',
    atShell: true,
    text: 'ls -la',
    ...override,
});

describe('formatShellAuditLine', () => {
    it('keeps a command typed at the shell prompt', () => {
        expect(formatShellAuditLine(entry())).toBe('2026-09-27T02:00:00.000Z\t"zeph-app-sh"\t"%3"\tbody\t"zsh"\t"ls -la"\n');
    });

    it('records input to another program by length only — a sudo password never lands on disk', () => {
        const line = formatShellAuditLine(entry({ foreground: 'sudo', atShell: false, text: 'hunter2' }));
        expect(line).toBe('2026-09-27T02:00:00.000Z\t"zeph-app-sh"\t"%3"\tbody\t"sudo"\t[7 chars → "sudo"]\n');
        expect(line).not.toContain('hunter2');
    });

    it('keeps key names whatever the foreground is', () => {
        expect(formatShellAuditLine(entry({ kind: 'keys', foreground: 'vim', atShell: false, text: 'C-c' })))
            .toBe('2026-09-27T02:00:00.000Z\t"zeph-app-sh"\t"%3"\tkeys\t"vim"\t"C-c"\n');
    });

    it('cannot be split into extra fields or lines by a tab or newline in any value', () => {
        const line = formatShellAuditLine(entry({ text: 'echo a\n2026-01-01T00:00:00Z\tforged', foreground: 'x\ty' }));
        expect(line.split('\n')).toHaveLength(2);
        expect(line.split('\t')).toHaveLength(6);
    });
});

describe('appendShellAudit', () => {
    let stateHome: string;
    let savedXdg: string | undefined;

    beforeEach(() => {
        stateHome = mkdtempSync(join(tmpdir(), 'zeph-shell-audit-'));
        savedXdg = process.env.XDG_STATE_HOME;
        process.env.XDG_STATE_HOME = stateHome;
    });

    afterEach(() => {
        if (savedXdg === undefined) delete process.env.XDG_STATE_HOME;
        else process.env.XDG_STATE_HOME = savedXdg;
        rmSync(stateHome, { recursive: true, force: true });
    });

    it('appends one line per entry to a 0600 file in the state dir', () => {
        expect(appendShellAudit(entry())).toBe(true);
        expect(appendShellAudit(entry({ text: 'pwd' }))).toBe(true);
        const path = shellAuditPath();
        expect(path).toBe(join(stateHome, 'zeph', 'shell-audit.log'));
        expect(readFileSync(path, 'utf-8').trimEnd().split('\n')).toHaveLength(2);
        expect(statSync(path).mode & 0o777).toBe(0o600);
    });

    it('moves a full log to .1 and starts a new one', () => {
        const path = shellAuditPath();
        appendShellAudit(entry());
        writeFileSync(path, 'x'.repeat(SHELL_AUDIT_MAX_BYTES));
        expect(appendShellAudit(entry({ text: 'pwd' }))).toBe(true);
        expect(statSync(`${path}.1`).size).toBe(SHELL_AUDIT_MAX_BYTES);
        expect(readFileSync(path, 'utf-8')).toBe(formatShellAuditLine(entry({ text: 'pwd' })));
        expect(statSync(path).mode & 0o777).toBe(0o600);
    });

    it('returns false instead of throwing when the write fails', () => {
        expect(appendShellAudit(entry(), join(stateHome, 'missing-dir', 'x', 'shell-audit.log'))).toBe(false);
    });
});
