/**
 * Per-device encryption for the Hook SDK — self-contained ECDH P-256 +
 * AES-256-GCM. Mirrors @zeph/crypto API but bundled inline (no external
 * dependency). Uses Web Crypto API via node:crypto webcrypto — Node.js 18+
 * (the `crypto` global only exists unflagged from Node 19, so we import it).
 *
 * How it works (ADR-0007):
 *
 *   This host holds its own ECDH keypair in ~/.zeph/device-keys.json. The
 *   private half is generated here and never leaves — the server only ever
 *   sees public keys. A push is encrypted once with a random AES key, and
 *   that key is wrapped separately for each of the user's registered devices
 *   using ECDH(this host, that device). Same keypair the stream frames below
 *   already used; push and file bodies now share it.
 *
 * What it does not give you:
 *   • Forward secrecy — the ECDH secret for a given (sender, device) pair is
 *     static, so a compromise of either private key retroactively opens every
 *     push wrapped for that pair.
 *   • Authenticity beyond the key pairing — nothing signs `senderPublicKey`.
 *
 * Superseded scheme: a single account-wide keypair whose private half the
 * backend escrowed so it could sync to new devices. Key escrow was removed
 * server-side (zeph@8a6d21b) and `GET /users/me/keys` has returned a public
 * key only ever since. This client used to react by generating a fresh
 * account keypair and PUTting it back — which overwrote the account public
 * key and encrypted to a key no device held. Both that upload path and the
 * account keypair are gone.
 */

/// <reference lib="dom" />

import { readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { webcrypto } from 'node:crypto';

// Node 18 has no `crypto` global (unflagged only from 19.0.0) — resolve the
// Web Crypto implementation explicitly so encryption works on the declared
// minimum runtime instead of silently falling back to plaintext.
const crypto = webcrypto as unknown as Crypto;

// ─── Base64 helpers ───

const toBase64 = (buffer: ArrayBuffer): string => {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
};

const fromBase64 = (base64: string): ArrayBuffer => {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
};

// ─── ECDH key management ───

const ECDH_PARAMS: EcKeyGenParams = { name: 'ECDH', namedCurve: 'P-256' };

interface ExportedKeyPair {
  publicKey: string;   // Base64-encoded SPKI
  privateKey: string;  // Base64-encoded PKCS8
}

const generateKeyPair = async (): Promise<CryptoKeyPair> =>
  crypto.subtle.generateKey(ECDH_PARAMS, true, ['deriveKey', 'deriveBits']);

const exportKeyPair = async (keyPair: CryptoKeyPair): Promise<ExportedKeyPair> => {
  const [publicRaw, privateRaw] = await Promise.all([
    crypto.subtle.exportKey('spki', keyPair.publicKey),
    crypto.subtle.exportKey('pkcs8', keyPair.privateKey),
  ]);
  return { publicKey: toBase64(publicRaw), privateKey: toBase64(privateRaw) };
};

const importPublicKey = async (base64: string): Promise<CryptoKey> =>
  crypto.subtle.importKey('spki', fromBase64(base64), ECDH_PARAMS, true, []);

const importPrivateKey = async (base64: string): Promise<CryptoKey> =>
  crypto.subtle.importKey('pkcs8', fromBase64(base64), ECDH_PARAMS, true, ['deriveKey', 'deriveBits']);

const importKeyPair = async (exported: ExportedKeyPair): Promise<CryptoKeyPair> => {
  const [publicKey, privateKey] = await Promise.all([
    importPublicKey(exported.publicKey),
    importPrivateKey(exported.privateKey),
  ]);
  return { publicKey, privateKey };
};

const deriveAesKey = async (privateKey: CryptoKey, publicKey: CryptoKey): Promise<CryptoKey> =>
  crypto.subtle.deriveKey(
    { name: 'ECDH', public: publicKey },
    privateKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );

// ─── AES-256-GCM encryption ───

interface EncryptedPayload {
  ciphertext: string;
  iv: string;
  encryptedKey: string;
  keyIv: string;
}

const encrypt = async (
  plaintext: string,
  senderPrivateKey: CryptoKey,
  recipientPublicKey: CryptoKey,
  /** Pre-derived ECDH secret for this pair, when the caller keeps one. */
  shared?: CryptoKey,
): Promise<EncryptedPayload> => {
  const messageKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    messageKey,
    new TextEncoder().encode(plaintext),
  );
  const sharedKey = shared ?? await deriveAesKey(senderPrivateKey, recipientPublicKey);
  const rawMessageKey = await crypto.subtle.exportKey('raw', messageKey);
  const keyIv = crypto.getRandomValues(new Uint8Array(12));
  const encryptedKey = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: keyIv }, sharedKey, rawMessageKey);

  return {
    ciphertext: toBase64(ciphertext),
    iv: toBase64(iv.buffer as ArrayBuffer),
    encryptedKey: toBase64(encryptedKey),
    keyIv: toBase64(keyIv.buffer as ArrayBuffer),
  };
};

const decrypt = async (
  payload: EncryptedPayload,
  recipientPrivateKey: CryptoKey,
  senderPublicKey: CryptoKey,
  /** Pre-derived ECDH secret for this pair, when the caller keeps one. */
  shared?: CryptoKey,
): Promise<string> => {
  const sharedKey = shared ?? await deriveAesKey(recipientPrivateKey, senderPublicKey);
  const rawMessageKey = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: new Uint8Array(fromBase64(payload.keyIv)) },
    sharedKey,
    fromBase64(payload.encryptedKey),
  );
  const messageKey = await crypto.subtle.importKey('raw', rawMessageKey, { name: 'AES-GCM' }, false, ['decrypt']);
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: new Uint8Array(fromBase64(payload.iv)) },
    messageKey,
    fromBase64(payload.ciphertext),
  );
  return new TextDecoder().decode(plaintext);
};

// ─── Superseded account keystore ───
//
// Held the escrowed account keypair. Nothing reads it any more; it is deleted
// on sight so a private key the server no longer issues stops sitting on disk.

const LEGACY_KEYS_PATH = join(homedir(), '.config', 'zeph', 'keys.json');

const deleteLegacyKeys = (): void => {
  try { unlinkSync(LEGACY_KEYS_PATH); } catch { /* not present — fine */ }
};

// ─── Cached state ───

/**
 * Whether the account has opted into E2E (`encryptionEnabled`, ADR-0008).
 * Kept separate from the device keypair because that keypair also backs
 * stream frames, which are encrypted regardless — reading its presence as
 * consent would turn push encryption on for everyone.
 */
let pushCryptoEnabled = false;
let cachedLegacyPublicKey: string | null = null;
let initPromise: Promise<string> | null = null;

/**
 * Initialize push/file encryption.
 *
 * Encryption turns on only when the account has explicitly opted in —
 * `encryptionEnabled` from `GET /users/me/keys` is the single authoritative
 * signal (ADR-0008). Server unreachable or flag off leaves it off and every
 * send goes out in the clear.
 *
 * When it is on, this delegates to the per-device keypair: nothing is asked
 * of the server but the flag, and nothing is ever uploaded.
 *
 * Safe to call concurrently — deduplicates to a single init.
 * Returns this host's public key when encryption is active, '' otherwise.
 */
export const initCrypto = (apiKey?: string, baseUrl?: string): Promise<string> => {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    // Local-only mode (no apiKey): used by tests and offline setups. There is
    // no flag to consult, so encryption stays off rather than being inferred.
    if (!apiKey) {
      pushCryptoEnabled = false;
      return '';
    }

    const state = await fetchEncryptionState(apiKey, baseUrl);
    if (state) deleteLegacyKeys();
    if (!state?.encryptionEnabled) {
      pushCryptoEnabled = false;
      return '';
    }

    const publicKey = await initDeviceCrypto();
    pushCryptoEnabled = true;
    return publicKey;
  })().catch((err) => {
    initPromise = null;
    throw err;
  });
  return initPromise;
};

// ─── Server state ───

interface EncryptionState {
  encryptionEnabled: boolean;
  /**
   * The account-wide public key, when one is still registered. Only used to
   * recognise devices that never migrated: a device advertising this key has
   * no per-device keypair, so wrapping for it produces something it cannot
   * unwrap.
   */
  legacyPublicKey: string | null;
}

const fetchEncryptionState = async (apiKey: string, baseUrl?: string): Promise<EncryptionState | null> => {
  try {
    const url = `${(baseUrl ?? 'https://api.zeph.to/v1').replace(/\/$/, '')}/users/me/keys`;
    const res = await fetch(url, { headers: { 'X-API-Key': apiKey } });
    if (!res.ok) return null;
    const json = await res.json() as {
      data?: { encryptionKeys?: { publicKey?: string } | null; encryptionEnabled?: boolean };
    };
    cachedLegacyPublicKey = json.data?.encryptionKeys?.publicKey ?? null;
    return {
      encryptionEnabled: json.data?.encryptionEnabled === true,
      legacyPublicKey: cachedLegacyPublicKey,
    };
  } catch {
    return null;
  }
};

// uploadServerKeys is gone. It wrote this host's public key to
// /users/me/keys, overwriting the account key every other client reads — and
// it fired on exactly the path escrow removal made unreachable. Nothing here
// writes key material to the server any more.

/** One target device, as returned by `GET /devices`. */
export interface DeviceRecipient {
  deviceId: string;
  /** Base64 SPKI of that device's per-device public key. */
  publicKey: string;
}

/** deviceId → JSON `{ encryptedKey, keyIv }`, the wire shape the clients parse. */
export type DeviceKeyMap = Record<string, string>;

/**
 * Keep only devices this host can actually encrypt for.
 *
 * A device without a public key has never run a build that registers one, and
 * a device still advertising the account-wide key has not migrated to
 * per-device E2E — wrapping for either produces a push it cannot open, which
 * is worse than sending plaintext it can read.
 */
export const selectRecipients = (
  devices: { deviceId: string; publicKey?: string }[],
): DeviceRecipient[] =>
  devices
    .filter((d): d is DeviceRecipient => !!d.publicKey && d.publicKey !== cachedLegacyPublicKey)
    .map(({ deviceId, publicKey }) => ({ deviceId, publicKey }));

/**
 * Wrap one raw AES key for every recipient device.
 *
 * The payload is encrypted once and only the wrapped key repeats, so an
 * attachment costs one S3 object regardless of device count. A recipient
 * whose public key will not import is dropped rather than failing the send —
 * one broken device record must not silence every push.
 */
const wrapForDevices = async (
  rawKey: ArrayBuffer,
  senderPrivateKey: CryptoKey,
  recipients: DeviceRecipient[],
): Promise<DeviceKeyMap> => {
  const entries = await Promise.all(
    recipients.map(async ({ deviceId, publicKey }) => {
      try {
        const sharedKey = await deriveAesKey(senderPrivateKey, await importPublicKey(publicKey));
        const keyIv = crypto.getRandomValues(new Uint8Array(12));
        const wrapped = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: keyIv }, sharedKey, rawKey);
        return [
          deviceId,
          JSON.stringify({ encryptedKey: toBase64(wrapped), keyIv: toBase64(keyIv.buffer as ArrayBuffer) }),
        ] as const;
      } catch (err) {
        console.error(`[Crypto] Skipping device ${deviceId} — unusable public key:`, err);
        return null;
      }
    }),
  );

  const keyMap: DeviceKeyMap = {};
  for (const entry of entries) {
    if (entry) keyMap[entry[0]] = entry[1];
  }
  if (Object.keys(keyMap).length === 0) throw new Error('No recipient device accepted the wrapped key');
  return keyMap;
};

// Gated on the account opt-in, not on the keypair's existence: the same
// keypair backs stream frames, which are encrypted regardless, so presence
// alone would turn push encryption on for accounts that never asked.
export const getKeyPair = (): CryptoKeyPair | null => (pushCryptoEnabled ? deviceKeyPair : null);
export const getPublicKey = (): string | null => (pushCryptoEnabled ? deviceExportedPublicKey : null);

/**
 * Drop the cached keys so every later send goes out as plaintext.
 *
 * Callers use this when the server rejects an encrypted send with
 * `PRO_REQUIRED` (ADR-0008): E2E is a Pro feature, and a long-lived process
 * that initialized crypto before a downgrade would otherwise 403 on every push.
 * Same end state as the "server says encryption disabled" branch in initCrypto.
 * Keys on disk are left alone, but this process will not pick them up again:
 * `initCrypto` is memoized on `initPromise` and `ZephHook.ensureCrypto` short-
 * circuits on `cryptoInitialized`. A restart after an upgrade re-adopts them.
 */
export const disableCrypto = (): void => {
  pushCryptoEnabled = false;
};

/**
 * Encrypt a push body for the given recipient devices.
 *
 * Returns the wire fields the API expects: `body` carries the ciphertext and
 * IV, `deviceKeyMap` the per-device wrapped keys, `senderPublicKey` the half
 * recipients need to derive the same secret back.
 */
export const encryptPushBodyForDevices = async (
  input: { title?: string; body?: string; url?: string },
  recipients: DeviceRecipient[],
): Promise<{
  body: string;
  deviceKeyMap: DeviceKeyMap;
  senderPublicKey: string;
  isEncrypted: true;
}> => {
  if (!deviceKeyPair || !deviceExportedPublicKey) throw new Error('Crypto not initialized');

  const messageKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    messageKey,
    new TextEncoder().encode(JSON.stringify({ title: input.title, body: input.body, url: input.url })),
  );
  const rawMessageKey = await crypto.subtle.exportKey('raw', messageKey);

  return {
    body: JSON.stringify({ ciphertext: toBase64(ciphertext), iv: toBase64(iv.buffer as ArrayBuffer) }),
    deviceKeyMap: await wrapForDevices(rawMessageKey, deviceKeyPair.privateKey, recipients),
    senderPublicKey: deviceExportedPublicKey,
    isEncrypted: true,
  };
};

/**
 * Encrypt file content for the given recipient devices.
 */
export const encryptFileForDevices = async (
  content: string | Buffer,
  recipients: DeviceRecipient[],
): Promise<{ ciphertext: Buffer; iv: string; deviceKeyMap: DeviceKeyMap }> => {
  if (!deviceKeyPair) throw new Error('Crypto not initialized');

  // Binary content must be encrypted byte for byte — running a Buffer through
  // TextEncoder would UTF-8 mangle every non-ASCII byte. Today's only caller
  // passes markdown, so this is a guard against the first binary sender rather
  // than a live fix (the MCP twin took that bug in production).
  const buffer =
    typeof content === 'string'
      ? new TextEncoder().encode(content)
      : new Uint8Array(content.buffer as ArrayBuffer, content.byteOffset, content.byteLength);

  const fileKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, fileKey, buffer);
  const rawFileKey = await crypto.subtle.exportKey('raw', fileKey);

  return {
    ciphertext: Buffer.from(ciphertext),
    iv: toBase64(iv.buffer as ArrayBuffer),
    deviceKeyMap: await wrapForDevices(rawFileKey, deviceKeyPair.privateKey, recipients),
  };
};

// ─── Per-device keypair (stream E2EE + push/file bodies) ───
//
// One keypair per host: generated here, private key never leaves
// ~/.zeph/device-keys.json, never uploaded. It matches the web app's
// per-device `'device'` slot, so anything encrypted here is decryptable only
// by the devices whose public keys it was wrapped for.
//
// Stream frames use it unconditionally; push and file bodies only once the
// account opts in (see `pushCryptoEnabled`). It replaced the escrowed
// account-wide keypair entirely — the file header explains why that one is
// gone.

/**
 * Flat ephemeral envelope — field-for-field what the web's decrypt()
 * (libs/crypto) consumes, with the sender public key riding along so the
 * receiver needs no out-of-band key lookup.
 */
export interface EncryptedEphemeralPayload extends EncryptedPayload {
  senderPublicKey: string;
}

const DEVICE_KEYS_DIR = join(homedir(), '.zeph');
const DEVICE_KEYS_PATH = join(DEVICE_KEYS_DIR, 'device-keys.json');

let deviceKeyPair: CryptoKeyPair | null = null;
let deviceExportedPublicKey: string | null = null;
let deviceInitPromise: Promise<string> | null = null;

const loadStoredDeviceKeys = (): ExportedKeyPair | null => {
  try {
    return JSON.parse(readFileSync(DEVICE_KEYS_PATH, 'utf-8')) as ExportedKeyPair;
  } catch {
    return null;
  }
};

const storeDeviceKeys = (exported: ExportedKeyPair): void => {
  mkdirSync(DEVICE_KEYS_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(DEVICE_KEYS_PATH, JSON.stringify(exported, null, 2), { mode: 0o600 });
};

/**
 * Load-or-create the per-device keypair. Local-only — no server round-trip,
 * no upload. Safe to call concurrently (dedupes to one init). Returns the
 * exported public key (Base64 SPKI).
 */
export const initDeviceCrypto = (): Promise<string> => {
  if (deviceInitPromise) return deviceInitPromise;
  deviceInitPromise = (async () => {
    const stored = loadStoredDeviceKeys();
    if (stored) {
      deviceKeyPair = await importKeyPair(stored);
      deviceExportedPublicKey = stored.publicKey;
      return stored.publicKey;
    }
    const keyPair = await generateKeyPair();
    const exported = await exportKeyPair(keyPair);
    storeDeviceKeys(exported);
    deviceKeyPair = keyPair;
    deviceExportedPublicKey = exported.publicKey;
    return exported.publicKey;
  })().catch((err) => {
    deviceInitPromise = null;
    throw err;
  });
  return deviceInitPromise;
};

export const getDevicePublicKey = (): string | null => deviceExportedPublicKey;

/**
 * Encrypt an ephemeral payload (e.g. a stream frame) for one recipient
 * device. Requires initDeviceCrypto() to have completed.
 */
/**
 * One imported peer key plus the ECDH secret derived with it. A stream talks to
 * exactly one subscriber, and the input half binds to that same key, so both
 * directions reuse one entry for the stream's life — deriving per frame AND per
 * keystroke was two WebCrypto operations repeating the same answer.
 */
let peerCache: { b64: string; key: CryptoKey; shared: CryptoKey } | null = null;

const peerFor = async (
  raw: string,
  privateKey: CryptoKey,
): Promise<{ key: CryptoKey; shared: CryptoKey }> => {
  if (peerCache?.b64 === raw) return peerCache;
  const key = await importPublicKey(raw);
  const shared = await deriveAesKey(privateKey, key);
  peerCache = { b64: raw, key, shared };
  return peerCache;
};

export const encryptEphemeral = async (
  plaintext: string,
  recipientPublicKeyRaw: string,
): Promise<EncryptedEphemeralPayload> => {
  if (!deviceKeyPair || !deviceExportedPublicKey) throw new Error('Device crypto not initialized');
  const peer = await peerFor(recipientPublicKeyRaw, deviceKeyPair.privateKey);
  const payload = await encrypt(plaintext, deviceKeyPair.privateKey, peer.key, peer.shared);
  return { ...payload, senderPublicKey: deviceExportedPublicKey };
};

/**
 * Open an ephemeral envelope addressed to this device — the exact inverse of
 * encryptEphemeral, and of the web's `encrypt` from @zeph/crypto, which
 * produces the same five fields.
 *
 * Rejects rather than returning null: AES-GCM is authenticated, so a throw
 * here means the envelope was sealed for another key, tampered with, or is not
 * an envelope at all. Callers must treat every rejection as a refusal — there
 * is no partial result to fall back on. Requires initDeviceCrypto().
 *
 * Note that opening an envelope proves only that its sender holds the private
 * half of `senderPublicKey`; nothing signs that field, so it authenticates the
 * key pairing and not the sender. A caller that needs to know *which* peer
 * sent this must compare `senderPublicKey` against a key it already trusts.
 */
export const decryptEphemeral = async (
  payload: EncryptedEphemeralPayload,
): Promise<string> => {
  if (!deviceKeyPair) throw new Error('Device crypto not initialized');
  const peer = await peerFor(payload.senderPublicKey, deviceKeyPair.privateKey);
  return decrypt(payload, deviceKeyPair.privateKey, peer.key, peer.shared);
};
