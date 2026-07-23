import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The module resolves its paths from homedir() at import time, so each case
// gets a throwaway $HOME and a fresh module graph.
const homes: string[] = [];
const originalHome = process.env.HOME;

const load = async () => {
    const home = mkdtempSync(join(tmpdir(), 'zeph-listener-proc-'));
    homes.push(home);
    process.env.HOME = home;
    vi.resetModules();
    const mod = await import('./listener-process.js');
    return { ...mod, home };
};

/** A pid that is guaranteed dead: spawn something trivial and let it exit. */
const deadPid = async (): Promise<number> => {
    const child = spawn(process.execPath, ['-e', '']);
    await new Promise((resolve) => child.on('exit', resolve));
    return child.pid as number;
};

/** A pid that is guaranteed alive until stopped. */
const livePid = (): { pid: number; exited: Promise<void> } => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    const exited = new Promise<void>((resolve) => child.on('exit', () => resolve()));
    return { pid: child.pid as number, exited };
};

afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
    vi.resetModules();
});

describe('listener runtime stamps', () => {
    it('writes the pid and the version stamp together', async () => {
        const m = await load();
        m.writeListenerRuntime('9.9.9');
        expect(readFileSync(m.LISTENER_PID_FILE, 'utf-8')).toBe(String(process.pid));
        expect(m.runningListenerPid()).toBe(process.pid);
        expect(m.runningListenerVersion()).toBe('9.9.9');
    });

    it('reports no listener when the stamp is missing', async () => {
        const m = await load();
        expect(m.runningListenerPid()).toBeNull();
        expect(m.runningListenerVersion()).toBeNull();
    });

    it('treats a stale pid file as no listener', async () => {
        const m = await load();
        m.writeListenerRuntime('1.0.0');
        writeFileSync(m.LISTENER_PID_FILE, String(await deadPid()));
        expect(m.runningListenerPid()).toBeNull();
    });

    // The drift check reads "no version stamp" as "older than the stamp
    // itself", so an empty file must not read as a valid version.
    it('reads an empty version stamp as unknown', async () => {
        const m = await load();
        m.writeListenerRuntime('');
        expect(m.runningListenerVersion()).toBeNull();
    });
});

describe('clearListenerRuntime', () => {
    it('clears our own stamps', async () => {
        const m = await load();
        m.writeListenerRuntime('1.0.0');
        m.clearListenerRuntime(process.pid);
        expect(existsSync(m.LISTENER_PID_FILE)).toBe(false);
        expect(existsSync(m.LISTENER_VERSION_FILE)).toBe(false);
    });

    // A predecessor's exit handler must not delete the slot a successor
    // already claimed — that would void the singleton guard.
    it('leaves a successor’s stamps alone', async () => {
        const m = await load();
        m.writeListenerRuntime('1.0.0');
        m.clearListenerRuntime(process.pid + 1);
        expect(existsSync(m.LISTENER_PID_FILE)).toBe(true);
    });
});

describe('clearStaleListenerRuntime', () => {
    it('keeps the stamps of a live listener', async () => {
        const m = await load();
        m.writeListenerRuntime('1.0.0');
        m.clearStaleListenerRuntime();
        expect(existsSync(m.LISTENER_PID_FILE)).toBe(true);
    });

    it('clears the stamps of a dead one', async () => {
        const m = await load();
        m.writeListenerRuntime('1.0.0');
        writeFileSync(m.LISTENER_PID_FILE, String(await deadPid()));
        m.clearStaleListenerRuntime();
        expect(existsSync(m.LISTENER_PID_FILE)).toBe(false);
        expect(existsSync(m.LISTENER_VERSION_FILE)).toBe(false);
    });
});

describe('stopListener', () => {
    it('kills a live listener and waits for it to be gone', async () => {
        const m = await load();
        const { pid, exited } = livePid();
        m.writeListenerRuntime('1.0.0');
        writeFileSync(m.LISTENER_PID_FILE, String(pid));
        expect(await m.stopListener(pid)).toBe(true);
        await exited;
        expect(() => process.kill(pid, 0)).toThrow();
        // A stop clears the slot so the next start isn't blocked by it.
        expect(existsSync(m.LISTENER_PID_FILE)).toBe(false);
    });

    it('succeeds when the process is already gone', async () => {
        const m = await load();
        expect(await m.stopListener(await deadPid())).toBe(true);
    });
});
