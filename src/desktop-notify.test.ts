import { describe, expect, it } from 'vitest';
import { notifyDesktop } from './desktop-notify.js';

// The banner is the only thing the user sees when a file lands without
// them looking at a log. What matters: the right tool per platform, the
// file name passed as argv (never through a shell), and silence — not an
// error — when there is no notifier.

const recorder = () => {
    const calls: { cmd: string; args: string[] }[] = [];
    const run = async (cmd: string, args: string[]) => { calls.push({ cmd, args }); };
    return { calls, run };
};

describe('notifyDesktop', () => {
    it('macOS: osascript display notification with the body and title as AppleScript strings', async () => {
        const r = recorder();
        const ok = await notifyDesktop({ title: 'Zeph · shot.png', body: 'from myapp' }, { platform: 'darwin', run: r.run });
        expect(ok).toBe(true);
        expect(r.calls).toEqual([{
            cmd: 'osascript',
            args: ['-e', 'display notification "from myapp" with title "Zeph · shot.png"'],
        }]);
    });

    it('macOS: a file name with quotes and backslashes cannot break out of the AppleScript literal', async () => {
        const r = recorder();
        await notifyDesktop({ title: 'Zeph · say "hi"\\now.txt', body: 'x' }, { platform: 'darwin', run: r.run });
        expect(r.calls[0].args[1]).toBe('display notification "x" with title "Zeph · say \\"hi\\"\\\\now.txt"');
    });

    it('Linux: notify-send when it is on PATH, argv not shell', async () => {
        const r = recorder();
        const ok = await notifyDesktop({ title: 'T', body: '$(rm -rf ~)' }, { platform: 'linux', run: r.run, onPath: () => true });
        expect(ok).toBe(true);
        expect(r.calls).toEqual([{ cmd: 'notify-send', args: ['--', 'T', '$(rm -rf ~)'] }]);
    });

    it('Linux: a title or body that looks like a flag stays text behind the -- terminator', async () => {
        const r = recorder();
        await notifyDesktop({ title: '-t', body: '--urgency=critical' }, { platform: 'linux', run: r.run, onPath: () => true });
        expect(r.calls[0].args).toEqual(['--', '-t', '--urgency=critical']);
    });

    it('Linux without notify-send, and other platforms: no command, resolves false', async () => {
        const r = recorder();
        expect(await notifyDesktop({ title: 'T', body: 'b' }, { platform: 'linux', run: r.run, onPath: () => false })).toBe(false);
        expect(await notifyDesktop({ title: 'T', body: 'b' }, { platform: 'win32', run: r.run })).toBe(false);
        expect(r.calls).toEqual([]);
    });

    it('a notifier that fails resolves false instead of rejecting', async () => {
        const run = async () => { throw new Error('osascript: not permitted'); };
        await expect(notifyDesktop({ title: 'T', body: 'b' }, { platform: 'darwin', run })).resolves.toBe(false);
    });
});
