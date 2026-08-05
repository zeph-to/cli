import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EncryptedEphemeralPayload } from './crypto.js';

// Mirror of mcp-server's crypto tests — the two crypto.ts files are
// near-identical inline copies (until we extract into a shared package),
// so they share the same test cases, plus the stream-frame helpers below
// that the MCP version doesn't have.

const CRYPTO_ENV_KEYS = ['HOME', 'XDG_CONFIG_HOME'] as const;
const originalEnv: Record<string, string | undefined> = {};
for (const key of CRYPTO_ENV_KEYS) originalEnv[key] = process.env[key];

let TMP: string;

beforeEach(() => {
    TMP = mkdtempSync(join(tmpdir(), 'sdk-crypto-test-'));
    for (const key of CRYPTO_ENV_KEYS) delete process.env[key];
    process.env.HOME = TMP;
    vi.resetModules();
    vi.unstubAllGlobals();
});

afterEach(() => {
    rmSync(TMP, { recursive: true, force: true });
    for (const key of CRYPTO_ENV_KEYS) {
        if (originalEnv[key] === undefined) delete process.env[key];
        else process.env[key] = originalEnv[key];
    }
    vi.unstubAllGlobals();
});

const ECDH: EcKeyImportParams = { name: 'ECDH', namedCurve: 'P-256' };
const b64 = (buf: ArrayBuffer): string => Buffer.from(new Uint8Array(buf)).toString('base64');
const unb64 = (s: string): Buffer => Buffer.from(s, 'base64');

/** A stand-in recipient device with its own keypair. */
const makeDevice = async (): Promise<{ publicKey: string; privateKey: string }> => {
    const kp = await crypto.subtle.generateKey(ECDH, true, ['deriveKey', 'deriveBits']);
    const [pub, priv] = await Promise.all([
        crypto.subtle.exportKey('spki', kp.publicKey),
        crypto.subtle.exportKey('pkcs8', kp.privateKey),
    ]);
    return { publicKey: b64(pub), privateKey: b64(priv) };
};

/** Unwrap the way a recipient device does: ECDH(my private, sender public). */
const unwrapAsDevice = async (
    devicePrivateKey: string,
    senderPublicKey: string,
    wrappedEntry: string,
    ciphertext: string | Buffer,
    iv: string,
): Promise<Buffer> => {
    const priv = await crypto.subtle.importKey('pkcs8', unb64(devicePrivateKey), ECDH, false, ['deriveKey']);
    const pub = await crypto.subtle.importKey('spki', unb64(senderPublicKey), ECDH, false, []);
    const sharedKey = await crypto.subtle.deriveKey(
        { name: 'ECDH', public: pub }, priv, { name: 'AES-GCM', length: 256 }, false, ['decrypt'],
    );

    const { encryptedKey, keyIv } = JSON.parse(wrappedEntry) as { encryptedKey: string; keyIv: string };
    const rawKey = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(keyIv) }, sharedKey, unb64(encryptedKey));
    const messageKey = await crypto.subtle.importKey('raw', rawKey, { name: 'AES-GCM' }, false, ['decrypt']);

    const bytes = typeof ciphertext === 'string' ? unb64(ciphertext) : ciphertext;
    return Buffer.from(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv) }, messageKey, bytes));
};

const stubServer = (data: { encryptionEnabled: boolean; publicKey?: string }): void => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
        ok: true,
        json: async () => ({
            data: {
                encryptionEnabled: data.encryptionEnabled,
                encryptionKeys: data.publicKey ? { publicKey: data.publicKey } : null,
            },
        }),
    } as unknown as Response)));
};

const fetchCalls = (): { url: string; method: string }[] => {
    const calls = (fetch as unknown as { mock?: { calls: unknown[][] } }).mock?.calls ?? [];
    return calls.map((args) => ({
        url: String(args[0]),
        method: ((args[1] as RequestInit | undefined)?.method ?? 'GET').toUpperCase(),
    }));
};

describe('initCrypto', () => {
    it('adopts the per-device keypair when the account has opted in', async () => {
        stubServer({ encryptionEnabled: true });
        const { initCrypto, getPublicKey, getDevicePublicKey } = await import('./crypto.js');

        const pub = await initCrypto('ak_test', 'https://api.example.com/v1');

        expect(pub).toBeTruthy();
        expect(getPublicKey()).toBe(pub);
        // Same keypair the stream frames use — one identity per host.
        expect(getDevicePublicKey()).toBe(pub);
        expect(existsSync(join(TMP, '.zeph', 'device-keys.json'))).toBe(true);
    });

    it('never writes key material to the server', async () => {
        stubServer({ encryptionEnabled: true });
        const { initCrypto } = await import('./crypto.js');

        await initCrypto('ak_test', 'https://api.example.com/v1');

        // The old code PUT this host's public key to /users/me/keys, which
        // overwrote the account key every other client reads and made pushes
        // undecryptable everywhere.
        expect(fetchCalls().some((c) => c.method === 'PUT')).toBe(false);
        expect(fetchCalls().every((c) => c.method === 'GET')).toBe(true);
    });

    it('deletes the escrowed account keypair an old build may have left behind', async () => {
        const legacyPath = join(TMP, '.config', 'zeph', 'keys.json');
        mkdirSync(join(TMP, '.config', 'zeph'), { recursive: true });
        writeFileSync(legacyPath, JSON.stringify({ publicKey: 'p', privateKey: 'q' }));

        stubServer({ encryptionEnabled: true });
        const { initCrypto } = await import('./crypto.js');
        await initCrypto('ak_test', 'https://api.example.com/v1');

        expect(existsSync(legacyPath)).toBe(false);
    });

    it('stays off in local-only mode (no apiKey)', async () => {
        const { initCrypto, getPublicKey, getKeyPair } = await import('./crypto.js');

        const pub = await initCrypto();

        // No flag to consult, so encryption must not be inferred.
        expect(pub).toBe('');
        expect(getPublicKey()).toBe(null);
        expect(getKeyPair()).toBe(null);
    });

    it('skips crypto when the account has not opted in', async () => {
        stubServer({ encryptionEnabled: false });
        const { initCrypto, getPublicKey, getKeyPair } = await import('./crypto.js');
        const pub = await initCrypto('ak_test', 'https://api.example.com/v1');
        expect(pub).toBe('');
        expect(getPublicKey()).toBe(null);
        expect(getKeyPair()).toBe(null);
    });

    it('stays off when the server is unreachable', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));
        const { initCrypto, getPublicKey, getKeyPair } = await import('./crypto.js');
        const pub = await initCrypto('ak_test', 'https://api.example.com/v1');
        expect(pub).toBe('');
        expect(getPublicKey()).toBe(null);
        expect(getKeyPair()).toBe(null);
    });

    it('deduplicates concurrent calls', async () => {
        stubServer({ encryptionEnabled: true });
        const { initCrypto } = await import('./crypto.js');
        const [a, b] = await Promise.all([
            initCrypto('ak_test', 'https://api.example.com/v1'),
            initCrypto('ak_test', 'https://api.example.com/v1'),
        ]);
        expect(a).toBe(b);
        expect(fetchCalls().length).toBe(1);
    });
});

describe('selectRecipients', () => {
    it('drops devices with no public key and devices still on the account key', async () => {
        stubServer({ encryptionEnabled: true, publicKey: 'ACCOUNT_PUB' });
        const { initCrypto, selectRecipients } = await import('./crypto.js');
        await initCrypto('ak_test', 'https://api.example.com/v1');

        const picked = selectRecipients([
            { deviceId: 'dev_new', publicKey: 'PHONE_PUB' },
            { deviceId: 'dev_stale', publicKey: 'ACCOUNT_PUB' },
            { deviceId: 'dev_old' },
        ]);

        expect(picked).toEqual([{ deviceId: 'dev_new', publicKey: 'PHONE_PUB' }]);
    });
});

describe('encryptPushBodyForDevices', () => {
    it('produces an envelope every recipient device can open', async () => {
        stubServer({ encryptionEnabled: true });
        const { initCrypto, encryptPushBodyForDevices } = await import('./crypto.js');
        await initCrypto('ak_test', 'https://api.example.com/v1');

        const phone = await makeDevice();
        const laptop = await makeDevice();
        const enc = await encryptPushBodyForDevices(
            { title: 'hi', body: 'hello world', url: 'https://x.test' },
            [{ deviceId: 'dev_phone', publicKey: phone.publicKey }, { deviceId: 'dev_laptop', publicKey: laptop.publicKey }],
        );

        expect(enc.isEncrypted).toBe(true);
        expect(Object.keys(enc.deviceKeyMap)).toEqual(['dev_phone', 'dev_laptop']);
        const { ciphertext, iv } = JSON.parse(enc.body) as { ciphertext: string; iv: string };

        for (const [deviceId, kp] of [['dev_phone', phone], ['dev_laptop', laptop]] as const) {
            const plain = await unwrapAsDevice(kp.privateKey, enc.senderPublicKey, enc.deviceKeyMap[deviceId], ciphertext, iv);
            expect(JSON.parse(plain.toString('utf-8'))).toEqual({ title: 'hi', body: 'hello world', url: 'https://x.test' });
        }
    });

    it('produces different ciphertext on repeated calls', async () => {
        stubServer({ encryptionEnabled: true });
        const { initCrypto, encryptPushBodyForDevices } = await import('./crypto.js');
        await initCrypto('ak_test', 'https://api.example.com/v1');
        const phone = await makeDevice();
        const to = [{ deviceId: 'dev_phone', publicKey: phone.publicKey }];

        const a = await encryptPushBodyForDevices({ body: 'same' }, to);
        const b = await encryptPushBodyForDevices({ body: 'same' }, to);
        expect(JSON.parse(a.body).ciphertext).not.toBe(JSON.parse(b.body).ciphertext);
    });

    it('throws rather than sending unencrypted when no recipient is usable', async () => {
        stubServer({ encryptionEnabled: true });
        const { initCrypto, encryptPushBodyForDevices } = await import('./crypto.js');
        await initCrypto('ak_test', 'https://api.example.com/v1');

        await expect(
            encryptPushBodyForDevices({ body: 'x' }, [{ deviceId: 'dev_bad', publicKey: 'not-a-key' }]),
        ).rejects.toThrow(/No recipient device/);
    });

    it('throws when called before initCrypto', async () => {
        const { encryptPushBodyForDevices } = await import('./crypto.js');
        await expect(encryptPushBodyForDevices({ body: 'x' }, [])).rejects.toThrow(/Crypto not initialized/);
    });
});

describe('encryptFileForDevices', () => {
    it('round-trips the content for a recipient device', async () => {
        stubServer({ encryptionEnabled: true });
        const { initCrypto, encryptFileForDevices, getPublicKey } = await import('./crypto.js');
        await initCrypto('ak_test', 'https://api.example.com/v1');

        const phone = await makeDevice();
        const enc = await encryptFileForDevices('héllo — 안녕', [{ deviceId: 'dev_phone', publicKey: phone.publicKey }]);

        expect(Buffer.isBuffer(enc.ciphertext)).toBe(true);
        expect(enc.iv).toMatch(/^[A-Za-z0-9+/=]+$/);
        const plain = await unwrapAsDevice(
            phone.privateKey, getPublicKey()!, enc.deviceKeyMap['dev_phone'], enc.ciphertext, enc.iv,
        );
        expect(plain.toString('utf-8')).toBe('héllo — 안녕');
    });
});

// ─── Per-device crypto (stream E2EE) ───

// Mirror of the web's decrypt() (libs/crypto/decrypt.ts): derive the shared
// AES key from ECDH(recipient private, sender public), unwrap the message key
// with keyIv, then decrypt the ciphertext with iv. Reproduced here so the
// round-trip test proves the envelope is decryptable by the web unmodified.
const webDecrypt = async (
    payload: EncryptedEphemeralPayload,
    recipientPrivateKey: CryptoKey,
): Promise<string> => {
    const { webcrypto } = await import('node:crypto');
    const wc = webcrypto as unknown as Crypto;
    const b64 = (s: string): ArrayBuffer => {
        const bin = atob(s);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return bytes.buffer;
    };
    const senderPub = await wc.subtle.importKey(
        'spki', b64(payload.senderPublicKey), { name: 'ECDH', namedCurve: 'P-256' }, true, [],
    );
    const sharedKey = await wc.subtle.deriveKey(
        { name: 'ECDH', public: senderPub }, recipientPrivateKey,
        { name: 'AES-GCM', length: 256 }, false, ['decrypt'],
    );
    const rawMessageKey = await wc.subtle.decrypt(
        { name: 'AES-GCM', iv: new Uint8Array(b64(payload.keyIv)) }, sharedKey, b64(payload.encryptedKey),
    );
    const messageKey = await wc.subtle.importKey('raw', rawMessageKey, { name: 'AES-GCM' }, false, ['decrypt']);
    const plain = await wc.subtle.decrypt(
        { name: 'AES-GCM', iv: new Uint8Array(b64(payload.iv)) }, messageKey, b64(payload.ciphertext),
    );
    return new TextDecoder().decode(plain);
};

const makeRecipient = async (): Promise<{ publicKeyB64: string; privateKey: CryptoKey }> => {
    const { webcrypto } = await import('node:crypto');
    const wc = webcrypto as unknown as Crypto;
    const pair = await wc.subtle.generateKey(
        { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey', 'deriveBits'],
    ) as CryptoKeyPair;
    const spki = await wc.subtle.exportKey('spki', pair.publicKey);
    const bytes = new Uint8Array(spki);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return { publicKeyB64: btoa(bin), privateKey: pair.privateKey };
};

describe('initDeviceCrypto', () => {
    it('generates and persists a device keypair under ~/.zeph', async () => {
        const { initDeviceCrypto, getDevicePublicKey } = await import('./crypto.js');
        const pub = await initDeviceCrypto();
        expect(pub).toBeTruthy();
        expect(getDevicePublicKey()).toBe(pub);
        const keysPath = join(TMP, '.zeph', 'device-keys.json');
        expect(existsSync(keysPath)).toBe(true);
        const stored = JSON.parse(readFileSync(keysPath, 'utf-8'));
        expect(stored).toHaveProperty('publicKey');
        expect(stored).toHaveProperty('privateKey');
    });

    it('reuses the stored device keypair on second init', async () => {
        const first = await (await import('./crypto.js')).initDeviceCrypto();
        vi.resetModules();
        const second = await (await import('./crypto.js')).initDeviceCrypto();
        expect(second).toBe(first);
    });

    it('deduplicates concurrent calls', async () => {
        const { initDeviceCrypto } = await import('./crypto.js');
        const [a, b] = await Promise.all([initDeviceCrypto(), initDeviceCrypto()]);
        expect(a).toBe(b);
    });

    it('is available for stream frames even when push encryption is off', async () => {
        stubServer({ encryptionEnabled: false });
        const mod = await import('./crypto.js');
        await mod.initCrypto('ak_test', 'https://api.example.com/v1');

        // The account opt-in gates push/file bodies only. Stream frames are
        // always encrypted, so the device keypair has to work regardless —
        // and push encryption must stay off despite the keypair existing.
        const devicePub = await mod.initDeviceCrypto();
        expect(devicePub).toBeTruthy();
        expect(mod.getDevicePublicKey()).toBe(devicePub);
        expect(mod.getKeyPair()).toBe(null);
    });
});

describe('encryptEphemeral', () => {
    it('round-trips through the web decrypt() algorithm', async () => {
        const { initDeviceCrypto, encryptEphemeral } = await import('./crypto.js');
        const devicePub = await initDeviceCrypto();
        const recipient = await makeRecipient();

        const payload = await encryptEphemeral('pane content \x1b[32mgreen\x1b[0m ✓', recipient.publicKeyB64);
        expect(payload.senderPublicKey).toBe(devicePub);
        expect(payload.ciphertext).toMatch(/^[A-Za-z0-9+/=]+$/);
        expect(payload).toHaveProperty('iv');
        expect(payload).toHaveProperty('encryptedKey');
        expect(payload).toHaveProperty('keyIv');

        const decrypted = await webDecrypt(payload, recipient.privateKey);
        expect(decrypted).toBe('pane content \x1b[32mgreen\x1b[0m ✓');
    });

    it('produces different ciphertext on repeated calls', async () => {
        const { initDeviceCrypto, encryptEphemeral } = await import('./crypto.js');
        await initDeviceCrypto();
        const recipient = await makeRecipient();
        const a = await encryptEphemeral('same', recipient.publicKeyB64);
        const b = await encryptEphemeral('same', recipient.publicKeyB64);
        expect(a.ciphertext).not.toBe(b.ciphertext);
    });

    it('throws when called before initDeviceCrypto', async () => {
        const { encryptEphemeral } = await import('./crypto.js');
        const recipient = await makeRecipient();
        await expect(encryptEphemeral('x', recipient.publicKeyB64)).rejects.toThrow(/Device crypto not initialized/);
    });
});
