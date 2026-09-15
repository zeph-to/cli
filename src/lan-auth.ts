import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Local transfer (ADR-0013) — sender authentication, shared by every
 * implementation of the contract: this file, its byte-exact twin in
 * `mcp-server/src/lan-auth.ts`, and the Kotlin / Swift uploaders. They
 * stay in step by `lan-auth.vectors.json`, not by reading each other.
 *
 * The device keys are ECDH-only (WebCrypto `deriveKey`), so there is no
 * signature primitive. What both sides can compute offline is the ECDH
 * secret, and from it two keys:
 *
 *   macKey  = HKDF-SHA256(ikm = ECDH(sender priv, receiver pub), salt = "", info = "zeph-lan-v1", 32)
 *   metaKey = HKDF-SHA256(same ikm,                               salt = "", info = "zeph-lan-v1-meta", 32)
 *   mac     = HMAC-SHA256(macKey, method | path | senderDeviceId | transferId | timestamp | nonce | sha256(body))
 *   meta    = base64( iv[12] || AES-256-GCM(metaKey, iv, json) )      — upload only
 *
 * The receiver derives the same keys from its own private key and the
 * sender's registered public key (the device list it already fetches), so
 * a valid MAC proves the sender holds the private half of a key the
 * account registered — and binds the route, the body, the transfer and
 * the moment. The MAC over `sha256(body)` can only be checked once the
 * body has arrived; the header-level checks (shape, clock, nonce, known
 * sender) run before a byte of it is read. The metadata is sealed because
 * the transport is plain HTTP on a LAN: a sniffer sees a sender device id
 * and a transfer id, never a file name or the account's device list.
 */

export const LAN_AUTH_INFO = 'zeph-lan-v1';
export const LAN_META_INFO = 'zeph-lan-v1-meta';
/** A request whose timestamp is further from now than this is refused. */
export const LAN_CLOCK_SKEW_MS = 5 * 60_000;
export const LAN_NONCE_TTL_MS = LAN_CLOCK_SKEW_MS;
/** Nonces remembered per sender within the window — a legitimate device sends
 *  two per transfer, so this is hundreds of transfers in five minutes. A sender
 *  that exceeds it is refused until entries expire, never trimmed. */
export const LAN_NONCES_PER_SENDER = 1000;
/** The ping has no transfer; this stands in so the canonical string keeps its shape. */
export const LAN_PING_TRANSFER_ID = 'ping';

export const LAN_PATHS = {
    ping: '/zeph/lan/v1/ping',
    upload: '/zeph/lan/v1/upload',
} as const;

/** Header names, lower-case as Node hands them to a server. */
export const LAN_HEADERS = {
    sender: 'x-zeph-lan-sender',
    transfer: 'x-zeph-lan-transfer',
    timestamp: 'x-zeph-lan-timestamp',
    nonce: 'x-zeph-lan-nonce',
    mac: 'x-zeph-lan-mac',
    /** Sealed `{ fileName, fileType, fileSize, iv, deviceKeyMap, transferId }` — upload only. */
    meta: 'x-zeph-lan-meta',
} as const;

export interface LanAuthFields {
    /** HTTP method, upper-case. */
    method: string;
    /** Request path, one of `LAN_PATHS`. */
    path: string;
    senderDeviceId: string;
    transferId: string;
    /** Unix time in milliseconds, the sender's clock. */
    timestamp: number;
    /** 16 random bytes, lower-case hex. */
    nonce: string;
    /** SHA-256 of the raw request body, lower-case hex. Empty body → hash of nothing. */
    bodySha256: string;
}

const DEVICE_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const TRANSFER_ID = /^[A-Za-z0-9_-]{1,64}$/;
const HEX_32 = /^[0-9a-f]{32}$/;
const HEX_64 = /^[0-9a-f]{64}$/;
const TIMESTAMP = /^[0-9]{1,16}$/;

/** A transfer id is a single safe path segment — it names a landing directory. */
export const isTransferId = (v: string): boolean => TRANSFER_ID.test(v);

export const sha256Hex = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex');
export const EMPTY_BODY_SHA256 = sha256Hex(Buffer.alloc(0));

/** Incremental body hash for a streamed request. */
export const createBodyHasher = (): { update: (chunk: Buffer) => void; digestHex: () => string } => {
    const hash = createHash('sha256');
    return { update: (chunk) => { hash.update(chunk); }, digestHex: () => hash.digest('hex') };
};

export interface LanKeys {
    macKey: Buffer;
    metaKey: Buffer;
}

/** Both keys from the raw ECDH secret. */
export const deriveLanKeys = (sharedSecret: Buffer): LanKeys => ({
    macKey: Buffer.from(hkdfSync('sha256', sharedSecret, Buffer.alloc(0), LAN_AUTH_INFO, 32)),
    metaKey: Buffer.from(hkdfSync('sha256', sharedSecret, Buffer.alloc(0), LAN_META_INFO, 32)),
});

export const canonicalString = (f: LanAuthFields): string =>
    [f.method, f.path, f.senderDeviceId, f.transferId, String(f.timestamp), f.nonce, f.bodySha256].join('|');

export const signLanRequest = (macKey: Buffer, f: LanAuthFields): string =>
    createHmac('sha256', macKey).update(canonicalString(f)).digest('hex');

/** Constant-time compare; a MAC of the wrong length is simply wrong. */
export const verifyLanMac = (macKey: Buffer, f: LanAuthFields, mac: string): boolean => {
    if (!HEX_64.test(mac)) return false;
    const expected = Buffer.from(signLanRequest(macKey, f), 'hex');
    return timingSafeEqual(expected, Buffer.from(mac, 'hex'));
};

export const newNonce = (): string => randomBytes(16).toString('hex');

// ─── Sealed metadata ───

const META_IV_BYTES = 12;
const META_TAG_BYTES = 16;
/** Largest sealed header accepted (base64 characters). A 5-device key map is
 *  well under 2 KiB; the ceiling stays under Node's 16 KiB `maxHeaderSize`
 *  for all headers together, so it is this check that refuses, not the parser. */
export const LAN_META_MAX_BYTES = 8 * 1024;

/** `iv || ciphertext || tag`, base64 — what goes in `X-Zeph-Lan-Meta`. */
export const sealMeta = (metaKey: Buffer, meta: object, iv: Buffer = randomBytes(META_IV_BYTES)): string => {
    const cipher = createCipheriv('aes-256-gcm', metaKey, iv);
    const body = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(meta), 'utf8')), cipher.final()]);
    return Buffer.concat([iv, body, cipher.getAuthTag()]).toString('base64');
};

/** Inverse of `sealMeta`. Null on any shape or authentication failure — never throws. */
export const openMeta = (metaKey: Buffer, sealed: string | string[] | undefined): unknown => {
    if (typeof sealed !== 'string' || sealed.length === 0 || sealed.length > LAN_META_MAX_BYTES) return null;
    const raw = Buffer.from(sealed, 'base64');
    if (raw.length < META_IV_BYTES + META_TAG_BYTES) return null;
    try {
        const decipher = createDecipheriv('aes-256-gcm', metaKey, raw.subarray(0, META_IV_BYTES));
        decipher.setAuthTag(raw.subarray(raw.length - META_TAG_BYTES));
        const json = Buffer.concat([decipher.update(raw.subarray(META_IV_BYTES, raw.length - META_TAG_BYTES)), decipher.final()]);
        return JSON.parse(json.toString('utf8')) as unknown;
    } catch {
        return null;
    }
};

// ─── Headers ───

export type LanAuthHeaderFields = Omit<LanAuthFields, 'bodySha256' | 'method' | 'path'> & { mac: string };

/** What a sender puts on the request; the receiver parses it back with `parseLanAuthHeaders`. */
export const toLanAuthHeaders = (f: Omit<LanAuthFields, 'bodySha256' | 'method' | 'path'>, mac: string): Record<string, string> => ({
    [LAN_HEADERS.sender]: f.senderDeviceId,
    [LAN_HEADERS.transfer]: f.transferId,
    [LAN_HEADERS.timestamp]: String(f.timestamp),
    [LAN_HEADERS.nonce]: f.nonce,
    [LAN_HEADERS.mac]: mac,
});

const one = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? undefined : v);

/**
 * Shape check only — null when any header is missing or malformed. Runs
 * before the body, before any crypto, before any lookup: a probe that
 * gets the shape wrong costs nothing and learns nothing.
 */
export const parseLanAuthHeaders = (
    headers: Record<string, string | string[] | undefined>,
): LanAuthHeaderFields | null => {
    const senderDeviceId = one(headers[LAN_HEADERS.sender]);
    const transferId = one(headers[LAN_HEADERS.transfer]);
    const timestamp = one(headers[LAN_HEADERS.timestamp]);
    const nonce = one(headers[LAN_HEADERS.nonce]);
    const mac = one(headers[LAN_HEADERS.mac]);
    if (
        senderDeviceId === undefined || !DEVICE_ID.test(senderDeviceId)
        || transferId === undefined || !TRANSFER_ID.test(transferId)
        || timestamp === undefined || !TIMESTAMP.test(timestamp)
        || nonce === undefined || !HEX_32.test(nonce)
        || mac === undefined || !HEX_64.test(mac)
    ) return null;
    return { senderDeviceId, transferId, timestamp: Number(timestamp), nonce, mac };
};

export const isTimestampFresh = (timestamp: number, now: number = Date.now(), skewMs: number = LAN_CLOCK_SKEW_MS): boolean =>
    Math.abs(now - timestamp) <= skewMs;

// ─── Replay guard ───

export interface NonceRegistry {
    /** True when `nonce` has been recorded for `sender` within the TTL. */
    seen: (sender: string, nonce: string, now?: number) => boolean;
    /** Record a verified nonce. False when it was already there (a concurrent
     *  replay won the race) or the sender's bucket is full — the caller
     *  refuses in both cases. */
    commit: (sender: string, nonce: string, now?: number) => boolean;
    size: () => number;
}

/**
 * Replay guard. In memory on purpose (ADR-0013): a restart reopens a
 * window of one clock-skew period, and the worst case is the same
 * ciphertext saved once more as `name (2).ext`.
 *
 * Two properties an earlier shape lacked: nothing is recorded until the
 * MAC has verified, so an unauthenticated peer cannot touch it; and it is
 * partitioned per sender with a fixed quota that refuses rather than
 * evicts, so no device — not even a hostile one on the account — can push
 * another device's nonce out and reopen a replay. Expired entries are the
 * only thing ever removed.
 */
export const createNonceRegistry = (perSender: number = LAN_NONCES_PER_SENDER, ttlMs: number = LAN_NONCE_TTL_MS): NonceRegistry => {
    const buckets = new Map<string, Map<string, number>>();   // sender → nonce → recorded at (insertion-ordered)
    const bucketFor = (sender: string, now: number): Map<string, number> => {
        const bucket = buckets.get(sender) ?? new Map<string, number>();
        for (const [nonce, at] of bucket) {
            if (now - at <= ttlMs) break;   // the rest are newer
            bucket.delete(nonce);
        }
        if (bucket.size === 0) buckets.delete(sender); else buckets.set(sender, bucket);
        return bucket;
    };
    return {
        seen: (sender, nonce, now = Date.now()) => bucketFor(sender, now).has(nonce),
        commit: (sender, nonce, now = Date.now()) => {
            const bucket = bucketFor(sender, now);
            if (bucket.has(nonce) || bucket.size >= perSender) return false;
            bucket.set(nonce, now);
            buckets.set(sender, bucket);
            return true;
        },
        size: () => { let n = 0; for (const b of buckets.values()) n += b.size; return n; },
    };
};
