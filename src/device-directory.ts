/**
 * Local transfer (ADR-0013) — who is allowed to send to this machine.
 *
 * A LAN upload is authenticated against the sender's *registered* public
 * key, and the registry is the account's device list (`GET /devices`).
 * This caches it so a burst of uploads does not become a burst of API
 * calls, and refreshes on a miss — once per `refreshMinMs` — so a device
 * registered a moment ago is accepted without waiting a whole TTL. An
 * unknown id after a fresh fetch is simply not a device of this account.
 */

import { apiFetch, apiUrl } from './api.js';

export interface DeviceDirectoryDeps {
    apiKey: string;
    baseUrl: string;
    log: (msg: string) => void;
    fetchFn?: typeof fetch;
    now?: () => number;
    /** Age after which the next lookup refetches even on a hit. */
    ttlMs?: number;
    /** Shortest interval between two miss-triggered refetches. */
    refreshMinMs?: number;
    timeoutMs?: number;
}

export interface DeviceDirectory {
    publicKeyOf: (deviceId: string) => Promise<string | null>;
}

const DEFAULT_TTL_MS = 60_000;
const DEFAULT_REFRESH_MIN_MS = 10_000;

export const createDeviceDirectory = (deps: DeviceDirectoryDeps): DeviceDirectory => {
    const fetchFn = deps.fetchFn ?? fetch;
    const now = deps.now ?? (() => Date.now());
    const ttlMs = deps.ttlMs ?? DEFAULT_TTL_MS;
    const refreshMinMs = deps.refreshMinMs ?? DEFAULT_REFRESH_MIN_MS;
    const url = apiUrl(deps.baseUrl, '/devices');

    let keys = new Map<string, string>();
    let fetchedAt = -Infinity;
    /** Last attempt, successful or not — the miss brake counts failures too,
     *  or an unreachable API is hit on every unknown id. */
    let triedAt = -Infinity;
    let inFlight: Promise<void> | null = null;

    const refresh = (): Promise<void> => {
        if (inFlight) return inFlight;
        triedAt = now();
        inFlight = (async () => {
            const res = await apiFetch(fetchFn, url, deps.apiKey, deps.timeoutMs ?? 5_000);
            if (!res.ok) throw new Error(`devices ${res.status}`);
            const json = (await res.json()) as { data?: { deviceId?: unknown; publicKey?: unknown }[] };
            const next = new Map<string, string>();
            for (const d of json.data ?? []) {
                if (typeof d.deviceId === 'string' && typeof d.publicKey === 'string' && d.publicKey.length > 0) next.set(d.deviceId, d.publicKey);
            }
            keys = next;
            fetchedAt = now();
        })().finally(() => { inFlight = null; });
        return inFlight;
    };

    return {
        publicKeyOf: async (deviceId) => {
            const stale = now() - fetchedAt > ttlMs;
            const hit = keys.get(deviceId);
            if (hit && !stale) return hit;
            // Miss or stale: refetch, but a miss alone only once per refreshMinMs —
            // an attacker probing unknown ids must not drive the API.
            if (inFlight) {
                await inFlight.catch(() => undefined);   // logged by the caller that started it
            } else if ((stale || now() - fetchedAt > refreshMinMs) && now() - triedAt > refreshMinMs) {
                try {
                    await refresh();
                } catch (err) {
                    deps.log(`local transfer: device list unavailable — ${err instanceof Error ? err.message : String(err)}`);
                }
            }
            return keys.get(deviceId) ?? null;
        },
    };
};
