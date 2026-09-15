/**
 * Per-device E2E (ADR-0007) — put this machine's public key on its device
 * record, so other devices can wrap pushes and files for it.
 *
 * Senders only encrypt for devices whose record carries a `publicKey`, and
 * a local transfer (ADR-0013 decision 3) is only attempted to such a device.
 * The listener held a keypair from the start but never registered it, so
 * the Mac was neither an E2E recipient nor a local-transfer target.
 *
 * Registered on every WebSocket open: `$connect` is what makes the record
 * exist, and a record that was recreated has lost its key. The server
 * broadcasts `device.publicKey.changed` only when the key actually differs,
 * so an unchanged re-registration is one quiet PUT. Registered whatever the
 * account's `encryptionEnabled` — senders gate on that, as the web app does.
 * The private half never leaves `~/.zeph/device-keys.json`.
 */

import { apiFetch, apiUrl } from './api.js';

export interface DeviceKeyRegistrationDeps {
    deviceId: string;
    apiKey: string;
    baseUrl: string;
    log: (msg: string) => void;
    /** Load-or-create the keypair; resolves the Base64 SPKI public key. */
    publicKey: () => Promise<string>;
    fetchFn?: typeof fetch;
    timeoutMs?: number;
}

export interface DeviceKeyRegistration {
    /** Call on every WebSocket open. Never throws; resolves true once the
     *  server accepted the key. A failure waits for the next open. */
    onOpen: () => Promise<boolean>;
}

const DEFAULT_TIMEOUT_MS = 5_000;

export const createDeviceKeyRegistration = (deps: DeviceKeyRegistrationDeps): DeviceKeyRegistration => {
    const fetchFn = deps.fetchFn ?? fetch;
    const url = apiUrl(deps.baseUrl, `/devices/${encodeURIComponent(deps.deviceId)}`);
    // Two opens in quick succession (a flapping socket) share one PUT. A record
    // recreated inside that window waits for the open after — accepted.
    let inFlight: Promise<boolean> | null = null;

    const register = async (): Promise<boolean> => {
        try {
            const publicKey = await deps.publicKey();
            const res = await apiFetch(fetchFn, url, deps.apiKey, deps.timeoutMs ?? DEFAULT_TIMEOUT_MS, {
                method: 'PUT',
                body: JSON.stringify({ publicKey }),
            });
            if (!res.ok) {
                deps.log(`device key: registration rejected (${res.status}) — encrypted pushes skip this machine until the next connect`);
                return false;
            }
            return true;
        } catch (err) {
            deps.log(`device key: registration failed — ${err instanceof Error ? err.message : String(err)}`);
            return false;
        }
    };

    return {
        onOpen: () => {
            inFlight ??= register().finally(() => { inFlight = null; });
            return inFlight;
        },
    };
};
