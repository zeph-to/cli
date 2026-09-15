import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { connect, type Socket } from 'node:net';
import { startLanReceiver, type LanReceiver, type LanReceiverOptions } from './lan-receiver.js';
import { LAN_CLOCK_SKEW_MS, LAN_HEADERS, LAN_PATHS, createNonceRegistry, deriveLanKeys, sealMeta } from './lan-auth.js';
import { deriveLanSharedSecret, getDevicePublicKey, initDeviceCrypto, unwrapDeviceKey } from './crypto.js';
import { createTestSender, pingUrl, signPing, signUpload, uploadUrl, type TestSender } from '../tests/helpers/lan-sender.js';

// The receiver is the one thing on this machine that takes bytes from the
// network without the account server in between, so every refusal is
// pinned: what an unauthenticated probe sees (401, empty — whatever it
// tried), what a stranger with valid-looking headers sees, and what a real
// sender's replay, tampering and oversize attempts see — and that nothing
// lands on disk for any of them. The sender side is WebCrypto
// (tests/helpers), the same code shape the MCP server and the phones use.

const ME = 'dev_listener_me';
let receiver: LanReceiver;
let landing: string;
let logs: string[];
let sender: TestSender;
let stranger: TestSender;
const registry = new Map<string, string>();

const baseOptions = (): LanReceiverOptions => ({
    log: (m) => logs.push(m),
    deviceId: () => ME,
    lookupSenderPublicKey: async (id) => registry.get(id) ?? null,
    deriveSharedSecret: deriveLanSharedSecret,
    unwrapFileKey: unwrapDeviceKey,
    landingDir: () => landing,
    maxBodyBytes: 4096,
    maxInFlight: 2,
});

beforeAll(async () => {
    await initDeviceCrypto();
    const receiverPublicKey = getDevicePublicKey() ?? '';
    sender = await createTestSender('dev_mcp_sender', receiverPublicKey);
    stranger = await createTestSender('dev_stranger', receiverPublicKey);
    registry.set(sender.deviceId, sender.publicKey);   // the stranger is not on the account
    landing = mkdtempSync(join(tmpdir(), 'zeph-lan-landing-'));
    logs = [];
    receiver = await startLanReceiver(baseOptions());
});
afterAll(async () => { await receiver.stop(); });

const upload = (headers: Record<string, string>, body: Buffer, port = receiver.port) =>
    fetch(uploadUrl(port), { method: 'POST', headers, body });

const sealed = async (s: TestSender, text: string) => {
    const plain = Buffer.from(text);
    const env = await s.seal(plain, [{ deviceId: ME, publicKey: getDevicePublicKey() ?? '' }]);
    return { plain, env, meta: { fileName: 'note.txt', fileType: 'text/plain', fileSize: plain.length, iv: env.iv, deviceKeyMap: env.deviceKeyMap } };
};

/** Floods count requests, not sockets: kept under the receiver's connection cap. */
const inBatches = async <T>(jobs: (() => Promise<T>)[], size = 16): Promise<T[]> => {
    const out: T[] = [];
    for (let i = 0; i < jobs.length; i += size) out.push(...await Promise.all(jobs.slice(i, i + size).map((job) => job())));
    return out;
};

/** Headers + one byte, then silence: an upload that holds its slot. */
const holdUpload = (headers: Record<string, string>, body: Buffer, port = receiver.port) => {
    const req = httpRequest({ host: '127.0.0.1', port, method: 'POST', path: LAN_PATHS.upload, headers: { ...headers, 'content-length': String(body.length) } });
    req.on('error', () => undefined);   // destroyed below on purpose
    req.write(body.subarray(0, 1));
    return req;
};

describe('ping', () => {
    it('unauthenticated: 401 with an empty body — the LAN learns nothing', async () => {
        const res = await fetch(pingUrl(receiver.port));
        expect(res.status).toBe(401);
        expect(await res.text()).toBe('');
    });

    it('a registered sender gets {deviceId}', async () => {
        const res = await fetch(pingUrl(receiver.port), { headers: signPing(sender) });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ deviceId: ME });
    });

    it('a device not on the account is 401 even with well-formed, self-consistent headers', async () => {
        const res = await fetch(pingUrl(receiver.port), { headers: signPing(stranger) });
        expect(res.status).toBe(401);
        expect(await res.text()).toBe('');
    });

    it('a registered sender id with the wrong key (impersonation) is 401', async () => {
        const res = await fetch(pingUrl(receiver.port), { headers: signPing({ ...stranger, deviceId: sender.deviceId }) });
        expect(res.status).toBe(401);
    });

    it('a replayed nonce and a stale timestamp are 401', async () => {
        const headers = signPing(sender);
        expect((await fetch(pingUrl(receiver.port), { headers })).status).toBe(200);
        expect((await fetch(pingUrl(receiver.port), { headers })).status).toBe(401);
        const old = signPing(sender, { timestamp: Date.now() - LAN_CLOCK_SKEW_MS - 1000 });
        expect((await fetch(pingUrl(receiver.port), { headers: old })).status).toBe(401);
        const future = signPing(sender, { timestamp: Date.now() + LAN_CLOCK_SKEW_MS + 1000 });
        expect((await fetch(pingUrl(receiver.port), { headers: future })).status).toBe(401);
    });

    it('a ping signed as an upload (wrong transferId, or upload method/path in the MAC) is 401', async () => {
        expect((await fetch(pingUrl(receiver.port), { headers: signPing(sender, { transferId: 'tr_x' }) })).status).toBe(401);
        expect((await fetch(pingUrl(receiver.port), { headers: signPing(sender, { method: 'POST', path: LAN_PATHS.upload }) })).status).toBe(401);
    });

    it('other routes and methods are 404', async () => {
        expect((await fetch(`http://127.0.0.1:${receiver.port}/`)).status).toBe(404);
        expect((await fetch(pingUrl(receiver.port), { method: 'POST', headers: signPing(sender) })).status).toBe(404);
        expect((await fetch(uploadUrl(receiver.port), { headers: signPing(sender) })).status).toBe(404);
    });
});

describe('upload', () => {
    it('a sealed file from a registered sender lands decrypted in <landing>/<transferId>/<fileName>, 201', async () => {
        const { plain, env, meta } = await sealed(sender, 'hello over the LAN');
        const res = await upload(signUpload(sender, 'tr_ok_1', env.ciphertext, meta), env.ciphertext);
        expect(res.status).toBe(201);
        expect(await res.json()).toEqual({ transferId: 'tr_ok_1' });
        expect(readFileSync(join(landing, 'tr_ok_1', 'note.txt')).equals(plain)).toBe(true);
        expect(logs.some((l) => /received "note.txt" \(18B\) from dev_mcp_sender as tr_ok_1/.test(l))).toBe(true);
    });

    it('a duplicate transferId is 409 and the first file is untouched', async () => {
        const { env, meta } = await sealed(sender, 'second');
        const res = await upload(signUpload(sender, 'tr_ok_1', env.ciphertext, meta), env.ciphertext);
        expect(res.status).toBe(409);
        expect(readFileSync(join(landing, 'tr_ok_1', 'note.txt')).toString()).toBe('hello over the LAN');
    });

    it('an outsider sees 401 empty for everything — unknown sender, impersonation, oversize, bad meta, a transferId that exists — and nothing is written', async () => {
        const { env, meta } = await sealed(sender, 'x');
        const before = readdirSync(landing).length;
        const big = Buffer.alloc(4097);
        const cases: Record<string, string>[] = [
            { [LAN_HEADERS.meta]: 'e30=' },
            signUpload(stranger, 'tr_s', env.ciphertext, meta),
            signUpload({ ...stranger, deviceId: sender.deviceId }, 'tr_i', env.ciphertext, meta),
            signUpload(stranger, 'tr_big', big, meta),
            signUpload(stranger, 'tr_ok_1', env.ciphertext, meta),          // exists on disk: still not a 409 for an outsider
            signUpload(stranger, 'tr_m', env.ciphertext, meta, { rawMeta: 'garbage' }),
        ];
        for (const headers of cases) {
            const res = await upload(headers, headers === cases[3] ? big : env.ciphertext);
            expect(res.status).toBe(401);
            expect(await res.text()).toBe('');
        }
        expect(readdirSync(landing).length).toBe(before);
    });

    it('a body that does not match the MAC (tampered in flight) is refused and removed', async () => {
        const { env, meta } = await sealed(sender, 'tamper me');
        const headers = signUpload(sender, 'tr_tamper', env.ciphertext, meta);
        const bad = Buffer.from(env.ciphertext);
        bad[3] ^= 0xff;
        const res = await upload(headers, bad);
        // GCM catches it first (400) or the MAC does (401) — either way: refused, nothing kept.
        expect([400, 401]).toContain(res.status);
        expect(existsSync(join(landing, 'tr_tamper'))).toBe(false);
    });

    it('a MAC over a different body (right length, wrong bytes) is 401 and the nonce is not spent', async () => {
        const { env, meta } = await sealed(sender, 'mac me');
        const other = Buffer.alloc(env.ciphertext.length, 7);
        const headers = signUpload(sender, 'tr_mac', other, meta);   // MAC binds `other`, we send the real ciphertext
        expect((await upload(headers, env.ciphertext)).status).toBe(401);
        expect(existsSync(join(landing, 'tr_mac'))).toBe(false);
        // The same nonce with the body the MAC actually binds: GCM fails (wrong ciphertext) but the nonce was free to try.
        expect((await upload(headers, other)).status).toBe(400);
    });

    it('a captured upload replayed after the file was claimed is 401 — the nonce is spent, not the transfer dir', async () => {
        const { env, meta } = await sealed(sender, 'replay me');
        const headers = signUpload(sender, 'tr_replay', env.ciphertext, meta);
        expect((await upload(headers, env.ciphertext)).status).toBe(201);
        rmSync(join(landing, 'tr_replay'), { recursive: true });   // the push record claimed it
        expect((await upload(headers, env.ciphertext)).status).toBe(401);
        expect(existsSync(join(landing, 'tr_replay'))).toBe(false);
    });

    it('a nonce flood from an outsider evicts nothing: the captured upload is still 401 afterwards', async () => {
        const { env, meta } = await sealed(sender, 'flood');
        const headers = signUpload(sender, 'tr_flood', env.ciphertext, meta);
        expect((await upload(headers, env.ciphertext)).status).toBe(201);
        rmSync(join(landing, 'tr_flood'), { recursive: true });
        await inBatches(Array.from({ length: 300 }, () => () => fetch(pingUrl(receiver.port), { headers: signPing(stranger) })));
        // and a flood from a hostile *account* device is confined to its own bucket (unit-tested in lan-auth)
        await inBatches(Array.from({ length: 50 }, () => () => fetch(pingUrl(receiver.port), { headers: signPing(sender) })));
        expect((await upload(headers, env.ciphertext)).status).toBe(401);
    });

    it('an impersonator with a genuine device id but the wrong key sees 401 on the upload too — the meta does not open', async () => {
        const { env, meta } = await sealed(sender, 'x');
        const res = await upload(signUpload({ ...stranger, deviceId: sender.deviceId }, 'tr_imp', env.ciphertext, meta), env.ciphertext);
        expect(res.status).toBe(401);
        expect(await res.text()).toBe('');
        // even for a transferId that is in progress or landed
        expect((await upload(signUpload({ ...stranger, deviceId: sender.deviceId }, 'tr_ok_1', env.ciphertext, meta), env.ciphertext)).status).toBe(401);
    });

    it('a valid MAC over a body sealed for another device is 400 (not wrapped for us), before the body', async () => {
        const plain = Buffer.from('not for you');
        const env = await sender.seal(plain, [{ deviceId: 'dev_other', publicKey: stranger.publicKey }]);
        const meta = { fileName: 'a', iv: env.iv, deviceKeyMap: env.deviceKeyMap };
        const res = await upload(signUpload(sender, 'tr_other', env.ciphertext, meta), env.ciphertext);
        expect(res.status).toBe(400);
        expect(existsSync(join(landing, 'tr_other'))).toBe(false);
    });

    it('a meta sealed under another key is 401 (no proof); one whose transferId disagrees with the header, or malformed, is 400', async () => {
        const { env, meta } = await sealed(sender, 'x');
        expect((await upload(signUpload(sender, 'tr_m1', env.ciphertext, { ...meta, transferId: 'tr_m_other' }), env.ciphertext)).status).toBe(400);
        const wrongKey = sealMeta(deriveLanKeys(Buffer.alloc(32, 3)).metaKey, { ...meta, transferId: 'tr_m2' });
        expect((await upload(signUpload(sender, 'tr_m2', env.ciphertext, meta, { rawMeta: wrongKey }), env.ciphertext)).status).toBe(401);
        const shapeless = sealMeta(sender.keys.metaKey, { fileName: 'a', transferId: 'tr_m3' });
        expect((await upload(signUpload(sender, 'tr_m3', env.ciphertext, meta, { rawMeta: shapeless }), env.ciphertext)).status).toBe(400);
    });

    it('a registered sender over the cap sees the 413 (not a reset) even mid-write; chunked (no length) is 411', async () => {
        const { env, meta } = await sealed(sender, 'x');
        const big = Buffer.alloc(2 * 1024 * 1024);   // well past a socket buffer: the client is still writing when refused
        const res = await upload(signUpload(sender, 'tr_big', big, meta), big);
        expect(res.status).toBe(413);
        expect(existsSync(join(landing, 'tr_big'))).toBe(false);
        const headers = { ...signUpload(sender, 'tr_chunked', env.ciphertext, meta), 'transfer-encoding': 'chunked' };
        const chunked = await new Promise<number>((resolve, reject) => {
            const req = httpRequest({ host: '127.0.0.1', port: receiver.port, method: 'POST', path: LAN_PATHS.upload, headers }, (r) => resolve(r.statusCode ?? 0));
            req.on('error', reject);
            req.write(env.ciphertext);
            req.end();
        });
        expect(chunked).toBe(411);
    });

    it('a body shorter than Content-Length never lands: the client stops, the transfer dir goes', async () => {
        const { env, meta } = await sealed(sender, 'short body');
        const req = holdUpload(signUpload(sender, 'tr_short', env.ciphertext, meta), env.ciphertext);
        await new Promise((r) => setTimeout(r, 100));
        expect(existsSync(join(landing, 'tr_short'))).toBe(true);   // in progress
        req.destroy();
        await new Promise((r) => setTimeout(r, 150));
        expect(existsSync(join(landing, 'tr_short'))).toBe(false);
    });

    it('a hostile fileName stays inside the transfer dir', async () => {
        const { plain, env, meta } = await sealed(sender, 'escape');
        const res = await upload(signUpload(sender, 'tr_esc', env.ciphertext, { ...meta, fileName: '../../../escape.txt' }), env.ciphertext);
        expect(res.status).toBe(201);
        expect(readFileSync(join(landing, 'tr_esc', 'escape.txt')).equals(plain)).toBe(true);
        expect(existsSync(join(landing, '..', 'escape.txt'))).toBe(false);
    });

    it('a third concurrent upload is 503 while two are in flight, and the slots come back', async () => {
        const { env, meta } = await sealed(sender, 'slow');
        const a = holdUpload(signUpload(sender, 'tr_c1', env.ciphertext, meta), env.ciphertext);
        const b = holdUpload(signUpload(sender, 'tr_c2', env.ciphertext, meta), env.ciphertext);
        await new Promise((r) => setTimeout(r, 150));
        const third = await upload(signUpload(sender, 'tr_c3', env.ciphertext, meta), env.ciphertext);
        expect(third.status).toBe(503);
        // the same transferId as one in flight is 409 from the first byte (before the slot check)
        const dup = await upload(signUpload(sender, 'tr_c1', env.ciphertext, meta), env.ciphertext);
        expect(dup.status).toBe(409);
        a.destroy();
        b.destroy();
        await new Promise((r) => setTimeout(r, 150));
        expect(existsSync(join(landing, 'tr_c1'))).toBe(false);
        expect((await upload(signUpload(sender, 'tr_c4', env.ciphertext, meta), env.ciphertext)).status).toBe(201);
    });

    it('a failure between taking the slot and the body (unwritable landing dir) gives the slot back', async () => {
        const locked = mkdtempSync(join(tmpdir(), 'zeph-lan-locked-'));
        chmodSync(locked, 0o500);
        const r = await startLanReceiver({ ...baseOptions(), landingDir: () => locked });
        try {
            const { env, meta } = await sealed(sender, 'x');
            for (let i = 0; i < 4; i++) {
                const res = await upload(signUpload(sender, `tr_locked_${i}`, env.ciphertext, meta), env.ciphertext, r.port);
                expect(res.status).toBe(500);   // never 503: the slot was released each time
            }
        } finally {
            await r.stop();
            chmodSync(locked, 0o700);
        }
    });

    it('a flood of unauthenticated attempts does not lock a real sender out', async () => {
        const junk = [
            ...Array.from({ length: 150 }, () => signPing(stranger)),                          // not on the account
            ...Array.from({ length: 150 }, () => ({ ...signPing(sender), [LAN_HEADERS.mac]: 'ab'.repeat(32) })),   // sniffed id, no key
        ];
        const statuses = await inBatches(junk.map((headers) => async () => (await fetch(pingUrl(receiver.port), { headers })).status));
        expect(new Set(statuses)).toEqual(new Set([401]));
        expect((await fetch(pingUrl(receiver.port), { headers: signPing(sender) })).status).toBe(200);
    });

    it('nonces are per sender across routes: an upload nonce cannot be reused for a ping', async () => {
        const nonces = createNonceRegistry();
        const r2 = await startLanReceiver({ ...baseOptions(), nonces });
        try {
            const nonce = '11'.repeat(16);
            const { env, meta } = await sealed(sender, 'n');
            const res = await fetch(uploadUrl(r2.port), { method: 'POST', headers: signUpload(sender, 'tr_nonce', env.ciphertext, meta, { nonce }), body: env.ciphertext });
            expect(res.status).toBe(201);
            const ping = await fetch(pingUrl(r2.port), { headers: signPing(sender, { nonce }) });
            expect(ping.status).toBe(401);
        } finally {
            await r2.stop();
        }
    });
});

describe('lifecycle', () => {
    it('sockets past maxConnections are dropped, and a slot comes back when one closes', async () => {
        const r = await startLanReceiver({ ...baseOptions(), maxConnections: 2 });
        const idle = () => new Promise<Socket>((resolve) => { const s = connect(r.port, '127.0.0.1', () => resolve(s)); s.on('error', () => undefined); });
        try {
            const held = [await idle(), await idle()];
            await new Promise((res) => setTimeout(res, 50));
            await expect(fetch(pingUrl(r.port), { headers: signPing(sender) })).rejects.toThrow();
            held[0].destroy();
            await new Promise((res) => setTimeout(res, 50));
            expect((await fetch(pingUrl(r.port), { headers: signPing(sender) })).status).toBe(200);
            held[1].destroy();
        } finally {
            await r.stop();
        }
    });

    it('stop() releases the port and is idempotent', async () => {
        const r = await startLanReceiver({ ...baseOptions(), lookupSenderPublicKey: async () => null });
        await r.stop();
        await r.stop();
        await expect(fetch(`http://127.0.0.1:${r.port}/`)).rejects.toThrow();
    });

    it('the landing dir and its parents are created on demand (a fresh install has none)', async () => {
        const fresh = join(mkdtempSync(join(tmpdir(), 'zeph-lan-fresh-')), 'attachments', 'lan');
        const r = await startLanReceiver({ ...baseOptions(), landingDir: () => fresh });
        try {
            const { env, meta } = await sealed(sender, 'fresh');
            expect((await upload(signUpload(sender, 'tr_fresh', env.ciphertext, meta), env.ciphertext, r.port)).status).toBe(201);
            expect(existsSync(join(fresh, 'tr_fresh', 'note.txt'))).toBe(true);
        } finally {
            await r.stop();
        }
    });
});
