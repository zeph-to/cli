import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { createServer, request as httpRequest, type IncomingHttpHeaders, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startLanReceiver, type LanReceiver } from './lan-receiver.js';
import { pickLanTarget, tryLanDelivery, type LanTarget } from './lan-sender.js';
import { deriveLanSharedSecret, getDevicePublicKey, initDeviceCrypto, unwrapDeviceKey } from './crypto.js';
import { createTestSender, type TestSender } from '../tests/helpers/lan-sender.js';

// Sender and receiver as they run: `tryLanDelivery` (byte-exact in the MCP
// server) against a real `LanReceiver` on loopback, real P-256 keys on both
// ends. What matters is the one promise the sender makes its caller — it
// says `delivered` only when the bytes are on the receiver's disk, and
// every other outcome is a `reason` the caller answers with the relay.

const ME = 'dev_listener_me';
let receiver: LanReceiver;
let landing: string;
let sender: TestSender;
let target: LanTarget;
const registry = new Map<string, string>();

beforeAll(async () => {
    await initDeviceCrypto();
    const receiverPublicKey = getDevicePublicKey() ?? '';
    sender = await createTestSender('dev_mcp_sender', receiverPublicKey);
    registry.set(sender.deviceId, sender.publicKey);
    landing = mkdtempSync(join(tmpdir(), 'zeph-lan-int-'));
    receiver = await startLanReceiver({
        log: () => undefined,
        deviceId: () => ME,
        lookupSenderPublicKey: async (id) => registry.get(id) ?? null,
        deriveSharedSecret: deriveLanSharedSecret,
        unwrapFileKey: unwrapDeviceKey,
        landingDir: () => landing,
    });
    target = { deviceId: ME, publicKey: receiverPublicKey, host: '127.0.0.1', port: receiver.port };
});
afterAll(async () => { await receiver.stop(); });

const sealFile = async (text: string, fileName = 'report.txt') => {
    const plain = Buffer.from(text);
    // The MCP seals for every keyed device on the account, not just the target.
    const other = await createTestSender('dev_phone', getDevicePublicKey() ?? '');
    const env = await sender.seal(plain, [
        { deviceId: other.deviceId, publicKey: other.publicKey },
        { deviceId: ME, publicKey: getDevicePublicKey() ?? '' },
    ]);
    return { plain, file: { fileName, fileType: 'text/plain', fileSize: plain.length, iv: env.iv, deviceKeyMap: env.deviceKeyMap, ciphertext: env.ciphertext } };
};

const deliver = (file: Awaited<ReturnType<typeof sealFile>>['file'], overrides: Partial<Parameters<typeof tryLanDelivery>[0]> = {}) =>
    tryLanDelivery({ target, senderDeviceId: sender.deviceId, deriveSharedSecret: sender.deriveSharedSecret, file, ...overrides });

/** An HTTP server that says all the right status codes and proves nothing. */
const impostor = async (): Promise<{ port: number; close: () => Promise<void>; uploads: () => number }> => {
    let uploads = 0;
    const server: Server = createServer((req, res) => {
        req.resume();
        if (req.url?.endsWith('/ping')) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ deviceId: ME })); return; }
        uploads++;
        res.statusCode = 201;
        res.end(JSON.stringify({ transferId: 'whatever' }));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    return { port, uploads: () => uploads, close: () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); }) };
};

/**
 * A host in the middle: the ping goes through to the real receiver (so its
 * receipt is genuine), and the upload is answered by `onUpload` instead.
 */
const passThrough = async (onUpload: (res: import('node:http').ServerResponse) => void): Promise<{ port: number; close: () => Promise<void> }> => {
    const server: Server = createServer((req, res) => {
        if (!req.url?.endsWith('/ping')) { req.resume(); onUpload(res); return; }
        const upstream = httpRequest({ host: '127.0.0.1', port: receiver.port, path: req.url, method: req.method, headers: req.headers as IncomingHttpHeaders }, (up) => {
            res.writeHead(up.statusCode ?? 502, up.headers);
            up.pipe(res);
        });
        req.pipe(upstream);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const address = server.address();
    return {
        port: typeof address === 'object' && address ? address.port : 0,
        close: () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); }),
    };
};

/** Writes forever — a response body that never ends. */
const endless = (res: import('node:http').ServerResponse): void => {
    const chunk = Buffer.alloc(64 * 1024, 0x61);
    const pump = (): void => { while (!res.destroyed && res.write(chunk)); if (!res.destroyed) res.once('drain', pump); };
    res.on('close', () => res.removeAllListeners('drain'));
    pump();
};

describe('tryLanDelivery → LanReceiver', () => {
    it('delivers: the decrypted bytes are in the landing zone under the transferId it returns', async () => {
        const { plain, file } = await sealFile('quarterly numbers, over the LAN');
        const result = await deliver(file);
        expect(result).toEqual({ delivered: true, transferId: expect.stringMatching(/^lt_[0-9a-f]{24}$/) });
        if (!result.delivered) return;
        expect(readFileSync(join(landing, result.transferId, 'report.txt')).equals(plain)).toBe(true);
    });

    it('a sender the receiver does not know is refused at the ping, and nothing is uploaded', async () => {
        const stranger = await createTestSender('dev_stranger', getDevicePublicKey() ?? '');
        const { file } = await sealFile('never lands', 'stranger.txt');
        const before = readdirSync(landing).length;
        const result = await deliver(file, { senderDeviceId: stranger.deviceId, deriveSharedSecret: stranger.deriveSharedSecret });
        expect(result).toEqual({ delivered: false, reason: 'ping answered 401' });
        expect(readdirSync(landing)).toHaveLength(before);
    });

    it('an address that now belongs to another device (stale record) stops at the ping', async () => {
        const { file } = await sealFile('wrong machine');
        const result = await deliver(file, { target: { ...target, deviceId: 'dev_listener_other' } });
        // Same receiver key here, so the receipt holds; the deviceId in the answer is what catches it.
        expect(result).toEqual({ delivered: false, reason: 'ping answered by another device' });
    });

    it('a host that answers 200 and 201 without a receipt is not a delivery — the relay still runs', async () => {
        const fake = await impostor();
        try {
            const { file } = await sealFile('spoofed');
            const result = await deliver(file, { target: { ...target, port: fake.port } });
            expect(result).toEqual({ delivered: false, reason: 'ping answered without a valid receipt' });
            expect(fake.uploads()).toBe(0);   // the ciphertext never went to it
        } finally {
            await fake.close();
        }
    });

    it('a host in the middle that passes the ping through and answers the upload itself is not a delivery', async () => {
        const mitm = await passThrough((res) => { res.statusCode = 201; res.end(JSON.stringify({ transferId: 'whatever' })); });
        try {
            const { file } = await sealFile('intercepted');
            const result = await deliver(file, { target: { ...target, port: mitm.port } });
            expect(result).toEqual({ delivered: false, reason: 'upload answered without a valid receipt' });
        } finally {
            await mitm.close();
        }
    });

    it('a response body that never ends does not hold the sender: decided on headers, body dropped', async () => {
        const mitm = await passThrough((res) => { res.writeHead(201, { 'content-type': 'application/json' }); endless(res); });
        try {
            const { file } = await sealFile('endless');
            const started = Date.now();
            const result = await deliver(file, { target: { ...target, port: mitm.port }, uploadTimeoutMs: 10_000 });
            expect(result).toEqual({ delivered: false, reason: 'upload answered without a valid receipt' });
            expect(Date.now() - started).toBeLessThan(2_000);
        } finally {
            await mitm.close();
        }
    });

    it('a caller that gives up cancels the transfer, and the reason says so', async () => {
        const controller = new AbortController();
        const silent: Server = createServer(() => undefined);
        await new Promise<void>((r) => silent.listen(0, '127.0.0.1', r));
        const address = silent.address();
        try {
            const { file } = await sealFile('abandoned');
            const pending = deliver(file, { target: { ...target, port: typeof address === 'object' && address ? address.port : 0 }, signal: controller.signal });
            setTimeout(() => controller.abort(), 50);
            expect(await pending).toEqual({ delivered: false, reason: 'cancelled' });
        } finally {
            silent.closeAllConnections();
            await new Promise<void>((r) => silent.close(() => r()));
        }
    });

    it('nothing listening, or a host that never answers, fails within the ping budget', async () => {
        const fake = await impostor();
        const closedPort = fake.port;
        await fake.close();
        const { file } = await sealFile('nobody home');
        const refused = await deliver(file, { target: { ...target, port: closedPort } });
        expect(refused.delivered).toBe(false);
        expect((refused as { reason: string }).reason).toMatch(/^ping failed: /);

        const silent: Server = createServer(() => undefined);   // accepts, never responds
        await new Promise<void>((r) => silent.listen(0, '127.0.0.1', r));
        const address = silent.address();
        const started = Date.now();
        try {
            const hung = await deliver(file, { target: { ...target, port: typeof address === 'object' && address ? address.port : 0 }, pingTimeoutMs: 200 });
            expect(hung).toEqual({ delivered: false, reason: 'ping failed: timed out' });
            expect(Date.now() - started).toBeLessThan(1_000);
        } finally {
            silent.closeAllConnections();
            await new Promise<void>((r) => silent.close(() => r()));
        }
    });

    it('a file over the receiver cap is refused with a status, not a hang, and leaves nothing', async () => {
        const small = await startLanReceiver({
            log: () => undefined, deviceId: () => ME,
            lookupSenderPublicKey: async (id) => registry.get(id) ?? null,
            deriveSharedSecret: deriveLanSharedSecret, unwrapFileKey: unwrapDeviceKey,
            landingDir: () => landing, maxBodyBytes: 1024,
        });
        try {
            const { file } = await sealFile('x'.repeat(2 * 1024 * 1024), 'big.txt');
            const result = await deliver(file, { target: { ...target, port: small.port } });
            expect(result).toEqual({ delivered: false, reason: 'upload answered 413' });
            expect(readdirSync(landing).some((d) => existsSync(join(landing, d, 'big.txt')))).toBe(false);
        } finally {
            await small.stop();
        }
    });
});

describe('pickLanTarget', () => {
    const device = { deviceId: 'dev_mac', publicKey: 'PK', isOnline: true, lan: { host: '192.168.1.20', port: 51234 } };

    it('picks the single target when it has a key, an endpoint and a connection', () => {
        expect(pickLanTarget([{ deviceId: 'dev_phone', publicKey: 'X' }, device], 'dev_mac')).toEqual({ deviceId: 'dev_mac', publicKey: 'PK', host: '192.168.1.20', port: 51234 });
    });

    it('no target (a broadcast), an unknown one, or one missing any of the three → relay', () => {
        expect(pickLanTarget([device], undefined)).toBeNull();
        expect(pickLanTarget([device], 'dev_gone')).toBeNull();
        expect(pickLanTarget([{ ...device, publicKey: undefined }], 'dev_mac')).toBeNull();
        expect(pickLanTarget([{ ...device, isOnline: false }], 'dev_mac')).toBeNull();
        expect(pickLanTarget([{ ...device, isOnline: undefined }], 'dev_mac')).toBeNull();
        expect(pickLanTarget([{ ...device, lan: null }], 'dev_mac')).toBeNull();
        expect(pickLanTarget([{ ...device, lan: { host: '192.168.1.20', port: '51234' } }], 'dev_mac')).toBeNull();
        expect(pickLanTarget([{ ...device, lan: { host: '', port: 51234 } }], 'dev_mac')).toBeNull();
    });
});
