import { afterEach, describe, expect, it, vi } from 'vitest';

// Cross-repo contract: this read-only `listenerDeviceId()` MUST equal what
// `listener.ts computeListenerDeviceId()` registers for the same machine —
// otherwise a hook/notify tagged with it lands in the Streams feed but never
// threads into the agent chat (the drift this guards). It once regressed in
// zeph-hook.ts, which seeded the id from the hostname instead of the machine id.
//
// The golden constants are hardcoded so a change to EITHER the seed source or
// the hash breaks the test. listener.test.ts + mcp-server assert the same
// `dev_listener_a8d5d472` for the same machine seed.
const GOLDEN_MACHINE_ID = 'dev_listener_a8d5d472'; // dev_listener_<sha8('ZEPH-TEST-MACHINE-ID-0001')>
const GOLDEN_HOSTNAME = 'dev_listener_fb6ec4d5'; //   dev_listener_<sha8('zeph-test-host')>

const io = vi.hoisted(() => ({
    execFileSync: vi.fn(),
    readFileSync: vi.fn(),
    hostname: vi.fn(),
}));

vi.mock('node:child_process', async (importOriginal) => ({
    ...(await importOriginal<typeof import('node:child_process')>()),
    execFileSync: (...args: unknown[]) => io.execFileSync(...args),
}));
vi.mock('node:fs', async (importOriginal) => ({
    ...(await importOriginal<typeof import('node:fs')>()),
    readFileSync: (...args: unknown[]) => io.readFileSync(...args),
}));
vi.mock('node:os', async (importOriginal) => ({
    ...(await importOriginal<typeof import('node:os')>()),
    hostname: () => io.hostname(),
}));

afterEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
});

describe('listenerDeviceId (must match listener computeListenerDeviceId)', () => {
    it('hashes the platform machine id when one is readable', async () => {
        // Cover both platforms: macOS ioreg IOPlatformUUID + Linux /etc/machine-id.
        io.execFileSync.mockReturnValue('  "IOPlatformUUID" = "ZEPH-TEST-MACHINE-ID-0001"\n');
        io.readFileSync.mockImplementation((p: string) => {
            if (p === '/etc/machine-id') return 'ZEPH-TEST-MACHINE-ID-0001';
            throw new Error('ENOENT');
        });
        const { listenerDeviceId } = await import('./listener-device-id.js');
        expect(listenerDeviceId()).toBe(GOLDEN_MACHINE_ID);
    });

    it('falls back to a hostname hash when no machine id or sticky file exists', async () => {
        io.execFileSync.mockImplementation(() => {
            throw new Error('no ioreg');
        });
        io.readFileSync.mockImplementation(() => {
            throw new Error('ENOENT');
        });
        io.hostname.mockReturnValue('zeph-test-host');
        const { listenerDeviceId } = await import('./listener-device-id.js');
        expect(listenerDeviceId()).toBe(GOLDEN_HOSTNAME);
    });
});
