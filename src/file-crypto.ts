import { createDecipheriv, randomBytes } from 'node:crypto';
import { createWriteStream, mkdirSync, rmSync } from 'node:fs';
import { link, open, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/**
 * Streaming decrypt of a file the web / MCP side produced with
 * `libs/crypto` `encryptFile` (WebCrypto AES-256-GCM, 12-byte IV). That
 * API is one-shot; a 1 GiB attachment would sit in memory here, so this
 * is the same wire format on `node:crypto`'s incremental cipher:
 * WebCrypto appends the 16-byte GCM tag to the ciphertext, and the stream
 * holds back the last 16 bytes of whatever it is fed as that tag.
 *
 * The key is the raw per-file AES key, already unwrapped from the
 * attachment's `deviceKeyMap` slot (see `unwrapDeviceKey` in crypto.ts).
 */

export const GCM_TAG_BYTES = 16;
export const GCM_IV_BYTES = 12;

export const createFileDecryptStream = (rawKey: Buffer, iv: Buffer): Transform => {
    if (rawKey.length !== 32) throw new Error(`file key must be 32 bytes, got ${rawKey.length}`);
    if (iv.length !== GCM_IV_BYTES) throw new Error(`file iv must be ${GCM_IV_BYTES} bytes, got ${iv.length}`);
    const decipher = createDecipheriv('aes-256-gcm', rawKey, iv);
    let tail: Buffer = Buffer.alloc(0);
    return new Transform({
        transform(chunk: Buffer, _enc, done) {
            const joined = tail.length ? Buffer.concat([tail, chunk]) : chunk;
            if (joined.length <= GCM_TAG_BYTES) {
                tail = joined;
                done();
                return;
            }
            const body = joined.subarray(0, joined.length - GCM_TAG_BYTES);
            tail = Buffer.from(joined.subarray(joined.length - GCM_TAG_BYTES));
            done(null, decipher.update(body));
        },
        flush(done) {
            if (tail.length < GCM_TAG_BYTES) {
                done(new Error('ciphertext shorter than the GCM tag'));
                return;
            }
            try {
                decipher.setAuthTag(tail);
                done(null, decipher.final());   // throws on a bad tag: tampered, truncated, wrong key
            } catch (err) {
                done(err instanceof Error ? err : new Error(String(err)));
            }
        },
    });
};

/**
 * Abort `controller` when `source` goes quiet for `idleMs`. A stalled S3
 * connection would otherwise park a download — and its part file — for
 * the life of the daemon with nothing in the log. Bytes still flowing,
 * however slowly, never trip it: a 1 GiB file on a bad link is not a stall.
 */
export const withIdleTimeout = (source: Readable, idleMs: number, controller: AbortController): Readable => {
    let timer: NodeJS.Timeout | null = null;
    const arm = (): void => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => controller.abort(new Error(`no bytes for ${idleMs} ms`)), idleMs);
        timer.unref();
    };
    const guard = new Transform({
        transform(chunk: Buffer, _enc, done) { arm(); done(null, chunk); },
        flush(done) { if (timer) clearTimeout(timer); done(); },
    });
    arm();
    // `pipeline`, not `pipe`: a failure downstream (bad tag, disk, name cap)
    // must destroy the source too, or the response body sits open until the
    // idle timer fires. Errors surface through the returned stream.
    void pipeline(source, guard).catch(() => undefined);
    return guard;
};

export interface SavedFile {
    path: string;
    bytes: number;
}

/** How many `nextDest()` candidates `saveStream` tries before giving up. */
const MAX_LINK_ATTEMPTS = 100;

const isErrno = (err: unknown, code: string): boolean =>
    typeof err === 'object' && err !== null && 'code' in err && err.code === code;

/**
 * Stream `source` to the path `nextDest()` names, optionally decrypting
 * on the way. The bytes go to a private `.part` file first (a per-call
 * random name, so two saves of the same file cannot touch each other's
 * temp) and are fsynced before being linked into place — a reader never
 * sees a half file, and an authentication failure (which GCM only reports
 * at the very end) leaves nothing behind. `link` refuses an existing dest
 * where `rename` would replace it; on that collision `nextDest()` is asked
 * again, so a name taken between the caller's check and here costs a
 * ` (n)` suffix, never the download. Resolves with the path written and
 * the plaintext byte count.
 */
export const saveStream = async (
    source: Readable,
    nextDest: () => string,
    decrypt?: { rawKey: Buffer; iv: Buffer },
): Promise<SavedFile> => {
    const first = nextDest();
    const dir = dirname(first);
    mkdirSync(dir, { recursive: true });
    const part = join(dir, `.zeph-${randomBytes(6).toString('hex')}.part`);
    let bytes = 0;
    const counter = new Transform({
        transform(chunk: Buffer, _enc, done) { bytes += chunk.length; done(null, chunk); },
    });
    try {
        const sink = createWriteStream(part, { flags: 'wx' });
        if (decrypt) await pipeline(source, createFileDecryptStream(decrypt.rawKey, decrypt.iv), counter, sink);
        else await pipeline(source, counter, sink);
        const fh = await open(part, 'r+');
        try { await fh.sync(); } finally { await fh.close(); }
        let dest = first;
        for (let attempt = 1; ; attempt++) {
            try {
                await link(part, dest);
                break;
            } catch (err) {
                if (!isErrno(err, 'EEXIST') || attempt >= MAX_LINK_ATTEMPTS) throw err;
                dest = nextDest();
            }
        }
        // The file is in place; a temp that will not go is not a failed save.
        await unlink(part).catch(() => undefined);
        return { path: dest, bytes };
    } catch (err) {
        rmSync(part, { force: true });
        throw err;
    }
};
