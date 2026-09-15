import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import {
    EMPTY_BODY_SHA256,
    LAN_CLOCK_SKEW_MS,
    LAN_HEADERS,
    LAN_META_MAX_BYTES,
    LAN_PATHS,
    canonicalString,
    createBodyHasher,
    createNonceRegistry,
    deriveLanKeys,
    isTimestampFresh,
    newNonce,
    openMeta,
    parseLanAuthHeaders,
    sealMeta,
    sha256Hex,
    signLanRequest,
    toLanAuthHeaders,
    verifyLanMac,
    type LanAuthFields,
} from './lan-auth.js';
import { deriveLanSharedSecret, getDevicePublicKey, initDeviceCrypto } from './crypto.js';

// This is the only security boundary of local transfer, and it has four
// implementations (this, the MCP twin, Kotlin, Swift). They agree by the
// vectors file, which was produced by an independent Python
// implementation — so a green run here is parity with the contract, not
// with itself.

interface VectorCase {
    name: string;
    sharedSecretHex: string;
    macKeyHex: string;
    metaKeyHex: string;
    method: string;
    path: string;
    bodyHex: string;
    bodySha256: string;
    fields: Omit<LanAuthFields, 'bodySha256' | 'method' | 'path'>;
    canonical: string;
    macHex: string;
    metaJson?: string;
    metaIvHex?: string;
    metaSealedBase64?: string;
}
const vectors = JSON.parse(readFileSync(new URL('./lan-auth.vectors.json', import.meta.url), 'utf8')) as { cases: VectorCase[] };

const fields: LanAuthFields = {
    method: 'POST',
    path: LAN_PATHS.upload,
    senderDeviceId: 'dev_mcp_1',
    transferId: 'tr_1',
    timestamp: 1_800_000_000_000,
    nonce: '0123456789abcdef0123456789abcdef',
    bodySha256: EMPTY_BODY_SHA256,
};
const keys = deriveLanKeys(Buffer.alloc(32, 7));

describe('lan-auth vectors', () => {
    it.each(vectors.cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
        const k = deriveLanKeys(Buffer.from(c.sharedSecretHex, 'hex'));
        expect(k.macKey.toString('hex')).toBe(c.macKeyHex);
        expect(k.metaKey.toString('hex')).toBe(c.metaKeyHex);
        const body = Buffer.from(c.bodyHex, 'hex');
        expect(sha256Hex(body)).toBe(c.bodySha256);
        const f: LanAuthFields = { ...c.fields, method: c.method, path: c.path, bodySha256: c.bodySha256 };
        expect(canonicalString(f)).toBe(c.canonical);
        expect(signLanRequest(k.macKey, f)).toBe(c.macHex);
        expect(verifyLanMac(k.macKey, f, c.macHex)).toBe(true);
        if (c.metaSealedBase64 !== undefined) {
            // Decrypt what Python sealed, and seal the same JSON with the same iv back to the same bytes.
            expect(openMeta(k.metaKey, c.metaSealedBase64)).toEqual(JSON.parse(c.metaJson ?? ''));
            expect(sealMeta(k.metaKey, JSON.parse(c.metaJson ?? '') as object, Buffer.from(c.metaIvHex ?? '', 'hex'))).toBe(c.metaSealedBase64);
        }
    });
});

describe('sign / verify', () => {
    it('round-trips, and every field is bound — method and path included', () => {
        const mac = signLanRequest(keys.macKey, fields);
        expect(verifyLanMac(keys.macKey, fields, mac)).toBe(true);
        for (const k of Object.keys(fields) as (keyof LanAuthFields)[]) {
            const tampered = { ...fields, [k]: k === 'timestamp' ? fields.timestamp + 1 : `${fields[k]}x` };
            expect(verifyLanMac(keys.macKey, tampered, mac)).toBe(false);
        }
        // A ping MAC is not an upload MAC with an empty body.
        const ping = { ...fields, method: 'GET', path: LAN_PATHS.ping, transferId: 'ping' };
        expect(verifyLanMac(keys.macKey, ping, signLanRequest(keys.macKey, { ...ping, method: 'POST', path: LAN_PATHS.upload }))).toBe(false);
    });

    it('a different secret does not verify', () => {
        const mac = signLanRequest(keys.macKey, fields);
        expect(verifyLanMac(deriveLanKeys(Buffer.alloc(32, 8)).macKey, fields, mac)).toBe(false);
    });

    it('a MAC of the wrong length or non-hex is false, not a throw', () => {
        expect(verifyLanMac(keys.macKey, fields, 'abc')).toBe(false);
        expect(verifyLanMac(keys.macKey, fields, 'zz'.repeat(32))).toBe(false);
        expect(verifyLanMac(keys.macKey, fields, '')).toBe(false);
    });

    it('the streaming hasher matches the one-shot hash', () => {
        const h = createBodyHasher();
        h.update(Buffer.from('hello '));
        h.update(Buffer.from('world'));
        expect(h.digestHex()).toBe(sha256Hex('hello world'));
    });
});

describe('sealed meta', () => {
    const meta = { fileName: 'a.png', iv: 'AAAAAAAAAAAAAAAA', deviceKeyMap: { dev_x: '{}' }, transferId: 'tr_1' };

    it('round-trips under the meta key, with a fresh iv each time', () => {
        const a = sealMeta(keys.metaKey, meta);
        const b = sealMeta(keys.metaKey, meta);
        expect(a).not.toBe(b);
        expect(openMeta(keys.metaKey, a)).toEqual(meta);
        expect(openMeta(keys.metaKey, b)).toEqual(meta);
    });

    it('does not open under another key, when tampered, truncated, malformed, oversized, or duplicated — null, never a throw', () => {
        const sealed = sealMeta(keys.metaKey, meta);
        expect(openMeta(deriveLanKeys(Buffer.alloc(32, 9)).metaKey, sealed)).toBeNull();
        const raw = Buffer.from(sealed, 'base64');
        raw[20] ^= 1;
        expect(openMeta(keys.metaKey, raw.toString('base64'))).toBeNull();
        expect(openMeta(keys.metaKey, Buffer.from(sealed, 'base64').subarray(0, 20).toString('base64'))).toBeNull();
        expect(openMeta(keys.metaKey, 'not base64!!')).toBeNull();
        expect(openMeta(keys.metaKey, 'A'.repeat(LAN_META_MAX_BYTES + 1))).toBeNull();
        expect(openMeta(keys.metaKey, [sealed, sealed])).toBeNull();
        expect(openMeta(keys.metaKey, undefined)).toBeNull();
    });
});

describe('headers', () => {
    const headerFields = { senderDeviceId: 'dev_mcp_1', transferId: 'tr_1', timestamp: 1_800_000_000_000, nonce: newNonce() };

    it('round-trips through the header names', () => {
        const mac = 'ab'.repeat(32);
        const parsed = parseLanAuthHeaders(toLanAuthHeaders(headerFields, mac));
        expect(parsed).toEqual({ ...headerFields, mac });
    });

    it('rejects a missing, duplicated or malformed header — null, before any crypto', () => {
        const good = toLanAuthHeaders(headerFields, 'ab'.repeat(32));
        for (const name of Object.values(LAN_HEADERS)) {
            if (name === LAN_HEADERS.meta) continue;
            const { [name]: _dropped, ...rest } = good;
            expect(parseLanAuthHeaders(rest)).toBeNull();
            expect(parseLanAuthHeaders({ ...good, [name]: [good[name], good[name]] })).toBeNull();
        }
        expect(parseLanAuthHeaders({ ...good, [LAN_HEADERS.nonce]: 'ABCD' })).toBeNull();          // upper / short
        expect(parseLanAuthHeaders({ ...good, [LAN_HEADERS.timestamp]: '1.5e12' })).toBeNull();
        expect(parseLanAuthHeaders({ ...good, [LAN_HEADERS.transfer]: '../x' })).toBeNull();
        expect(parseLanAuthHeaders({ ...good, [LAN_HEADERS.sender]: 'a b' })).toBeNull();
        expect(parseLanAuthHeaders({ ...good, [LAN_HEADERS.mac]: 'ab'.repeat(31) })).toBeNull();
    });

    it('newNonce is 16 random bytes as lower-case hex', () => {
        const a = newNonce();
        expect(a).toMatch(/^[0-9a-f]{32}$/);
        expect(newNonce()).not.toBe(a);
    });
});

describe('timestamp window', () => {
    const now = 1_800_000_000_000;
    it('accepts within ±skew inclusive, rejects beyond', () => {
        expect(isTimestampFresh(now, now)).toBe(true);
        expect(isTimestampFresh(now - LAN_CLOCK_SKEW_MS, now)).toBe(true);
        expect(isTimestampFresh(now + LAN_CLOCK_SKEW_MS, now)).toBe(true);
        expect(isTimestampFresh(now - LAN_CLOCK_SKEW_MS - 1, now)).toBe(false);
        expect(isTimestampFresh(now + LAN_CLOCK_SKEW_MS + 1, now)).toBe(false);
    });
});

describe('nonce registry', () => {
    it('seen() is read-only; commit() records once and refuses a second time within the TTL', () => {
        const r = createNonceRegistry(10, 1000);
        expect(r.seen('s', 'n1', 0)).toBe(false);
        expect(r.seen('s', 'n1', 0)).toBe(false);   // looking is not recording
        expect(r.commit('s', 'n1', 0)).toBe(true);
        expect(r.seen('s', 'n1', 500)).toBe(true);
        expect(r.commit('s', 'n1', 500)).toBe(false);
        expect(r.seen('s', 'n1', 1000)).toBe(true);   // inclusive
        expect(r.seen('s', 'n1', 1001)).toBe(false);
        expect(r.commit('s', 'n1', 1001)).toBe(true);
    });

    it('is partitioned per sender: one device cannot see or push out another device\'s nonces', () => {
        const r = createNonceRegistry(3, 60_000);
        expect(r.commit('victim', 'v1', 0)).toBe(true);
        for (let i = 0; i < 50; i++) r.commit('hostile', `h${i}`, i);
        expect(r.seen('victim', 'v1', 100)).toBe(true);
        expect(r.seen('hostile', 'v1', 100)).toBe(false);
    });

    it('a full bucket refuses new nonces rather than forgetting old ones', () => {
        const r = createNonceRegistry(3, 60_000);
        for (let i = 0; i < 3; i++) expect(r.commit('s', `n${i}`, i)).toBe(true);
        expect(r.commit('s', 'n3', 10)).toBe(false);   // refused
        expect(r.seen('s', 'n0', 10)).toBe(true);       // still remembered
        expect(r.size()).toBe(3);
    });

    it('sweeps expired entries and drops empty buckets', () => {
        const r = createNonceRegistry(100, 100);
        r.commit('s', 'old', 0);
        expect(r.seen('s', 'old', 200)).toBe(false);
        expect(r.size()).toBe(0);
        r.commit('s', 'new', 200);
        expect(r.size()).toBe(1);
    });
});

describe('ECDH → shared secret parity with WebCrypto', () => {
    beforeAll(async () => { await initDeviceCrypto(); });

    it('the receiver derives the same secret a WebCrypto sender derives', async () => {
        const ECDH = { name: 'ECDH', namedCurve: 'P-256' } as const;
        const sender = await webcrypto.subtle.generateKey(ECDH, true, ['deriveBits']);
        const senderPub = Buffer.from(await webcrypto.subtle.exportKey('spki', sender.publicKey)).toString('base64');
        const receiverPub = await webcrypto.subtle.importKey('spki', Buffer.from(getDevicePublicKey() ?? '', 'base64'), ECDH, true, []);
        const senderSide = Buffer.from(await webcrypto.subtle.deriveBits({ name: 'ECDH', public: receiverPub }, sender.privateKey, 256));
        const receiverSide = await deriveLanSharedSecret(senderPub);
        expect(receiverSide.equals(senderSide)).toBe(true);
        expect(receiverSide.length).toBe(32);
        // and so the keys agree
        expect(deriveLanKeys(receiverSide).macKey.equals(deriveLanKeys(senderSide).macKey)).toBe(true);
    });
});
