import { beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveFileFromS3, type SaveFileDeps } from './listener.js';
import { getDevicePublicKey, initDeviceCrypto } from './crypto.js';
import { sealForReceiver } from '../tests/helpers/seal.js';

// The real save path, S3 replaced by a recording fetch. What is pinned:
// the API key goes to the zeph API and never to the presigned URL, each
// key-material shape takes the branch it should, and an encrypted file
// sealed the way the MCP seals it lands decrypted under Downloads/Zeph.

const ME = 'dev_listener_me';
const API = 'https://api.example/v1';
const PRESIGNED = 'https://s3.example/bucket/obj?X-Amz-Signature=abc';

interface Call { url: string; headers: Record<string, string> }

const harness = (bodyBytes: Buffer | null, opts: { metaStatus?: number; binStatus?: number } = {}) => {
    const calls: Call[] = [];
    const dir = mkdtempSync(join(tmpdir(), 'zeph-save-'));
    const fetchFn: typeof fetch = async (input, init) => {
        const url = String(input);
        const headers = { ...(init?.headers as Record<string, string> | undefined) }; // fixture: the saver passes a plain object
        calls.push({ url, headers });
        if (url.startsWith(API)) {
            return new Response(JSON.stringify({ data: { downloadUrl: PRESIGNED } }), { status: opts.metaStatus ?? 200 });
        }
        return new Response(bodyBytes, { status: opts.binStatus ?? 200 });
    };
    const deps: SaveFileDeps = { ctx: { apiKey: 'zk_secret', baseUrl: API }, fetchFn, deviceId: () => ME, downloadsDir: () => dir };
    return { calls, dir, deps };
};

let receiverPublicKey: string;
beforeAll(async () => {
    await initDeviceCrypto();
    receiverPublicKey = getDevicePublicKey() ?? '';
});

describe('saveFileFromS3', () => {
    it('plaintext: metadata with the API key, bytes from the presigned URL with no headers, file lands', async () => {
        const h = harness(Buffer.from('hello'));
        const path = await saveFileFromS3({ pushId: 'p' }, { fileKey: 'fk/1', fileName: 'hi.txt' }, h.deps);
        expect(path).toBe(join(h.dir, 'hi.txt'));
        expect(readFileSync(path ?? '').toString()).toBe('hello');
        expect(h.calls.map((c) => c.url)).toEqual([`${API}/files/fk%2F1`, PRESIGNED]);
        expect(h.calls[0].headers['X-API-Key']).toBe('zk_secret');
        expect(h.calls[1].headers).toEqual({});
    });

    it('encrypted for this device: opens the deviceKeyMap slot and writes the plaintext', async () => {
        const secret = Buffer.from('top secret recording bytes '.repeat(50));
        const sealed = await sealForReceiver(secret, receiverPublicKey);
        const h = harness(sealed.ciphertext);
        const path = await saveFileFromS3(
            { pushId: 'p', isEncrypted: true, senderPublicKey: sealed.senderPublicKey },
            { fileKey: 'fk', fileName: 'rec.mov', iv: sealed.iv, deviceKeyMap: { [ME]: sealed.entry, dev_other: '{}' } },
            h.deps,
        );
        expect(path).toBe(join(h.dir, 'rec.mov'));
        expect(readFileSync(path ?? '').equals(secret)).toBe(true);
    });

    it('encrypted for other devices only: null, and nothing is fetched', async () => {
        const h = harness(Buffer.from('x'));
        const path = await saveFileFromS3(
            { pushId: 'p', senderPublicKey: 'pk' },
            { fileKey: 'fk', fileName: 'a.bin', iv: 'aXY=', deviceKeyMap: { dev_other: '{}' } },
            h.deps,
        );
        expect(path).toBeNull();
        expect(h.calls).toEqual([]);
        expect(existsSync(join(h.dir, 'a.bin'))).toBe(false);
    });

    it('legacy account-key wrap (encryptedKey, no deviceKeyMap) is refused with a clear reason', async () => {
        const h = harness(Buffer.from('x'));
        await expect(saveFileFromS3({ pushId: 'p' }, { fileKey: 'fk', fileName: 'a.bin', iv: 'aXY=', encryptedKey: 'k' }, h.deps))
            .rejects.toThrow(/legacy account-key/);
        expect(h.calls).toEqual([]);
    });

    it('a slot for us but no senderPublicKey on the push, or no iv on the file, is refused before any fetch', async () => {
        const h = harness(Buffer.from('x'));
        await expect(saveFileFromS3({ pushId: 'p' }, { fileKey: 'fk', fileName: 'a', iv: 'aXY=', deviceKeyMap: { [ME]: '{}' } }, h.deps))
            .rejects.toThrow(/senderPublicKey/);
        await expect(saveFileFromS3({ pushId: 'p', senderPublicKey: 'pk' }, { fileKey: 'fk', fileName: 'a', deviceKeyMap: { [ME]: '{}' } }, h.deps))
            .rejects.toThrow(/no iv/);
        expect(h.calls).toEqual([]);
    });

    it('no fileKey, no attachment context, or a body-less download each throw', async () => {
        const h = harness(null);
        await expect(saveFileFromS3({ pushId: 'p' }, { fileName: 'a' }, h.deps)).rejects.toThrow(/no fileKey/);
        await expect(saveFileFromS3({ pushId: 'p' }, { fileKey: 'fk', fileName: 'a' }, { ...h.deps, ctx: null })).rejects.toThrow(/context/);
        await expect(saveFileFromS3({ pushId: 'p' }, { fileKey: 'fk', fileName: 'a' }, h.deps)).rejects.toThrow(/no body/);
    });

    it('a rejected metadata call or download status surfaces as an error, nothing on disk', async () => {
        const meta = harness(Buffer.from('x'), { metaStatus: 403 });
        await expect(saveFileFromS3({ pushId: 'p' }, { fileKey: 'fk', fileName: 'a.bin' }, meta.deps)).rejects.toThrow(/metadata 403/);
        const bin = harness(Buffer.from('x'), { binStatus: 500 });
        await expect(saveFileFromS3({ pushId: 'p' }, { fileKey: 'fk', fileName: 'a.bin' }, bin.deps)).rejects.toThrow(/download 500/);
        expect(existsSync(join(bin.dir, 'a.bin'))).toBe(false);
    });

    it('a sender-chosen name cannot leave the downloads dir', async () => {
        const h = harness(Buffer.from('x'));
        const path = await saveFileFromS3({ pushId: 'p' }, { fileKey: 'fk', fileName: '../../escape.txt' }, h.deps);
        expect(path).toBe(join(h.dir, 'escape.txt'));
    });
});
