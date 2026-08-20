import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// `zeph listener --stop|--restart` is the supported way to replace a stale
// daemon. It must short-circuit before verifyTmux (stopping a daemon can't
// depend on a healthy tmux) and must never leave two listeners racing for the
// same pushes — so the restart path stops first, then spawns.
const proc = vi.hoisted(() => ({
    runningListenerPid: vi.fn<() => number | null>(() => null),
    stopListener: vi.fn(async () => true),
    spawnListenerDetached: vi.fn(() => true),
    clearStaleListenerRuntime: vi.fn(),
}));

const svc = vi.hoisted(() => ({
    installService: vi.fn(async () => ({ ok: true, notes: [] as string[] })),
    uninstallService: vi.fn(async () => ({ ok: true, notes: [] as string[] })),
    serviceStatus: vi.fn(() => ({
        supported: true,
        installed: false,
        label: 'to.zeph.listener',
        plistPath: '/tmp/to.zeph.listener.plist',
        nodePath: null as string | null,
        cliPath: null as string | null,
        pathEnv: null as string | null,
        missing: [] as string[],
    })),
}));

vi.mock('./listener-service.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('./listener-service.js')>()),
    installService: () => svc.installService(),
    uninstallService: () => svc.uninstallService(),
    serviceStatus: () => svc.serviceStatus(),
}));

vi.mock('./listener-process.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('./listener-process.js')>()),
    runningListenerPid: () => proc.runningListenerPid(),
    stopListener: (pid: number) => proc.stopListener(pid),
    spawnListenerDetached: () => proc.spawnListenerDetached(),
    clearStaleListenerRuntime: () => proc.clearStaleListenerRuntime(),
}));

const { handleListener } = await import('./listener.js');

beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
    proc.runningListenerPid.mockReturnValue(null);
    proc.spawnListenerDetached.mockReturnValue(true);
});

describe('zeph listener --stop', () => {
    it('stops the running daemon without respawning it', async () => {
        proc.runningListenerPid.mockReturnValue(4242);
        expect(await handleListener({ stop: true })).toBe(0);
        expect(proc.stopListener).toHaveBeenCalledWith(4242);
        expect(proc.spawnListenerDetached).not.toHaveBeenCalled();
    });

    it('clears a crashed daemon’s stamps when nothing is running', async () => {
        expect(await handleListener({ stop: true })).toBe(0);
        expect(proc.stopListener).not.toHaveBeenCalled();
        expect(proc.clearStaleListenerRuntime).toHaveBeenCalled();
    });

    // Our own pid in the file is not "another listener" — killing it would
    // mean the command shooting itself.
    it('ignores a pid file pointing at this process', async () => {
        proc.runningListenerPid.mockReturnValue(process.pid);
        expect(await handleListener({ stop: true })).toBe(0);
        expect(proc.stopListener).not.toHaveBeenCalled();
    });
});

describe('zeph listener --restart', () => {
    it('stops the old daemon before spawning the new one', async () => {
        proc.runningListenerPid.mockReturnValue(4242);
        expect(await handleListener({ restart: true })).toBe(0);
        expect(proc.stopListener).toHaveBeenCalledWith(4242);
        expect(proc.spawnListenerDetached).toHaveBeenCalled();
        expect(proc.stopListener.mock.invocationCallOrder[0])
            .toBeLessThan(proc.spawnListenerDetached.mock.invocationCallOrder[0]);
    });

    it('starts one even when nothing was running', async () => {
        expect(await handleListener({ restart: true })).toBe(0);
        expect(proc.spawnListenerDetached).toHaveBeenCalled();
    });

    it('fails loudly when the cli entry cannot be resolved', async () => {
        proc.spawnListenerDetached.mockReturnValue(false);
        expect(await handleListener({ restart: true })).toBe(1);
    });
});

// The login-time service is what stops a reboot from emptying the phone's
// picker. Its flags must route before verifyTmux and before anything that
// would start a daemon in *this* process.
describe('zeph listener service flags', () => {
    it('installs the service without starting a daemon here', async () => {
        expect(await handleListener({ 'install-service': true })).toBe(0);
        expect(svc.installService).toHaveBeenCalled();
        expect(proc.spawnListenerDetached).not.toHaveBeenCalled();
    });

    // A failed install must be a non-zero exit: the whole point of the
    // post-install check is that a silent failure looks identical to success.
    it('reports a failed install as an error exit', async () => {
        svc.installService.mockResolvedValueOnce({ ok: false, reason: 'tmux not found', notes: [] } as never);
        expect(await handleListener({ 'install-service': true })).toBe(1);
    });

    it('removes the service on --uninstall-service', async () => {
        expect(await handleListener({ 'uninstall-service': true })).toBe(0);
        expect(svc.uninstallService).toHaveBeenCalled();
    });

    it('reports when no service is installed', async () => {
        expect(await handleListener({ 'service-status': true })).toBe(0);
        expect(svc.serviceStatus).toHaveBeenCalled();
    });

    // Registered but pointing at a node that a version upgrade removed. The
    // job still shows in `launchctl list`, so the exit code is the signal.
    it('exits non-zero when the installed service points at something gone', async () => {
        svc.serviceStatus.mockReturnValueOnce({
            supported: true,
            installed: true,
            label: 'to.zeph.listener',
            plistPath: '/tmp/to.zeph.listener.plist',
            nodePath: '/gone/node',
            cliPath: '/tmp/cli.js',
            pathEnv: '/usr/bin',
            missing: ['/gone/node'],
        });
        expect(await handleListener({ 'service-status': true })).toBe(1);
    });
});
