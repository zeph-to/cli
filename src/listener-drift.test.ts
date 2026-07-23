import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VERSION } from './config.js';

// The incident this guards: `npm i -g @zeph-to/cli` replaced the package but
// the daemon kept running the old build for a full day, answering pushes
// (so chat worked) while ignoring `agent.stream.start` entirely — the phone's
// live terminal just spun. Only a machine reboot cleared it. `zeph cc` now
// notices the drift and swaps the daemon out.
const proc = vi.hoisted(() => ({
    runningListenerPid: vi.fn<() => number | null>(() => null),
    runningListenerVersion: vi.fn<() => string | null>(() => null),
    stopListener: vi.fn(async () => true),
    spawnListenerDetached: vi.fn(() => true),
}));

vi.mock('./listener-process.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('./listener-process.js')>()),
    runningListenerPid: () => proc.runningListenerPid(),
    runningListenerVersion: () => proc.runningListenerVersion(),
    stopListener: (pid: number) => proc.stopListener(pid),
    spawnListenerDetached: () => proc.spawnListenerDetached(),
}));

const { ensureListenerRunning, listenerVersionDrifted } = await import('./wrapper.js');

beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
    proc.runningListenerPid.mockReturnValue(null);
    proc.runningListenerVersion.mockReturnValue(null);
    proc.spawnListenerDetached.mockReturnValue(true);
});

describe('listenerVersionDrifted', () => {
    it('is true when the installed package is newer than the daemon', () => {
        expect(listenerVersionDrifted('1.25.0', '1.26.0')).toBe(true);
    });

    it('is false when they match', () => {
        expect(listenerVersionDrifted('1.26.0', '1.26.0')).toBe(false);
    });

    // Several installs on one account (nvm node versions, a repo build next
    // to the global one) would otherwise kill and respawn each other's daemon
    // on every `zeph cc` — and downgrading a healthy newer daemon reopens the
    // gap this whole check exists to close.
    it('leaves a daemon newer than the caller alone', () => {
        expect(listenerVersionDrifted('1.26.0', '1.25.0')).toBe(false);
        expect(listenerVersionDrifted('1.26.0', '0.0.0-semantic-release')).toBe(false);
    });

    // No stamp ⇒ the daemon booted from a build that predates stamping,
    // which is by definition older than anything that writes one.
    it('treats an unstamped daemon as drifted', () => {
        expect(listenerVersionDrifted(null, '1.26.0')).toBe(true);
    });
});

describe('ensureListenerRunning', () => {
    it('leaves a current daemon alone', async () => {
        proc.runningListenerPid.mockReturnValue(4242);
        proc.runningListenerVersion.mockReturnValue(VERSION);
        await ensureListenerRunning();
        expect(proc.stopListener).not.toHaveBeenCalled();
        expect(proc.spawnListenerDetached).not.toHaveBeenCalled();
    });

    // An unstamped daemon is the incident's shape: it booted from a build
    // that predates stamping, so it is stale by definition. (A concrete
    // older version can't be used here — VERSION is the unreplaced
    // semantic-release placeholder in a checkout, so nothing sorts below it.
    // The version comparison itself is covered above.)
    it('replaces a daemon left behind by an upgrade', async () => {
        proc.runningListenerPid.mockReturnValue(4242);
        proc.runningListenerVersion.mockReturnValue(null);
        await ensureListenerRunning();
        expect(proc.stopListener).toHaveBeenCalledWith(4242);
        expect(proc.spawnListenerDetached).toHaveBeenCalled();
    });

    // Order matters: two live daemons both answer the same pushes, so the
    // old one has to be confirmed gone before the new one starts.
    it('stops the old daemon before spawning the new one', async () => {
        proc.runningListenerPid.mockReturnValue(4242);
        proc.runningListenerVersion.mockReturnValue(null);
        await ensureListenerRunning();
        expect(proc.stopListener.mock.invocationCallOrder[0])
            .toBeLessThan(proc.spawnListenerDetached.mock.invocationCallOrder[0]);
    });

    it('autostarts when nothing is running', async () => {
        await ensureListenerRunning();
        expect(proc.stopListener).not.toHaveBeenCalled();
        expect(proc.spawnListenerDetached).toHaveBeenCalled();
    });

    // Non-fatal by design: `zeph cc` still has to launch the agent.
    it('reports a failed spawn without throwing', async () => {
        proc.spawnListenerDetached.mockReturnValue(false);
        await expect(ensureListenerRunning()).resolves.toBeUndefined();
        expect(console.error).toHaveBeenCalled();
    });
});
