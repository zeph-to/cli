import { describe, expect, it } from 'vitest';
import { createDeviceKeyRegistration } from './device-key-registration.js';

// Without its key on the device record the machine is invisible to every
// sender that encrypts. What matters: the key (and only the public half)
// goes to this device's record, a failure never throws into the socket's
// open handler, and a flapping socket does not become a burst of PUTs.

const harness = (opts: { status?: number; keyError?: Error; fetchError?: Error } = {}) => {
    const calls: { url: string; init: RequestInit }[] = [];
    const logs: string[] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => { release = r; });
    let gated = false;
    const reg = createDeviceKeyRegistration({
        deviceId: 'dev_listener_ab12cd34', apiKey: 'zk', baseUrl: 'https://api.example/v1/', log: (m) => logs.push(m),
        publicKey: async () => { if (opts.keyError) throw opts.keyError; return 'PUBKEY'; },
        fetchFn: async (url, init) => {
            calls.push({ url: String(url), init: init ?? {} });
            if (gated) await gate;
            if (opts.fetchError) throw opts.fetchError;
            return new Response('{}', { status: opts.status ?? 200 });
        },
    });
    return { reg, calls, logs, hold: () => { gated = true; }, release: () => release() };
};

describe('createDeviceKeyRegistration', () => {
    it('PUTs the public key, and nothing else, to this device record', async () => {
        const h = harness();
        expect(await h.reg.onOpen()).toBe(true);
        expect(h.calls).toHaveLength(1);
        expect(h.calls[0].url).toBe('https://api.example/v1/devices/dev_listener_ab12cd34');
        expect(h.calls[0].init.method).toBe('PUT');
        expect(JSON.parse(String(h.calls[0].init.body))).toEqual({ publicKey: 'PUBKEY' });
        expect((h.calls[0].init.headers as Record<string, string>)['X-API-Key']).toBe('zk'); // fixture: the module passes a plain object
    });

    it('registers again on every open — a recreated record has lost its key', async () => {
        const h = harness();
        await h.reg.onOpen();
        await h.reg.onOpen();
        expect(h.calls).toHaveLength(2);
    });

    it('opens that overlap share one PUT', async () => {
        const h = harness();
        h.hold();
        const a = h.reg.onOpen();
        const b = h.reg.onOpen();
        h.release();
        expect(await Promise.all([a, b])).toEqual([true, true]);
        expect(h.calls).toHaveLength(1);
    });

    it('a rejected PUT, a network failure, or a key that will not load is logged and resolves false', async () => {
        const rejected = harness({ status: 404 });
        expect(await rejected.reg.onOpen()).toBe(false);
        expect(rejected.logs).toEqual(['device key: registration rejected (404) — encrypted pushes skip this machine until the next connect']);

        const offline = harness({ fetchError: new Error('ECONNREFUSED') });
        expect(await offline.reg.onOpen()).toBe(false);
        expect(offline.logs).toEqual(['device key: registration failed — ECONNREFUSED']);

        const noKey = harness({ keyError: new Error('EACCES') });
        expect(await noKey.reg.onOpen()).toBe(false);
        expect(noKey.calls).toHaveLength(0);
        expect(noKey.logs).toEqual(['device key: registration failed — EACCES']);
    });
});
