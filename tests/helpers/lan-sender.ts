import { webcrypto } from 'node:crypto';
import {
    EMPTY_BODY_SHA256,
    LAN_HEADERS,
    LAN_PATHS,
    LAN_PING_TRANSFER_ID,
    deriveLanKeys,
    newNonce,
    sealMeta,
    sha256Hex,
    signLanRequest,
    toLanAuthHeaders,
    type LanKeys,
} from '../../src/lan-auth.js';

/**
 * Test-only sender for the local-transfer receiver: a WebCrypto device
 * (what the MCP server and the phones are) that seals a file for the
 * receiver and signs the requests. Same contract the real senders
 * implement in slice 05 / 09 / 10; kept outside `src/` so it never ships.
 */

const subtle = webcrypto.subtle;
const ECDH = { name: 'ECDH', namedCurve: 'P-256' } as const;
const b64 = (b: ArrayBuffer | Uint8Array): string => Buffer.from(b).toString('base64');

export interface TestSender {
    deviceId: string;
    publicKey: string;
    /** Keys against `receiverPublicKey`, via the same ECDH + HKDF the receiver runs. */
    keys: LanKeys;
    /** Raw ECDH secret against any public key — what `tryLanDelivery` takes. */
    deriveSharedSecret: (publicKey: string) => Promise<Buffer>;
    /** `{ ciphertext, iv, deviceKeyMap }` for the receiver, byte-exact `encryptFileForDevices` output. */
    seal: (plaintext: Buffer, recipients?: { deviceId: string; publicKey: string }[]) => Promise<{ ciphertext: Buffer; iv: string; deviceKeyMap: Record<string, string> }>;
}

export const createTestSender = async (deviceId: string, receiverPublicKey: string): Promise<TestSender> => {
    const pair = await subtle.generateKey(ECDH, true, ['deriveKey', 'deriveBits']);
    const deriveSharedSecret = async (publicKey: string): Promise<Buffer> => {
        const pub = await subtle.importKey('spki', Buffer.from(publicKey, 'base64'), ECDH, true, []);
        return Buffer.from(await subtle.deriveBits({ name: 'ECDH', public: pub }, pair.privateKey, 256));
    };
    const secret = await deriveSharedSecret(receiverPublicKey);
    const wrapFor = async (rawFileKey: ArrayBuffer, publicKey: string): Promise<string> => {
        const pub = await subtle.importKey('spki', Buffer.from(publicKey, 'base64'), ECDH, true, []);
        const shared = await subtle.deriveKey({ name: 'ECDH', public: pub }, pair.privateKey, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
        const keyIv = webcrypto.getRandomValues(new Uint8Array(12));
        const wrapped = await subtle.encrypt({ name: 'AES-GCM', iv: keyIv }, shared, rawFileKey);
        return JSON.stringify({ encryptedKey: b64(wrapped), keyIv: b64(keyIv) });
    };
    return {
        deviceId,
        publicKey: b64(await subtle.exportKey('spki', pair.publicKey)),
        keys: deriveLanKeys(secret),
        deriveSharedSecret,
        seal: async (plaintext, recipients) => {
            const fileKey = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt']);
            const iv = webcrypto.getRandomValues(new Uint8Array(12));
            const ciphertext = Buffer.from(await subtle.encrypt({ name: 'AES-GCM', iv }, fileKey, plaintext));
            const raw = await subtle.exportKey('raw', fileKey);
            const deviceKeyMap: Record<string, string> = {};
            for (const r of recipients ?? [{ deviceId: 'receiver', publicKey: receiverPublicKey }]) {
                deviceKeyMap[r.deviceId] = await wrapFor(raw, r.publicKey);
            }
            return { ciphertext, iv: b64(iv), deviceKeyMap };
        },
    };
};

export interface SignOverrides {
    timestamp?: number;
    nonce?: string;
    transferId?: string;
    keys?: LanKeys;
    bodySha256?: string;
    method?: string;
    path?: string;
}

export const signPing = (sender: TestSender, overrides: SignOverrides = {}): Record<string, string> => {
    const fields = {
        senderDeviceId: sender.deviceId,
        transferId: overrides.transferId ?? LAN_PING_TRANSFER_ID,
        timestamp: overrides.timestamp ?? Date.now(),
        nonce: overrides.nonce ?? newNonce(),
    };
    const keys = overrides.keys ?? sender.keys;
    const mac = signLanRequest(keys.macKey, { ...fields, method: overrides.method ?? 'GET', path: overrides.path ?? LAN_PATHS.ping, bodySha256: overrides.bodySha256 ?? EMPTY_BODY_SHA256 });
    return toLanAuthHeaders(fields, mac);
};

export interface UploadMeta {
    fileName: string;
    fileType?: string;
    fileSize?: number;
    iv: string;
    deviceKeyMap: Record<string, string>;
    transferId?: string;
}

export const signUpload = (
    sender: TestSender,
    transferId: string,
    body: Buffer,
    meta: UploadMeta,
    overrides: SignOverrides & { rawMeta?: string } = {},
): Record<string, string> => {
    const fields = {
        senderDeviceId: sender.deviceId,
        transferId,
        timestamp: overrides.timestamp ?? Date.now(),
        nonce: overrides.nonce ?? newNonce(),
    };
    const keys = overrides.keys ?? sender.keys;
    const mac = signLanRequest(keys.macKey, { ...fields, method: overrides.method ?? 'POST', path: overrides.path ?? LAN_PATHS.upload, bodySha256: overrides.bodySha256 ?? sha256Hex(body) });
    return {
        ...toLanAuthHeaders(fields, mac),
        [LAN_HEADERS.meta]: overrides.rawMeta ?? sealMeta(keys.metaKey, { ...meta, transferId: meta.transferId ?? transferId }),
        'content-type': 'application/octet-stream',
    };
};

export const pingUrl = (port: number): string => `http://127.0.0.1:${port}${LAN_PATHS.ping}`;
export const uploadUrl = (port: number): string => `http://127.0.0.1:${port}${LAN_PATHS.upload}`;
