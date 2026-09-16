import { execFile } from 'node:child_process';
import { delimiter, join } from 'node:path';
import { accessSync, constants } from 'node:fs';

/**
 * Desktop banner for a file that just landed (ADR-0013): macOS through
 * `osascript`, Linux through `notify-send` when it is on PATH, otherwise
 * nothing — the listener log line is the fallback everywhere. No click
 * action: the banner text carries the file name, that is the whole UI.
 *
 * Best-effort by design. Never throws, never rejects; a failed banner
 * must not turn a delivered file into an error.
 */

export interface DesktopNotification {
    title: string;
    body: string;
}

export interface DesktopNotifyDeps {
    platform?: NodeJS.Platform;
    /** `execFile`-shaped: argv, not a shell string, so nothing is interpolated. */
    run?: (cmd: string, args: string[]) => Promise<void>;
    onPath?: (cmd: string) => boolean;
}

const runCommand = (cmd: string, args: string[]): Promise<void> =>
    new Promise((resolve, reject) => {
        execFile(cmd, args, { timeout: 5_000 }, (err) => (err ? reject(err) : resolve()));
    });

const commandOnPath = (cmd: string): boolean =>
    (process.env.PATH ?? '').split(delimiter).some((dir) => {
        if (!dir) return false;
        try { accessSync(join(dir, cmd), constants.X_OK); return true; } catch { return false; }
    });

/** AppleScript string literal: only `\` and `"` need escaping inside double quotes. */
const appleScriptString = (s: string): string => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/**
 * Show the banner. Resolves true when a command ran and exited cleanly,
 * false when there is no notifier here or it failed.
 */
export const notifyDesktop = async (
    note: DesktopNotification,
    deps: DesktopNotifyDeps = {},
): Promise<boolean> => {
    const platform = deps.platform ?? process.platform;
    const run = deps.run ?? runCommand;
    const onPath = deps.onPath ?? commandOnPath;
    try {
        if (platform === 'darwin') {
            const script = `display notification ${appleScriptString(note.body)} with title ${appleScriptString(note.title)}`;
            await run('osascript', ['-e', script]);
            return true;
        }
        if (platform === 'linux' && onPath('notify-send')) {
            // `--`: a title or body starting with '-' is text, not a flag.
            await run('notify-send', ['--', note.title, note.body]);
            return true;
        }
        return false;
    } catch {
        return false;
    }
};
