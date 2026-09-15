import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { safeFileName } from './downloads.js';
import { saveStream } from './file-crypto.js';
import {
    EMPTY_BODY_SHA256,
    LAN_HEADERS,
    LAN_PATHS,
    LAN_PING_TRANSFER_ID,
    createBodyHasher,
    createNonceRegistry,
    deriveLanKeys,
    isTimestampFresh,
    openMeta,
    parseLanAuthHeaders,
    verifyLanMac,
    type LanAuthHeaderFields,
    type LanKeys,
    type NonceRegistry,
} from './lan-auth.js';

/**
 * Local transfer (ADR-0013) — the listener's LAN-facing HTTP server.
 *
 * Binds an OS-assigned port on every interface; the port is what
 * `lan-endpoint.ts` publishes. Nothing here is reachable from the internet
 * on purpose (the server only ever stores a private IPv4 for it), but a
 * public Wi-Fi is a LAN too, so every route authenticates before it reads
 * a body, and an unauthenticated peer learns nothing: every refusal it can
 * reach is a 401 with an empty body — the same one, whatever the reason.
 *
 * Two routes:
 *   GET  /zeph/lan/v1/ping    — "are you the device I think, and on my LAN?"
 *                               MAC over an empty body; answers `{deviceId}`.
 *   POST /zeph/lan/v1/upload  — raw ciphertext body, sealed metadata in
 *                               `X-Zeph-Lan-Meta`; decrypted as it streams
 *                               into `<landingDir>/<transferId>/<fileName>`.
 *                               The push record for it arrives over the
 *                               WebSocket afterwards and moves the file to
 *                               the Downloads folder (listener.ts).
 *
 * Order on an upload: header shape → clock → nonce not
 * yet seen → sender on the account → keys → the sealed meta opens. That
 * last step is the pre-body proof: the meta is AES-GCM under a key only
 * the real holder of that device's private key can derive, so a peer that
 * merely knows a registered device id gets no further than 401 either.
 * Only then do the statuses that say anything about this machine appear
 * (409 transfer known, 503 busy, 411/413 length, 400 not wrapped for us),
 * all still before the body. The MAC binds sha256(body), so it is checked
 * when the last byte is in; so is the GCM tag. Either failing removes what
 * was written. The nonce is recorded only once the MAC has verified.
 */

export interface LanReceiverOptions {
    log: (msg: string) => void;
    /** A server error after the bind. The socket is unusable from here;
     *  the caller retracts the endpoint and turns the feature off. */
    onError?: (err: Error) => void;
    deviceId: () => string;
    /** Registered public key (Base64 SPKI) of a device on this account, or null. */
    lookupSenderPublicKey: (deviceId: string) => Promise<string | null>;
    /** ECDH secret between this device and `peerPublicKeyRaw` (crypto.ts `deriveLanSharedSecret`). */
    deriveSharedSecret: (peerPublicKeyRaw: string) => Promise<Buffer>;
    /** Open this device's `deviceKeyMap` slot (crypto.ts `unwrapDeviceKey`). */
    unwrapFileKey: (entryJson: string, senderPublicKeyRaw: string) => Promise<Buffer>;
    /** Where finished transfers wait for their push record: `~/.zeph/attachments/lan`. */
    landingDir: () => string;
    now?: () => number;
    maxBodyBytes?: number;
    maxInFlight?: number;
    /** Open sockets, of any state, the receiver holds at once. */
    maxConnections?: number;
    nonces?: NonceRegistry;
    /** A body that sends no bytes for this long is dead. */
    idleTimeoutMs?: number;
}

export interface LanReceiver {
    port: number;
    /** Close the socket. Idempotent; resolves once the port is released. */
    stop: () => Promise<void>;
}

/** The Pro relay ceiling (`TIER_LIMITS.pro.fileMaxBytes`) — LAN is never the smaller pipe. */
export const LAN_MAX_BODY_BYTES = 1_073_741_824;
export const LAN_MAX_IN_FLIGHT = 2;
/** The sockets are the daemon's file descriptors, shared with the relay
 *  WebSocket: a LAN flood may exhaust local transfer (sends fall back to the
 *  relay), never the daemon. */
export const LAN_MAX_CONNECTIONS = 64;
export const LAN_BODY_IDLE_MS = 60_000;
/** Derived key sets kept; the account has a handful of devices. */
const KEY_CACHE_MAX = 64;
/** After a pre-body refusal, how long the client may keep sending before the socket goes. */
const REFUSE_GRACE_MS = 1_000;

interface LanMeta {
    fileName: string;
    fileType?: string;
    fileSize?: number;
    iv: string;
    deviceKeyMap: Record<string, string>;
    transferId: string;
}

const asMeta = (parsed: unknown): LanMeta | null => {
    if (typeof parsed !== 'object' || parsed === null) return null;
    const m = parsed as Record<string, unknown>;
    const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
    if (!isStr(m.fileName) || !isStr(m.iv) || !isStr(m.transferId)) return null;
    if (typeof m.deviceKeyMap !== 'object' || m.deviceKeyMap === null) return null;
    const deviceKeyMap: Record<string, string> = {};
    for (const [k, v] of Object.entries(m.deviceKeyMap as Record<string, unknown>)) {
        if (typeof v !== 'string') return null;
        deviceKeyMap[k] = v;
    }
    if (Buffer.from(m.iv, 'base64').length !== 12) return null;
    return {
        fileName: m.fileName,
        fileType: isStr(m.fileType) ? m.fileType : undefined,
        fileSize: typeof m.fileSize === 'number' ? m.fileSize : undefined,
        iv: m.iv,
        deviceKeyMap,
        transferId: m.transferId,
    };
};

const end = (res: ServerResponse, status: number, body?: object): void => {
    res.statusCode = status;
    if (body) {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(body));
    } else {
        res.end();
    }
};

/**
 * Refuse before the body: answer, then discard what the client is still
 * writing for a short grace; a body still arriving after it takes the
 * socket down. A client mid-write whose bytes stop being read — or whose
 * socket is closed under it, which is what `Connection: close` does —
 * sees a reset, not the 413 it needs to fall back on. The grace bounds
 * what that costs: never the whole gigabyte. A body that finishes inside
 * it leaves the connection usable.
 */
const refuse = (req: IncomingMessage, res: ServerResponse, status: number): void => {
    res.statusCode = status;
    req.resume();
    res.end(() => {
        if (req.complete) return;
        const timer = setTimeout(() => req.socket.destroy(), REFUSE_GRACE_MS);
        timer.unref();
        const clear = () => clearTimeout(timer);
        req.once('end', clear);
        req.socket.once('close', clear);
    });
};

export const startLanReceiver = (opts: LanReceiverOptions): Promise<LanReceiver> =>
    new Promise((resolve, reject) => {
        const now = opts.now ?? (() => Date.now());
        const maxBody = opts.maxBodyBytes ?? LAN_MAX_BODY_BYTES;
        const maxInFlight = opts.maxInFlight ?? LAN_MAX_IN_FLIGHT;
        const idleMs = opts.idleTimeoutMs ?? LAN_BODY_IDLE_MS;
        const nonces = opts.nonces ?? createNonceRegistry();
        // sender public key → derived keys. The secret is static per pair, and
        // a P-256 derive per request would be the cheapest CPU an outsider
        // who sniffed a device id could buy. With this cache and the device
        // directory's miss brake, the pre-MAC work anyone can buy is a header
        // parse and two map lookups — nothing worth rationing, so there is no
        // request budget for an outsider to drain and lock real senders out.
        const keyCache = new Map<string, LanKeys>();
        let inFlight = 0;
        // Transfer ids with an upload in progress: the 409 must hold from the
        // first byte, not from when the directory appears.
        const active = new Set<string>();

        const keysFor = async (publicKey: string): Promise<LanKeys> => {
            const hit = keyCache.get(publicKey);
            if (hit) return hit;
            const keys = deriveLanKeys(await opts.deriveSharedSecret(publicKey));
            if (keyCache.size >= KEY_CACHE_MAX) keyCache.delete(keyCache.keys().next().value ?? '');
            keyCache.set(publicKey, keys);
            return keys;
        };

        /** Spend a nonce whose MAC held. A refusal here is a replay race or a
         *  sender over its quota — the peer sees the same 401, the log says which. */
        const commitNonce = (sender: string, nonce: string): boolean => {
            if (nonces.commit(sender, nonce, now())) return true;
            opts.log(`local transfer: nonce refused for ${sender} (a replay, or the sender is over its quota)`);
            return false;
        };

        interface Authed { keys: LanKeys; fields: LanAuthHeaderFields; senderPublicKey: string }

        /**
         * Everything an outsider can reach ends here with one answer: 401,
         * empty. Resolves the sender's keys once the headers are well formed,
         * fresh, unreplayed, and name a device of this account with a key we
         * can derive against; the MAC itself is the caller's, because on an
         * upload it binds a body that has not arrived yet.
         */
        const authenticate = async (req: IncomingMessage, res: ServerResponse): Promise<Authed | null> => {
            const fields = parseLanAuthHeaders(req.headers);
            if (!fields) { refuse(req, res, 401); return null; }
            if (!isTimestampFresh(fields.timestamp, now())) { refuse(req, res, 401); return null; }
            if (nonces.seen(fields.senderDeviceId, fields.nonce, now())) { refuse(req, res, 401); return null; }
            let senderPublicKey: string | null = null;
            try {
                senderPublicKey = await opts.lookupSenderPublicKey(fields.senderDeviceId);
            } catch (err) {
                opts.log(`local transfer: device lookup failed — ${err instanceof Error ? err.message : String(err)}`);
            }
            if (!senderPublicKey) { refuse(req, res, 401); return null; }
            let keys: LanKeys;
            try {
                keys = await keysFor(senderPublicKey);
            } catch {
                refuse(req, res, 401);   // a public key that will not import is not a sender we can trust
                return null;
            }
            return { keys, fields, senderPublicKey };
        };

        const ping = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
            const auth = await authenticate(req, res);
            if (!auth) return;
            const { keys, fields } = auth;
            const ok = fields.transferId === LAN_PING_TRANSFER_ID
                && verifyLanMac(keys.macKey, { ...fields, method: 'GET', path: LAN_PATHS.ping, bodySha256: EMPTY_BODY_SHA256 }, fields.mac)
                && commitNonce(fields.senderDeviceId, fields.nonce);
            if (!ok) { refuse(req, res, 401); return; }
            end(res, 200, { deviceId: opts.deviceId() });
        };

        const upload = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
            const auth = await authenticate(req, res);
            if (!auth) return;
            const { keys, fields, senderPublicKey } = auth;
            // The sealed meta only opens under the real sender's key: this is
            // where an impersonator with a genuine device id stops, at the
            // same 401 as everyone else.
            const opened = openMeta(keys.metaKey, req.headers[LAN_HEADERS.meta]);
            if (opened === null) { refuse(req, res, 401); return; }

            // From here the peer is a device of this account: the answers may
            // say something about this machine. Still all before the body.
            const meta = asMeta(opened);
            if (!meta || meta.transferId !== fields.transferId) { refuse(req, res, 400); return; }
            if (active.has(meta.transferId)) { refuse(req, res, 409); return; }
            if (inFlight >= maxInFlight) { refuse(req, res, 503); return; }
            inFlight++;
            active.add(meta.transferId);
            const reserved = meta.transferId;
            try {
                const lengthHeader = req.headers['content-length'];
                if (lengthHeader === undefined || req.headers['transfer-encoding'] !== undefined) { refuse(req, res, 411); return; }
                const declared = Number(lengthHeader);
                if (!Number.isInteger(declared) || declared < 0) { refuse(req, res, 400); return; }
                if (declared > maxBody) { refuse(req, res, 413); return; }
                const slot = meta.deviceKeyMap[opts.deviceId()];
                if (!slot) { refuse(req, res, 400); return; }
                const transferDir = join(opts.landingDir(), meta.transferId);
                let rawKey: Buffer;
                try {
                    rawKey = await opts.unwrapFileKey(slot, senderPublicKey);
                } catch {
                    refuse(req, res, 400);   // wrapped, but not for this device's key
                    return;
                }
                try {
                    // The parent on demand (a fresh install has no ~/.zeph/attachments/lan);
                    // the transfer dir itself exclusively, so a second upload is 409.
                    mkdirSync(opts.landingDir(), { recursive: true });
                    mkdirSync(transferDir, { recursive: false });
                } catch (err) {
                    if ((err as NodeJS.ErrnoException).code === 'EEXIST') { refuse(req, res, 409); return; }
                    throw err;
                }

                const hasher = createBodyHasher();
                let received = 0;
                const tee = new Transform({
                    transform(chunk: Buffer, _enc, done) {
                        received += chunk.length;
                        if (received > declared) { done(new Error('body exceeds Content-Length')); return; }
                        hasher.update(chunk);
                        done(null, chunk);
                    },
                });
                // `pipeline`, not `pipe`: a client that drops mid-body must error
                // the tee, or the save waits for bytes that never come and the
                // half-written transfer dir stays until the socket times out.
                void pipeline(req, tee).catch(() => undefined);
                req.setTimeout(idleMs, () => req.destroy(new Error(`no bytes for ${idleMs} ms`)));
                const dest = join(transferDir, safeFileName(meta.fileName));
                try {
                    const saved = await saveStream(tee, () => dest, { rawKey, iv: Buffer.from(meta.iv, 'base64') });
                    // Everything is on disk, decrypted and tag-checked; now the
                    // MAC that binds those bytes to this sender and this moment,
                    // and the nonce is spent only for a MAC that held.
                    const bound = { ...fields, method: 'POST', path: LAN_PATHS.upload, bodySha256: hasher.digestHex() };
                    const ok = received === declared
                        && verifyLanMac(keys.macKey, bound, fields.mac)
                        && commitNonce(fields.senderDeviceId, fields.nonce);
                    if (!ok) {
                        rmSync(transferDir, { recursive: true, force: true });
                        end(res, 401);
                        return;
                    }
                    opts.log(`local transfer: received "${meta.fileName}" (${saved.bytes}B) from ${fields.senderDeviceId} as ${meta.transferId}`);
                    end(res, 201, { transferId: meta.transferId });
                } catch (err) {
                    rmSync(transferDir, { recursive: true, force: true });
                    opts.log(`local transfer: upload ${meta.transferId} failed — ${err instanceof Error ? err.message : String(err)}`);
                    if (!res.headersSent) end(res, 400);
                    else res.destroy();
                }
            } finally {
                inFlight--;
                active.delete(reserved);
            }
        };

        const route = (req: IncomingMessage, res: ServerResponse): void => {
            const url = req.url ?? '';
            const handler = req.method === 'GET' && url === LAN_PATHS.ping ? ping
                : req.method === 'POST' && url === LAN_PATHS.upload ? upload
                : null;
            if (!handler) { refuse(req, res, 404); return; }
            handler(req, res).catch((err: unknown) => {
                opts.log(`local transfer: request failed — ${err instanceof Error ? err.message : String(err)}`);
                if (!res.headersSent) refuse(req, res, 500);
                else res.destroy();
            });
        };

        // A client that opens a socket and never sends headers must not hold
        // it: Node enforces `headersTimeout` only on each connections check
        // (30 s by default), so the check runs every second for the 5 s to be
        // real. The body has no wall-clock budget — a 1 GiB file on Wi-Fi
        // takes what it takes — only the idle timeout set per upload above.
        const server: Server = createServer({ connectionsCheckingInterval: 1_000 }, route);
        server.headersTimeout = 5_000;
        server.requestTimeout = 0;
        server.maxConnections = opts.maxConnections ?? LAN_MAX_CONNECTIONS;
        let listening = false;
        // Stays attached for the server's whole life: an `error` with no
        // listener is an uncaught throw, and this socket must never be the
        // thing that takes the relay-serving daemon down with it.
        server.on('error', (err: Error) => {
            if (!listening) { reject(err); return; }
            opts.log(`local transfer: server error — ${err.message}`);
            opts.onError?.(err);
        });
        server.listen(0, '0.0.0.0', () => {
            listening = true;
            const address = server.address();
            if (typeof address !== 'object' || address === null) {
                // Cannot happen after a TCP listen; if it does, publishing
                // port 0 would only be refused by the server, silently.
                server.close();
                reject(new Error('bound socket reported no address'));
                return;
            }
            const port = address.port;
            opts.log(`local transfer: listening on 0.0.0.0:${port}`);

            let closed: Promise<void> | null = null;
            const stop = (): Promise<void> => {
                if (closed) return closed;
                closed = new Promise<void>((done) => {
                    server.close(() => done());
                    server.closeAllConnections();
                });
                return closed;
            };
            resolve({ port, stop });
        });
    });
