import { describe, expect, it } from 'vitest';
import { LISTENER_PRESENCE, createDeviceKeyRegistration } from './device-presence.js';

// Without its key on the device record the machine is invisible to every
// sender that encrypts. What matters: only the public half goes out, it
// rides the socket (the HTTP device route is JWT-only, this daemon has an
// API key), a failure never throws into the socket's open handler, and a
// flapping socket does not become a burst of frames.

const harness = (opts: { sendReturns?: boolean; keyError?: Error } = {}) => {
    const sent: object[] = [];
    const logs: string[] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => { release = r; });
    let gated = false;
    const reg = createDeviceKeyRegistration({
        log: (m) => logs.push(m),
        send: (msg) => { sent.push(msg); return opts.sendReturns ?? true; },
        publicKey: async () => {
            if (opts.keyError) throw opts.keyError;
            if (gated) await gate;
            return 'PUBKEY';
        },
    });
    return { reg, sent, logs, hold: () => { gated = true; }, release: () => release() };
};

describe('createDeviceKeyRegistration', () => {
    it('sends the public key, and nothing else, on the presence message', async () => {
        const h = harness();
        expect(await h.reg.onOpen()).toBe(true);
        expect(h.sent).toEqual([{ type: LISTENER_PRESENCE, data: { publicKey: 'PUBKEY' } }]);
    });

    it('registers again on every open — a recreated record has lost its key', async () => {
        const h = harness();
        await h.reg.onOpen();
        await h.reg.onOpen();
        expect(h.sent).toHaveLength(2);
    });

    it('opens that overlap share one frame', async () => {
        const h = harness();
        h.hold();
        const a = h.reg.onOpen();
        const b = h.reg.onOpen();
        h.release();
        expect(await Promise.all([a, b])).toEqual([true, true]);
        expect(h.sent).toHaveLength(1);
    });

    it('a socket that is gone, or a key that will not load, is logged and resolves false', async () => {
        const offline = harness({ sendReturns: false });
        expect(await offline.reg.onOpen()).toBe(false);
        expect(offline.logs).toEqual(['device key: not registered — no connection right now, retried at the next open']);

        const noKey = harness({ keyError: new Error('EACCES') });
        expect(await noKey.reg.onOpen()).toBe(false);
        expect(noKey.sent).toHaveLength(0);
        expect(noKey.logs).toEqual(['device key: registration failed — EACCES']);
    });
});
