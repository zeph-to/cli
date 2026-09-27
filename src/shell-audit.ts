import { appendFileSync, mkdirSync, renameSync, statSync } from 'fs';
import { join } from 'path';
import { stateDir } from './gate.js';

/** One phone → shell-session injection, as the listener admitted it. */
export interface ShellAuditEntry {
    at: Date;
    session: string;
    /** The pane the guard probed — the one the input was typed into. */
    target: string;
    kind: 'body' | 'insert' | 'keys';
    /** `pane_current_command` when the input landed. */
    foreground: string;
    /** The foreground is the shell itself, so the text is a command line. */
    atShell: boolean;
    /** The text, or the key names joined by spaces. */
    text: string;
}

export const shellAuditPath = (): string => join(stateDir(), 'shell-audit.log');

/** Past this size the log moves to `shell-audit.log.1`, replacing the one before. */
export const SHELL_AUDIT_MAX_BYTES = 1024 * 1024;

/**
 * One tab-separated line. The text is kept only when it was typed at the shell
 * prompt: anything else went to a program running in the pane — a `sudo`
 * password prompt, an `ssh` login — and is recorded by length alone. Key names
 * are never secret, so they are kept whatever the foreground is. The payload
 * and every name are JSON-quoted, so a tab or newline in any of them cannot
 * forge a field or a line.
 */
export const formatShellAuditLine = (e: ShellAuditEntry): string => {
    const payload = e.atShell || e.kind === 'keys'
        ? JSON.stringify(e.text)
        : `[${[...e.text].length} chars → ${JSON.stringify(e.foreground)}]`;
    const q = JSON.stringify;
    return [e.at.toISOString(), q(e.session), q(e.target), e.kind, q(e.foreground), payload].join('\t') + '\n';
};

/**
 * Append one entry to the audit log, a 0600 file (the state dir it sits in is
 * shared, and whichever writer creates it first sets its mode). Returns false
 * instead of throwing: the log answers "what did the phone run", and a full
 * disk must not also stop the phone from running it.
 */
export const appendShellAudit = (entry: ShellAuditEntry, path: string = shellAuditPath()): boolean => {
    try {
        mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
        if ((statSync(path, { throwIfNoEntry: false })?.size ?? 0) >= SHELL_AUDIT_MAX_BYTES) renameSync(path, `${path}.1`);
        appendFileSync(path, formatShellAuditLine(entry), { mode: 0o600 });
        return true;
    } catch {
        return false;
    }
};
