/**
 * Per-device E2E (ADR-0007) — put this machine's public key on its device
 * record, so other devices can wrap pushes and files for it.
 *
 * Senders only encrypt for devices whose record carries a `publicKey`, and
 * a local transfer (ADR-0013 decision 3) is only attempted to such a device.
 * The listener held a keypair from the start but never registered it, so
 * the Mac was neither an E2E recipient nor a local-transfer target.
 *
 * It goes over the WebSocket, not an HTTP write: the device-record route
 * (`PATCH /v1/devices/{deviceId}`) is behind the JWT authorizer and this
 * daemon holds an API key, so the socket — which already proves which
 * device is speaking, and which created the record at `$connect` — is the
 * write path. `lan-endpoint.ts` publishes the transfer endpoint on the same
 * message.
 *
 * Sent on every WebSocket open: `$connect` is what makes the record exist,
 * and a record that was recreated has lost its key. The server broadcasts
 * `device.publicKey.changed` only when the key actually differs, so an
 * unchanged re-registration is one quiet write. Sent whatever the account's
 * `encryptionEnabled` — senders gate on that, as the web app does. The
 * private half never leaves `~/.zeph/device-keys.json`.
 */

/** The one message both halves of presence ride; the server answers
 *  `listener.presence.ack` or `listener.presence.error`. */
export const LISTENER_PRESENCE = 'listener.presence';

export interface DeviceKeyRegistrationDeps {
    log: (msg: string) => void;
    /** Send one frame on the live socket; false when there is none. */
    send: (msg: object) => boolean;
    /** Load-or-create the keypair; resolves the Base64 SPKI public key. */
    publicKey: () => Promise<string>;
}

export interface DeviceKeyRegistration {
    /** Call on every WebSocket open. Never throws; resolves true once the
     *  frame went out. A failure waits for the next open. */
    onOpen: () => Promise<boolean>;
}

export const createDeviceKeyRegistration = (deps: DeviceKeyRegistrationDeps): DeviceKeyRegistration => {
    // Two opens in quick succession (a flapping socket) share one load. A
    // record recreated inside that window waits for the open after — accepted.
    let inFlight: Promise<boolean> | null = null;

    const register = async (): Promise<boolean> => {
        try {
            const publicKey = await deps.publicKey();
            const sent = deps.send({ type: LISTENER_PRESENCE, data: { publicKey } });
            if (!sent) deps.log('device key: not registered — no connection right now, retried at the next open');
            return sent;
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
