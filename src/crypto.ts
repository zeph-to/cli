/**
 * E2E encryption for Hook SDK — self-contained ECDH P-256 + AES-256-GCM
 * Mirrors @zeph/crypto API but bundled inline (no external dependency).
 * Uses Web Crypto API (globalThis.crypto.subtle) — Node.js 18+.
 */

/// <reference lib="dom" />

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

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

const KEYS_DIR = join(process.env.HOME ?? '~', '.config', 'zeph');
const KEYS_PATH = join(KEYS_DIR, 'keys.json');

const loadStoredKeys = (): ExportedKeyPair | null => {
  try {
    return JSON.parse(readFileSync(KEYS_PATH, 'utf-8')) as ExportedKeyPair;
  } catch {
    return null;
  }
};

const storeKeys = (exported: ExportedKeyPair): void => {
  mkdirSync(KEYS_DIR, { recursive: true });
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
      const serverKeys = await fetchServerKeys(apiKey, baseUrl);
      if (serverKeys) {
        // Server has keys — adopt them (server is source of truth)
        if (!stored || stored.publicKey !== serverKeys.publicKey) {
          storeKeys(serverKeys);
        }
        cachedKeyPair = await importKeyPair(serverKeys);
        cachedExportedPublicKey = serverKeys.publicKey;
        cachedOwnPublicKey = cachedKeyPair.publicKey;
        return serverKeys.publicKey;
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

const fetchServerKeys = async (apiKey: string, baseUrl?: string): Promise<ExportedKeyPair | null> => {
  try {
    const url = `${(baseUrl ?? 'https://api.zeph.to/v1').replace(/\/$/, '')}/users/me/keys`;
    const res = await fetch(url, { headers: { 'X-API-Key': apiKey } });
    if (!res.ok) return null;
    const json = await res.json() as { data?: { encryptionKeys?: ExportedKeyPair | null } };
    const keys = json.data?.encryptionKeys;
    return keys?.publicKey && keys?.privateKey ? keys : null;
  } catch {
    return null;
  }
};

const uploadServerKeys = async (keys: ExportedKeyPair, apiKey: string, baseUrl?: string): Promise<void> => {
  try {
    const url = `${(baseUrl ?? 'https://api.zeph.to/v1').replace(/\/$/, '')}/users/me/keys`;
    await fetch(url, {
      method: 'PUT',
      headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(keys),
    });
  } catch { /* non-critical */ }
};

export const getKeyPair = (): CryptoKeyPair | null => cachedKeyPair;
export const getPublicKey = (): string | null => cachedExportedPublicKey;

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
