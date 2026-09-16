import { randomBytes } from 'node:crypto';
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
    verifyLanReceipt,
    type LanKeys,
} from './lan-auth.js';

/**
 * Local transfer (ADR-0013) — the sending half. Byte-exact in `@zeph-to/cli`
 * and `@zeph-to/mcp-server` (`src/lan-sender.ts`); the contract is `lan-auth.ts`.
 *
 * A file already sealed for its recipients (`encryptFileForDevices`) goes
 * straight to the one target device when that device says, in the device
 * list the send already fetched, that it can be reached: a registered key,
 * a published `lan` endpoint, online. Everything here answers
 * `{ delivered: false, reason }` rather than throwing — the caller's relay
 * path is the fallback for every failure. A device that is not there costs
 * the ping timeout; one that answers the ping and then fails the upload
 * costs up to the upload budget.
 *
 * What counts as delivered is a receipt the sender can check, not a status
 * code: see `signLanReceipt`. A 201 without one is treated as not delivered,
 * and the file goes by relay.
 */

export interface LanDeviceRecord {
    deviceId: string;
    publicKey?: string;
    isOnline?: boolean;
    lan?: { host?: unknown; port?: unknown } | null;
}

export interface LanTarget {
    deviceId: string;
    publicKey: string;
    host: string;
    port: number;
}

/**
 * The device a push can go to directly, or null for the relay: a push with
 * no single target (a broadcast) never qualifies, nor does a target without
 * a key, an endpoint, or a live connection.
 */
export const pickLanTarget = (devices: LanDeviceRecord[], targetDeviceId: string | undefined): LanTarget | null => {
    if (!targetDeviceId) return null;
    const device = devices.find((d) => d.deviceId === targetDeviceId);
    if (!device?.publicKey || device.isOnline !== true || !device.lan) return null;
    const { host, port } = device.lan;
    if (typeof host !== 'string' || host.length === 0 || typeof port !== 'number' || !Number.isInteger(port)) return null;
    return { deviceId: device.deviceId, publicKey: device.publicKey, host, port };
};

export interface LanSealedFile {
    fileName: string;
    fileType?: string;
    /** Plaintext size, as the push record reports it. */
    fileSize: number;
    iv: string;
    deviceKeyMap: Record<string, string>;
    ciphertext: Buffer;
}

export interface LanDeliveryInput {
    target: LanTarget;
    senderDeviceId: string;
    /** ECDH secret between this sender's private key and `publicKey` (raw 32 bytes). */
    deriveSharedSecret: (publicKey: string) => Promise<Buffer>;
    file: LanSealedFile;
    fetchFn?: typeof fetch;
    pingTimeoutMs?: number;
    /** Upload budget; defaults to `lanUploadTimeoutMs(ciphertext.length)`. */
    uploadTimeoutMs?: number;
    /** The caller's own cancellation (a tool call the agent abandoned). */
    signal?: AbortSignal;
}

export type LanDeliveryResult =
    | { delivered: true; transferId: string }
    | { delivered: false; reason: string };

/** A receiver that is there answers a ping on the same network in milliseconds. */
export const LAN_PING_TIMEOUT_MS = 1_500;

/** 30 s, plus one second per MiB — slower than any Wi-Fi a LAN transfer is worth trying on. */
export const lanUploadTimeoutMs = (bytes: number): number => 30_000 + Math.ceil(bytes / 1_048_576) * 1_000;

const newTransferId = (): string => `lt_${randomBytes(12).toString('hex')}`;

/** A ping answer is `{"deviceId": "..."}`; anything longer is not a receiver. */
const PING_BODY_MAX_BYTES = 1024;
const UPLOAD_CHUNK_BYTES = 1_048_576;

/** Fires on the timeout or the caller's signal, whichever comes first
 *  (`AbortSignal.any` is Node 20+; both packages support 18). `release`
 *  detaches from the caller's signal, which may outlive this request. */
const deadline = (timeoutMs: number, external: AbortSignal | undefined): { signal: AbortSignal; release: () => void } => {
    const timeout = AbortSignal.timeout(timeoutMs);
    if (!external) return { signal: timeout, release: () => undefined };
    const controller = new AbortController();
    const onExternal = (): void => { controller.abort(external.reason); };
    const onTimeout = (): void => { controller.abort(timeout.reason); };
    external.addEventListener('abort', onExternal, { once: true });
    timeout.addEventListener('abort', onTimeout, { once: true });
    if (external.aborted) onExternal();
    return {
        signal: controller.signal,
        release: () => {
            external.removeEventListener('abort', onExternal);
            timeout.removeEventListener('abort', onTimeout);
        },
    };
};

/**
 * The ciphertext as a stream of views into it. Node's fetch copies a
 * `Uint8Array` body whole — measured at +2× the file for a buffered one — and
 * the file may be a gigabyte already held twice (plaintext and ciphertext).
 * Pulled one chunk at a time, only a chunk is ever in flight.
 */
const bodyStream = (buf: Buffer): ReadableStream<Uint8Array> => {
    let offset = 0;
    return new ReadableStream<Uint8Array>({
        pull(controller) {
            if (offset >= buf.byteLength) { controller.close(); return; }
            const end = Math.min(offset + UPLOAD_CHUNK_BYTES, buf.byteLength);
            controller.enqueue(new Uint8Array(buf.buffer, buf.byteOffset + offset, end - offset));
            offset = end;
        },
    });
};

/** Drop a body we will not read; a peer that never ends it must not hold us. */
const discard = (res: Response): Promise<void> => (res.body ? res.body.cancel().catch(() => undefined) : Promise.resolve());

/** The body as text, or null past `max` bytes — read no further than that. */
const readCapped = async (res: Response, max: number): Promise<string | null> => {
    if (!res.body) return '';
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > max) { await reader.cancel().catch(() => undefined); return null; }
        chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
};

const reasonOf = (err: unknown): string => {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) return 'timed out';
    return err instanceof Error ? err.message : String(err);
};

export const tryLanDelivery = async (input: LanDeliveryInput): Promise<LanDeliveryResult> => {
    const { target, file } = input;
    const fetchFn = input.fetchFn ?? fetch;
    const base = `http://${target.host}:${target.port}`;

    let keys: LanKeys;
    try {
        keys = deriveLanKeys(await input.deriveSharedSecret(target.publicKey));
    } catch (err) {
        return { delivered: false, reason: `key derivation failed: ${reasonOf(err)}` };
    }

    // Ping first: an address that has gone stale, or now belongs to another
    // machine, costs the ping timeout — not an upload of the whole file.
    const pingDeadline = deadline(input.pingTimeoutMs ?? LAN_PING_TIMEOUT_MS, input.signal);
    try {
        const fields = { senderDeviceId: input.senderDeviceId, transferId: LAN_PING_TRANSFER_ID, timestamp: Date.now(), nonce: newNonce() };
        const mac = signLanRequest(keys.macKey, { ...fields, method: 'GET', path: LAN_PATHS.ping, bodySha256: EMPTY_BODY_SHA256 });
        const res = await fetchFn(`${base}${LAN_PATHS.ping}`, {
            headers: toLanAuthHeaders(fields, mac),
            signal: pingDeadline.signal,
        });
        // Status and receipt are headers: decide on them before reading a
        // body whose size and end the peer controls.
        if (res.status !== 200) { await discard(res); return { delivered: false, reason: `ping answered ${res.status}` }; }
        if (!verifyLanReceipt(keys.macKey, mac, res.headers.get(LAN_HEADERS.receipt))) { await discard(res); return { delivered: false, reason: 'ping answered without a valid receipt' }; }
        const body = await readCapped(res, PING_BODY_MAX_BYTES);
        let answeredBy: unknown;
        try { answeredBy = (JSON.parse(body ?? '') as { deviceId?: unknown }).deviceId; } catch { answeredBy = undefined; }
        if (answeredBy !== target.deviceId) return { delivered: false, reason: 'ping answered by another device' };
    } catch (err) {
        return { delivered: false, reason: input.signal?.aborted ? 'cancelled' : `ping failed: ${reasonOf(err)}` };
    } finally {
        pingDeadline.release();
    }

    const transferId = newTransferId();
    const uploadDeadline = deadline(input.uploadTimeoutMs ?? lanUploadTimeoutMs(file.ciphertext.byteLength), input.signal);
    try {
        const fields = { senderDeviceId: input.senderDeviceId, transferId, timestamp: Date.now(), nonce: newNonce() };
        const mac = signLanRequest(keys.macKey, { ...fields, method: 'POST', path: LAN_PATHS.upload, bodySha256: sha256Hex(file.ciphertext) });
        const meta = { fileName: file.fileName, fileType: file.fileType, fileSize: file.fileSize, iv: file.iv, deviceKeyMap: file.deviceKeyMap, transferId };
        const init: RequestInit & { duplex: 'half' } = {
            method: 'POST',
            headers: {
                ...toLanAuthHeaders(fields, mac),
                [LAN_HEADERS.meta]: sealMeta(keys.metaKey, meta),
                'content-type': 'application/octet-stream',
                // Explicit, so a streamed body still goes with a length: the
                // receiver refuses chunked uploads (411).
                'content-length': String(file.ciphertext.byteLength),
            },
            body: bodyStream(file.ciphertext),
            duplex: 'half',
            signal: uploadDeadline.signal,
        };
        const res = await fetchFn(`${base}${LAN_PATHS.upload}`, init);
        await discard(res);
        if (res.status !== 201) return { delivered: false, reason: `upload answered ${res.status}` };
        if (!verifyLanReceipt(keys.macKey, mac, res.headers.get(LAN_HEADERS.receipt))) return { delivered: false, reason: 'upload answered without a valid receipt' };
        return { delivered: true, transferId };
    } catch (err) {
        return { delivered: false, reason: input.signal?.aborted ? 'cancelled' : `upload failed: ${reasonOf(err)}` };
    } finally {
        uploadDeadline.release();
    }
};
