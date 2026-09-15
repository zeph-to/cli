import { describe, expect, it } from 'vitest';
import { startLanReceiver } from './lan-receiver.js';

// Slice 02 only binds the socket so the listener has a real port to publish;
// the upload routes arrive with slice 04. Until then every request is a 404,
// which is also what an unauthenticated probe must keep seeing later.

describe('startLanReceiver', () => {
    it('binds an OS-assigned port on all interfaces and answers 404 until routes exist', async () => {
        const logs: string[] = [];
        const receiver = await startLanReceiver({ log: (m) => logs.push(m) });
        try {
            expect(receiver.port).toBeGreaterThan(1023);
            expect(receiver.port).toBeLessThanOrEqual(65535);
            const res = await fetch(`http://127.0.0.1:${receiver.port}/anything`);
            expect(res.status).toBe(404);
            expect(logs.some((l) => /local transfer: listening on .*:\d+/.test(l))).toBe(true);
        } finally {
            await receiver.stop();
        }
    });

    it('stop() releases the port and is idempotent', async () => {
        const receiver = await startLanReceiver({ log: () => undefined });
        await receiver.stop();
        await receiver.stop();
        await expect(fetch(`http://127.0.0.1:${receiver.port}/`)).rejects.toThrow();
    });
});
