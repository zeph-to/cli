/**
 * Device-shared encryption for Hook SDK — self-contained ECDH P-256 +
 * AES-256-GCM. Mirrors @zeph/crypto API but bundled inline (no external
 * dependency). Uses Web Crypto API via node:crypto webcrypto — Node.js 18+
 * (the `crypto` global only exists unflagged from Node 19, so we import it).
 *
 * Threat model honesty (do not call this "E2E" without a footnote):
 *
 *   The Zeph backend persists the per-user private key in plaintext so it
 *   can be synced down to a fresh device (fetchServerKeys / uploadServerKeys
 *   below). That means the backend can decrypt any push body — this is NOT
 *   end-to-end in the standard sense. What it gives you is:
 *     • Protection against passive network observers
 *     • Protection against a leaked DB snapshot taken without the key store
 *     • Cross-device readability (all your devices share one keypair)
 *   What it does NOT give you:
 *     • Protection against the Zeph backend itself
 *     • Forward secrecy — encryptPushBodyForSelf / encryptFileForSelf do
 *       ECDH(self, self), which collapses to a static derived key. A single
 *       device compromise (since all your devices share the same keypair)
 *       lets the attacker decrypt every past push for which they have the
 *       ciphertext. The per-message AES key is random, but its wrap key is
 *       static, so wrapped keys are decryptable forever.
 *
 *   True E2E would require a per-device keypair (server stores only public
 *   keys; senders wrap the message key once per recipient device public
 *   key). That refactor is on the roadmap; until then, treat push bodies as
 *   sensitive-but-not-secret.
 */

/// <reference lib="dom" />

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
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
): Promise<EncryptedPayload> => {
  const messageKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    messageKey,
    new TextEncoder().encode(plaintext),
  );
  const sharedKey = await deriveAesKey(senderPrivateKey, recipientPublicKey);
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

// ─── File encryption ───

const encryptFileContent = async (
  content: string,
  senderPrivateKey: CryptoKey,
  recipientPublicKey: CryptoKey,
): Promise<{ ciphertext: Buffer; iv: string; encryptedKey: string; keyIv: string }> => {
  const buffer = new TextEncoder().encode(content).buffer as ArrayBuffer;
  const fileKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, fileKey, buffer);

  const sharedKey = await deriveAesKey(senderPrivateKey, recipientPublicKey);
  const rawFileKey = await crypto.subtle.exportKey('raw', fileKey);
  const keyIv = crypto.getRandomValues(new Uint8Array(12));
  const encryptedKey = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: keyIv }, sharedKey, rawFileKey);

  return {
    ciphertext: Buffer.from(ciphertext),
    iv: toBase64(iv.buffer as ArrayBuffer),
    encryptedKey: toBase64(encryptedKey),
    keyIv: toBase64(keyIv.buffer as ArrayBuffer),
  };
};

// ─── Key persistence (~/.config/zeph/keys.json) ───

const KEYS_DIR = join(homedir(), '.config', 'zeph');
const KEYS_PATH = join(KEYS_DIR, 'keys.json');

const loadStoredKeys = (): ExportedKeyPair | null => {
  try {
    return JSON.parse(readFileSync(KEYS_PATH, 'utf-8')) as ExportedKeyPair;
  } catch {
    return null;
  }
};

const storeKeys = (exported: ExportedKeyPair): void => {
  mkdirSync(KEYS_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(KEYS_PATH, JSON.stringify(exported, null, 2), { mode: 0o600 });
};

// ─── Cached state ───

let cachedKeyPair: CryptoKeyPair | null = null;
let cachedExportedPublicKey: string | null = null;
let cachedOwnPublicKey: CryptoKey | null = null;
let initPromise: Promise<string> | null = null;

/**
 * Initialize crypto: sync keys with server, then fallback to local/generate.
 * Server is source of truth for per-user key pair.
 * Safe to call concurrently — deduplicates to single init.
 * Returns the exported public key (Base64 SPKI).
 */
export const initCrypto = (apiKey?: string, baseUrl?: string): Promise<string> => {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    // Try local cache first
    const stored = loadStoredKeys();

    // Try server sync if API key available
    if (apiKey) {
      const serverResult = await fetchServerKeys(apiKey, baseUrl);

      // Server says encryption disabled — skip crypto init
      if (serverResult && !serverResult.encryptionEnabled) {
        cachedKeyPair = null;
        cachedExportedPublicKey = null;
        cachedOwnPublicKey = null;
        return '';
      }

      if (serverResult?.keys) {
        // Server has keys — adopt them (server is source of truth)
        if (!stored || stored.publicKey !== serverResult.keys.publicKey) {
          storeKeys(serverResult.keys);
        }
        cachedKeyPair = await importKeyPair(serverResult.keys);
        cachedExportedPublicKey = serverResult.keys.publicKey;
        cachedOwnPublicKey = cachedKeyPair.publicKey;
        return serverResult.keys.publicKey;
      }

      // Server has no keys
      if (stored) {
        // Upload local keys to server
        await uploadServerKeys(stored, apiKey, baseUrl);
        cachedKeyPair = await importKeyPair(stored);
        cachedExportedPublicKey = stored.publicKey;
        cachedOwnPublicKey = cachedKeyPair.publicKey;
        return stored.publicKey;
      }

      // No keys anywhere — generate + upload
      const keyPair = await generateKeyPair();
      const exported = await exportKeyPair(keyPair);
      storeKeys(exported);
      await uploadServerKeys(exported, apiKey, baseUrl);
      cachedKeyPair = keyPair;
      cachedExportedPublicKey = exported.publicKey;
      cachedOwnPublicKey = keyPair.publicKey;
      return exported.publicKey;
    }

    // No API key — local-only mode
    if (stored) {
      cachedKeyPair = await importKeyPair(stored);
      cachedExportedPublicKey = stored.publicKey;
      cachedOwnPublicKey = cachedKeyPair.publicKey;
      return stored.publicKey;
    }

    const keyPair = await generateKeyPair();
    const exported = await exportKeyPair(keyPair);
    storeKeys(exported);
    cachedKeyPair = keyPair;
    cachedExportedPublicKey = exported.publicKey;
    cachedOwnPublicKey = keyPair.publicKey;
    return exported.publicKey;
  })().catch((err) => {
    initPromise = null;
    throw err;
  });
  return initPromise;
};

// ─── Server key sync helpers ───

interface ServerKeysResult {
  keys: ExportedKeyPair | null;
  encryptionEnabled: boolean;
}

const fetchServerKeys = async (apiKey: string, baseUrl?: string): Promise<ServerKeysResult | null> => {
  try {
    const url = `${(baseUrl ?? 'https://api.zeph.to/v1').replace(/\/$/, '')}/users/me/keys`;
    const res = await fetch(url, { headers: { 'X-API-Key': apiKey } });
    if (!res.ok) return null;
    const json = await res.json() as { data?: { encryptionKeys?: ExportedKeyPair | null; encryptionEnabled?: boolean } };
    const keys = json.data?.encryptionKeys;
    const encryptionEnabled = json.data?.encryptionEnabled ?? (keys ? true : false);
    return {
      keys: keys?.publicKey && keys?.privateKey ? keys : null,
      encryptionEnabled,
    };
  } catch {
    return null;
  }
};

// SECURITY: only the PUBLIC key is ever sent to the server. The server
// rejects private-key uploads outright (per-device E2E — escrow removed),
// and a private key must never leave this host. Sending the full
// ExportedKeyPair previously leaked the private key onto the wire on every
// init and the rejection was swallowed silently. The per-device migration
// (see ADR-0007) reworks this path; until then, register the public key only.
const uploadServerKeys = async (keys: ExportedKeyPair, apiKey: string, baseUrl?: string): Promise<void> => {
  try {
    const url = `${(baseUrl ?? 'https://api.zeph.to/v1').replace(/\/$/, '')}/users/me/keys`;
    await fetch(url, {
      method: 'PUT',
      headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ publicKey: keys.publicKey }),
    });
  } catch { /* non-critical */ }
};

export const getKeyPair = (): CryptoKeyPair | null => cachedKeyPair;
export const getPublicKey = (): string | null => cachedExportedPublicKey;

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
  cachedKeyPair = null;
  cachedExportedPublicKey = null;
  cachedOwnPublicKey = null;
};

/**
 * Encrypt push body for a recipient.
 * Returns fields ready to merge into the sendPush payload.
 */
export const encryptPushBody = async (
  input: { title?: string; body?: string; url?: string },
  recipientPublicKeyRaw: string,
): Promise<{
  body: string;
  encryptedKey: string;
  senderPublicKey: string;
  isEncrypted: true;
}> => {
  if (!cachedKeyPair || !cachedExportedPublicKey) throw new Error('Crypto not initialized');
  const recipientKey = await importPublicKey(recipientPublicKeyRaw);
  const payload = await encrypt(
    JSON.stringify({ title: input.title, body: input.body, url: input.url }),
    cachedKeyPair.privateKey,
    recipientKey,
  );

  return {
    body: JSON.stringify({ ciphertext: payload.ciphertext, iv: payload.iv }),
    encryptedKey: JSON.stringify({ encryptedKey: payload.encryptedKey, keyIv: payload.keyIv }),
    senderPublicKey: cachedExportedPublicKey,
    isEncrypted: true,
  };
};

/**
 * Encrypt push body for self (all own devices).
 */
export const encryptPushBodyForSelf = async (
  input: { title?: string; body?: string; url?: string },
): Promise<{
  body: string;
  encryptedKey: string;
  senderPublicKey: string;
  isEncrypted: true;
}> => {
  if (!cachedKeyPair || !cachedExportedPublicKey || !cachedOwnPublicKey) throw new Error('Crypto not initialized');
  const payload = await encrypt(
    JSON.stringify({ title: input.title, body: input.body, url: input.url }),
    cachedKeyPair.privateKey,
    cachedOwnPublicKey,
  );
  return {
    body: JSON.stringify({ ciphertext: payload.ciphertext, iv: payload.iv }),
    encryptedKey: JSON.stringify({ encryptedKey: payload.encryptedKey, keyIv: payload.keyIv }),
    senderPublicKey: cachedExportedPublicKey,
    isEncrypted: true,
  };
};

/**
 * Encrypt file content for a recipient.
 * Returns encrypted buffer + key material for file attachment metadata.
 */
export const encryptFileForRecipient = async (
  content: string,
  recipientPublicKeyRaw: string,
): Promise<{ ciphertext: Buffer; iv: string; encryptedKey: string }> => {
  if (!cachedKeyPair) throw new Error('Crypto not initialized');
  const recipientKey = await importPublicKey(recipientPublicKeyRaw);
  const result = await encryptFileContent(content, cachedKeyPair.privateKey, recipientKey);
  return {
    ciphertext: result.ciphertext,
    iv: result.iv,
    encryptedKey: JSON.stringify({ encryptedKey: result.encryptedKey, keyIv: result.keyIv }),
  };
};

/**
 * Encrypt file content for self (all own devices).
 */
export const encryptFileForSelf = async (
  content: string,
): Promise<{ ciphertext: Buffer; iv: string; encryptedKey: string }> => {
  if (!cachedKeyPair || !cachedOwnPublicKey) throw new Error('Crypto not initialized');
  const result = await encryptFileContent(content, cachedKeyPair.privateKey, cachedOwnPublicKey);
  return {
    ciphertext: result.ciphertext,
    iv: result.iv,
    encryptedKey: JSON.stringify({ encryptedKey: result.encryptedKey, keyIv: result.keyIv }),
  };
};

// ─── Per-device crypto (stream E2EE) ───
//
// Unlike the per-user keypair above (server-synced, shared across devices —
// see the threat-model note at the top), the DEVICE keypair is true E2E
// material: generated on this host, private key never leaves
// ~/.zeph/device-keys.json, never uploaded anywhere. It matches the web
// app's per-device `'device'` slot, so a frame encrypted here is decryptable
// only by the one phone whose public key it was wrapped for.

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
export const encryptEphemeral = async (
  plaintext: string,
  recipientPublicKeyRaw: string,
): Promise<EncryptedEphemeralPayload> => {
  if (!deviceKeyPair || !deviceExportedPublicKey) throw new Error('Device crypto not initialized');
  const recipientKey = await importPublicKey(recipientPublicKeyRaw);
  const payload = await encrypt(plaintext, deviceKeyPair.privateKey, recipientKey);
  return { ...payload, senderPublicKey: deviceExportedPublicKey };
};
