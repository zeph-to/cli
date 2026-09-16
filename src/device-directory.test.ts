import { describe, expect, it } from 'vitest';
import { createDeviceDirectory } from './device-directory.js';

// The directory decides who may upload to this machine. What matters: a
// registered device is found, an unknown one is not, and neither a burst
// of uploads nor a stranger probing ids turns into a burst of API calls.

const harness = (devices: { deviceId: string; publicKey?: string }[], opts: { status?: number } = {}) => {
    let calls = 0;
    let t = 1_000_000;
    const logs: string[] = [];
    const dir = createDeviceDirectory({
        apiKey: 'zk', baseUrl: 'https://api.example/v1/', log: (m) => logs.push(m),
        fetchFn: async (url, init) => {
            calls++;
            expect(String(url)).toBe('https://api.example/v1/devices');
            expect((init?.headers as Record<string, string>)['X-API-Key']).toBe('zk'); // fixture: the directory passes a plain object
            return new Response(JSON.stringify({ data: devices }), { status: opts.status ?? 200 });
        },
        now: () => t, ttlMs: 60_000, refreshMinMs: 10_000,
    });
    return { dir, calls: () => calls, advance: (ms: number) => { t += ms; }, logs };
};

describe('createDeviceDirectory', () => {
    it('finds a registered device and caches the list for the TTL', async () => {
        const h = harness([{ deviceId: 'dev_a', publicKey: 'PKA' }, { deviceId: 'dev_nokey' }]);
        expect(await h.dir.publicKeyOf('dev_a')).toBe('PKA');
        expect(await h.dir.publicKeyOf('dev_a')).toBe('PKA');
        expect(h.calls()).toBe(1);
        expect(await h.dir.publicKeyOf('dev_nokey')).toBeNull();   // registered without a key = cannot be authenticated
    });

    it('a miss refetches once, then not again within refreshMinMs — probing unknown ids does not drive the API', async () => {
        const h = harness([{ deviceId: 'dev_a', publicKey: 'PKA' }]);
        await h.dir.publicKeyOf('dev_a');
        expect(await h.dir.publicKeyOf('dev_zzz')).toBeNull();
        expect(await h.dir.publicKeyOf('dev_yyy')).toBeNull();
        expect(h.calls()).toBe(1);
        h.advance(10_001);
        expect(await h.dir.publicKeyOf('dev_zzz')).toBeNull();
        expect(h.calls()).toBe(2);
    });

    it('refetches after the TTL even on a hit, so a revoked device stops being accepted', async () => {
        const h = harness([{ deviceId: 'dev_a', publicKey: 'PKA' }]);
        await h.dir.publicKeyOf('dev_a');
        h.advance(60_001);
        await h.dir.publicKeyOf('dev_a');
        expect(h.calls()).toBe(2);
    });

    it('a failed fetch is logged, answers from what it has, and is not retried before refreshMinMs', async () => {
        const h = harness([], { status: 500 });
        expect(await h.dir.publicKeyOf('dev_a')).toBeNull();
        expect(await h.dir.publicKeyOf('dev_b')).toBeNull();
        expect(h.calls()).toBe(1);
        expect(h.logs).toEqual(['local transfer: device list unavailable — devices 500']);
        h.advance(10_001);
        await h.dir.publicKeyOf('dev_a');
        expect(h.calls()).toBe(2);
    });

    it('concurrent misses share one fetch', async () => {
        const h = harness([{ deviceId: 'dev_a', publicKey: 'PKA' }]);
        const [a, b] = await Promise.all([h.dir.publicKeyOf('dev_a'), h.dir.publicKeyOf('dev_a')]);
        expect([a, b]).toEqual(['PKA', 'PKA']);
        expect(h.calls()).toBe(1);
    });
});
