import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EncryptedEphemeralPayload } from './crypto.js';

// Mirror of mcp-server's crypto tests — the two crypto.ts files are
// near-identical inline copies (until we extract into a shared package),
// so they share the same test cases plus the SDK-specific
// encryptPushBody / encryptFileForRecipient that the MCP version
// doesn't export.

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

const stubServerWithNoKeys = (): void => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
        ok: true,
        json: async () => ({ data: { encryptionEnabled: true, encryptionKeys: null } }),
    } as unknown as Response)));
};

describe('initCrypto', () => {
    it('generates and persists a keypair when none exists locally', async () => {
        stubServerWithNoKeys();
        const { initCrypto, getPublicKey } = await import('./crypto.js');
        const pub = await initCrypto('ak_test', 'https://api.example.com/v1');
        expect(pub).toBeTruthy();
        expect(getPublicKey()).toBe(pub);
        const keysPath = join(TMP, '.config', 'zeph', 'keys.json');
        expect(existsSync(keysPath)).toBe(true);
        const stored = JSON.parse(readFileSync(keysPath, 'utf-8'));
        expect(stored).toHaveProperty('publicKey');
        expect(stored).toHaveProperty('privateKey');
    });

    it('never sends the private key to the server on upload (security)', async () => {
        const calls: { url: string; init?: RequestInit }[] = [];
        vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
            calls.push({ url, init });
            return {
                ok: true,
                json: async () => ({ data: { encryptionEnabled: true, encryptionKeys: null } }),
            } as unknown as Response;
        }));
        const { initCrypto } = await import('./crypto.js');
        await initCrypto('ak_test', 'https://api.example.com/v1');
        const put = calls.find((c) => c.init?.method === 'PUT' && c.url.endsWith('/users/me/keys'));
        expect(put).toBeDefined();
        const body = JSON.parse(String(put?.init?.body ?? '{}'));
        expect(body).toHaveProperty('publicKey');
        expect(body).not.toHaveProperty('privateKey');
    });

    it('local-only mode works without apiKey', async () => {
        const { initCrypto, getPublicKey } = await import('./crypto.js');
        const pub = await initCrypto();
        expect(pub).toBeTruthy();
        expect(getPublicKey()).toBe(pub);
    });

    it('skips crypto when server says encryption is disabled', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => ({
            ok: true,
            json: async () => ({ data: { encryptionEnabled: false, encryptionKeys: null } }),
        } as unknown as Response)));
        const { initCrypto, getPublicKey, getKeyPair } = await import('./crypto.js');
        const pub = await initCrypto('ak_test', 'https://api.example.com/v1');
        expect(pub).toBe('');
        expect(getPublicKey()).toBe(null);
        expect(getKeyPair()).toBe(null);
    });

    it('deduplicates concurrent calls', async () => {
        stubServerWithNoKeys();
        const { initCrypto } = await import('./crypto.js');
        const [a, b] = await Promise.all([
            initCrypto('ak_test', 'https://api.example.com/v1'),
            initCrypto('ak_test', 'https://api.example.com/v1'),
        ]);
        expect(a).toBe(b);
    });
});

describe('encryptPushBodyForSelf', () => {
    it('returns a complete encrypted envelope', async () => {
        stubServerWithNoKeys();
        const { initCrypto, encryptPushBodyForSelf } = await import('./crypto.js');
        await initCrypto('ak_test', 'https://api.example.com/v1');

        const enc = await encryptPushBodyForSelf({ title: 'hi', body: 'hello world', url: 'https://x.test' });
        expect(enc.isEncrypted).toBe(true);
        expect(enc.senderPublicKey).toBeTruthy();
        const parsed = JSON.parse(enc.body);
        expect(parsed.ciphertext).toMatch(/^[A-Za-z0-9+/=]+$/);
        expect(parsed).toHaveProperty('iv');
    });

    it('produces different ciphertext on repeated calls', async () => {
        stubServerWithNoKeys();
        const { initCrypto, encryptPushBodyForSelf } = await import('./crypto.js');
        await initCrypto('ak_test', 'https://api.example.com/v1');
        const a = await encryptPushBodyForSelf({ body: 'same' });
        const b = await encryptPushBodyForSelf({ body: 'same' });
        expect(JSON.parse(a.body).ciphertext).not.toBe(JSON.parse(b.body).ciphertext);
    });

    it('throws when called before initCrypto', async () => {
        const { encryptPushBodyForSelf } = await import('./crypto.js');
        await expect(encryptPushBodyForSelf({ body: 'x' })).rejects.toThrow(/Crypto not initialized/);
    });
});

describe('encryptPushBody (SDK-only — recipient-targeted)', () => {
    it('encrypts for a separate recipient public key', async () => {
        stubServerWithNoKeys();
        // First init: generate a "recipient" identity we'll export the pub from
        const mod1 = await import('./crypto.js');
        await mod1.initCrypto();
        const recipientPub = mod1.getPublicKey();
        expect(recipientPub).toBeTruthy();

        // Reset modules + new HOME so we get a different sender identity
        const TMP2 = mkdtempSync(join(tmpdir(), 'sdk-crypto-sender-'));
        process.env.HOME = TMP2;
        vi.resetModules();
        const mod2 = await import('./crypto.js');
        await mod2.initCrypto();
        const senderPub = mod2.getPublicKey();
        expect(senderPub).not.toBe(recipientPub);

        const enc = await mod2.encryptPushBody({ body: 'cross-keypair' }, recipientPub!);
        expect(enc.isEncrypted).toBe(true);
        expect(enc.senderPublicKey).toBe(senderPub);

        rmSync(TMP2, { recursive: true, force: true });
    });
});

describe('encryptFileForSelf', () => {
    it('returns ciphertext buffer + iv + wrapped key', async () => {
        stubServerWithNoKeys();
        const { initCrypto, encryptFileForSelf } = await import('./crypto.js');
        await initCrypto('ak_test', 'https://api.example.com/v1');
        const enc = await encryptFileForSelf('file content');
        expect(Buffer.isBuffer(enc.ciphertext)).toBe(true);
        expect(enc.ciphertext.length).toBeGreaterThan(0);
        expect(enc.iv).toMatch(/^[A-Za-z0-9+/=]+$/);
    });
});

describe('key persistence', () => {
    it('reuses stored keys on second init', async () => {
        stubServerWithNoKeys();
        const first = await (await import('./crypto.js')).initCrypto();
        vi.resetModules();
        const second = await (await import('./crypto.js')).initCrypto();
        expect(second).toBe(first);
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

    it('is independent from the per-user keypair (keys.json untouched)', async () => {
        stubServerWithNoKeys();
        const mod = await import('./crypto.js');
        const userPub = await mod.initCrypto();
        const devicePub = await mod.initDeviceCrypto();
        expect(devicePub).not.toBe(userPub);
        const userStored = JSON.parse(readFileSync(join(TMP, '.config', 'zeph', 'keys.json'), 'utf-8'));
        expect(userStored.publicKey).toBe(userPub);
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
