import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Under the login-time service, launchd holds the daemon's stdout fd open on
 * `listener.log`. Renaming the file leaves that fd writing to the same inode
 * under its new name — the log the user tails never shrinks, and the daemon
 * runs for weeks. Rotation has to keep the inode and empty it.
 */
const homes: string[] = [];
const originalHome = process.env.HOME;

const load = async () => {
    const home = mkdtempSync(join(tmpdir(), 'zeph-log-rotate-'));
    homes.push(home);
    process.env.HOME = home;
    vi.resetModules();
    const mod = await import('./listener-process.js');
    mkdirSync(join(home, '.zeph'), { recursive: true });
    return { ...mod, home };
};

afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
    vi.resetModules();
});

describe('rotateListenerLogIfLarge', () => {
    it('empties the log in place and keeps the old contents beside it', async () => {
        const m = await load();
        const big = 'x'.repeat(6 * 1024 * 1024);
        writeFileSync(m.LISTENER_LOG_FILE, big);
        const inodeBefore = statSync(m.LISTENER_LOG_FILE).ino;

        m.rotateListenerLogIfLarge();

        // Same file, now empty — the fd launchd holds keeps working.
        expect(existsSync(m.LISTENER_LOG_FILE)).toBe(true);
        expect(statSync(m.LISTENER_LOG_FILE).size).toBe(0);
        expect(statSync(m.LISTENER_LOG_FILE).ino).toBe(inodeBefore);
        expect(readFileSync(`${m.LISTENER_LOG_FILE}.old`, 'utf-8')).toHaveLength(big.length);
    });

    it('leaves a log under the threshold alone', async () => {
        const m = await load();
        writeFileSync(m.LISTENER_LOG_FILE, 'small');
        m.rotateListenerLogIfLarge();
        expect(readFileSync(m.LISTENER_LOG_FILE, 'utf-8')).toBe('small');
        expect(existsSync(`${m.LISTENER_LOG_FILE}.old`)).toBe(false);
    });

    it('is a no-op when there is no log yet', async () => {
        const m = await load();
        expect(() => m.rotateListenerLogIfLarge()).not.toThrow();
        expect(existsSync(m.LISTENER_LOG_FILE)).toBe(false);
    });
});
