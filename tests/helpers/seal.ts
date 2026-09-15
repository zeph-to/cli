import { webcrypto } from 'node:crypto';
import { Readable } from 'node:stream';

/**
 * Test-only sender: seals bytes exactly the way `libs/crypto` `encryptFile`
 * and the cli's `encryptFileForDevices` do it, on WebCrypto, so a receiver
 * under test is checked against the real wire format rather than its own
 * idea of it. Lives outside `src/` so it is never built into `dist/`.
 */

const subtle = webcrypto.subtle;
const ECDH = { name: 'ECDH', namedCurve: 'P-256' } as const;
const b64 = (b: ArrayBuffer | Uint8Array): string => Buffer.from(b).toString('base64');

export interface Sealed {
    ciphertext: Buffer;
    iv: string;
    /** JSON `{ encryptedKey, keyIv }` — one `deviceKeyMap` slot. */
    entry: string;
    senderPublicKey: string;
}

export const sealForReceiver = async (plaintext: Buffer, receiverPublicKeyB64: string): Promise<Sealed> => {
    const sender = await subtle.generateKey(ECDH, true, ['deriveKey']);
    const receiverPub = await subtle.importKey('spki', Buffer.from(receiverPublicKeyB64, 'base64'), ECDH, true, []);
    const fileKey = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt']);
    const iv = webcrypto.getRandomValues(new Uint8Array(12));
    const ciphertext = Buffer.from(await subtle.encrypt({ name: 'AES-GCM', iv }, fileKey, plaintext));
    const shared = await subtle.deriveKey({ name: 'ECDH', public: receiverPub }, sender.privateKey, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
    const keyIv = webcrypto.getRandomValues(new Uint8Array(12));
    const wrapped = await subtle.encrypt({ name: 'AES-GCM', iv: keyIv }, shared, await subtle.exportKey('raw', fileKey));
    return {
        ciphertext,
        iv: b64(iv),
        entry: JSON.stringify({ encryptedKey: b64(wrapped), keyIv: b64(keyIv) }),
        senderPublicKey: b64(await subtle.exportKey('spki', sender.publicKey)),
    };
};

/** A fresh ECDH public key that is not the receiver's — "some other device". */
export const otherDevicePublicKey = async (): Promise<string> => {
    const pair = await subtle.generateKey(ECDH, true, ['deriveKey']);
    return b64(await subtle.exportKey('spki', pair.publicKey));
};

export const chunked = (buf: Buffer, size: number): Readable => {
    const parts: Buffer[] = [];
    for (let i = 0; i < buf.length; i += size) parts.push(buf.subarray(i, i + size));
    return Readable.from(parts);
};
