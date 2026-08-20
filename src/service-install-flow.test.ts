import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * How the login-time service enters and leaves through `zeph install` /
 * `zeph uninstall`.
 *
 * The asymmetry is deliberate. An interactive install offers it and defaults
 * to yes — the empty-picker-after-reboot problem is exactly what a default
 * should fix. A scripted install (`--key`, CI, provisioning) must not plant a
 * LaunchAgent nobody asked for, so there it is opt-in.
 */
const svc = vi.hoisted(() => ({
    serviceSupported: vi.fn(() => true),
    serviceInstalled: vi.fn(() => false),
    uninstallService: vi.fn(async () => ({ ok: true, notes: [] as string[] })),
}));

vi.mock('./listener-service.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('./listener-service.js')>()),
    serviceSupported: () => svc.serviceSupported(),
    serviceInstalled: () => svc.serviceInstalled(),
    uninstallService: () => svc.uninstallService(),
}));

const { serviceInstallChoice } = await import('./installer.js');
const { removeServiceStep } = await import('./uninstall.js');

const originalHome = process.env.HOME;
let TMP: string;

beforeEach(() => {
    TMP = mkdtempSync(join(tmpdir(), 'zeph-svc-flow-'));
    process.env.HOME = TMP;
    vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
    rmSync(TMP, { recursive: true, force: true });
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    vi.clearAllMocks();
    vi.restoreAllMocks();
    svc.serviceSupported.mockReturnValue(true);
    svc.serviceInstalled.mockReturnValue(false);
});

describe('serviceInstallChoice', () => {
    it('offers it in an interactive install', () => {
        expect(serviceInstallChoice({}, false)).toBe('ask');
    });

    // A provisioning script that happens to run `zeph install --key ...`
    // should not end up with a LaunchAgent it never mentioned.
    it('stays out of a scripted install unless asked', () => {
        expect(serviceInstallChoice({ key: 'abc' }, true)).toBe('no');
    });

    it('installs without asking when --service is passed', () => {
        expect(serviceInstallChoice({ service: true }, true)).toBe('yes');
    });

    it('honours --no-service over everything else', () => {
        expect(serviceInstallChoice({ service: true, 'no-service': true }, false)).toBe('no');
    });

    it('never offers it where launchd does not exist', () => {
        svc.serviceSupported.mockReturnValue(false);
        expect(serviceInstallChoice({}, false)).toBe('no');
        expect(serviceInstallChoice({ service: true }, true)).toBe('no');
    });
});

describe('removeServiceStep', () => {
    it('reports nothing to do when no service is installed', async () => {
        expect(await removeServiceStep(false)).toBeNull();
        expect(svc.uninstallService).not.toHaveBeenCalled();
    });

    it('removes an installed service', async () => {
        svc.serviceInstalled.mockReturnValue(true);
        const line = await removeServiceStep(false);
        expect(svc.uninstallService).toHaveBeenCalled();
        expect(line).toMatch(/removed/);
    });

    // --dry-run has to be a real dry run: the point of the flag is that a user
    // can see what uninstall would do without losing the service to find out.
    it('changes nothing on a dry run', async () => {
        svc.serviceInstalled.mockReturnValue(true);
        const line = await removeServiceStep(true);
        expect(svc.uninstallService).not.toHaveBeenCalled();
        expect(line).toMatch(/would remove/);
    });

    it('surfaces a launchd failure instead of claiming success', async () => {
        svc.serviceInstalled.mockReturnValue(true);
        svc.uninstallService.mockResolvedValueOnce({ ok: false, reason: 'bootout denied', notes: [] } as never);
        expect(await removeServiceStep(false)).toMatch(/bootout denied/);
    });
});
