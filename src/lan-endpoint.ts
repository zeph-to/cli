import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os';
import { apiFetch, apiUrl } from './api.js';

/**
 * Local transfer (ADR-0013) — the listener's side of the rendezvous.
 *
 * There is no mDNS. The listener writes `lan: { host, port }` on its own
 * device record through `PUT /v1/devices/{id}`; a sender on the same network
 * reads it from `GET /devices` and tries a direct upload before the S3
 * relay. Liveness is the device's `isOnline` (the WebSocket), so this module
 * republishes on every reconnect and otherwise only when the address moves.
 *
 * The server refuses anything but a private IPv4, so `pickLanIpv4` applies
 * the same ranges here: a VPN or public address never reaches the wire.
 */

/** RFC 1918, CGNAT (100.64/10) and link-local. Same set as the server's validator. */
const PRIVATE_IPV4 =
    /^(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}|169\.254\.\d{1,3}\.\d{1,3})$/;

export const isPrivateIpv4 = (host: string): boolean =>
    PRIVATE_IPV4.test(host) && host.split('.').every((octet) => Number(octet) <= 255);

/** First private, non-internal IPv4 across all interfaces, or null when the machine has none up. */
export const pickLanIpv4 = (
    interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces(),
): string | null => {
    for (const entries of Object.values(interfaces)) {
        for (const entry of entries ?? []) {
            const isCandidate = entry.family === 'IPv4' && !entry.internal && isPrivateIpv4(entry.address);
            if (isCandidate) return entry.address;
        }
    }
    return null;
};

export interface LanPublisherDeps {
    deviceId: string;
    apiKey: string;
    baseUrl: string;
    log: (msg: string) => void;
    fetchFn?: typeof fetch;
    pickHost?: () => string | null;
    /** How long one PUT may take. The daemon's reconnect loop must not wait behind it. */
    timeoutMs?: number;
}

export interface LanPublisher {
    /**
     * Publish `{host, port}` if it differs from what was last published (or
     * always, with `force` — used on every WebSocket open, because the device
     * record may have been recreated). Resolves true when a PUT was sent and
     * accepted. Never throws: a rejected publish is logged and the relay path
     * is unaffected.
     */
    publish: (port: number, opts?: { force?: boolean }) => Promise<boolean>;
    /** `lan: null` on the device record — shutdown, or the LAN went away.
     *  `timeoutMs` bounds each of the two attempts; shutdown passes a short
     *  one because `stopListener` SIGKILLs the daemon 3 s after SIGTERM. */
    clear: (opts?: { timeoutMs?: number }) => Promise<void>;
    /** Poll the address and republish on change. One watcher at a time. */
    startWatch: (port: number, intervalMs?: number) => void;
    stopWatch: () => void;
}

const DEFAULT_WATCH_INTERVAL_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 5_000;

export const createLanPublisher = (deps: LanPublisherDeps): LanPublisher => {
    const fetchFn = deps.fetchFn ?? fetch;
    const pickHost = deps.pickHost ?? (() => pickLanIpv4());
    const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const url = apiUrl(deps.baseUrl, `/devices/${encodeURIComponent(deps.deviceId)}`);

    let published: { host: string; port: number } | null = null;
    let watchTimer: NodeJS.Timeout | null = null;
    // One PUT at a time: a watch tick landing on top of the forced publish
    // from a socket open must not interleave two writes of `published`.
    let inFlight: Promise<boolean> = Promise.resolve(false);

    const put = async (lan: { host: string; port: number } | null, budgetMs = timeoutMs): Promise<boolean> => {
        try {
            const res = await apiFetch(fetchFn, url, deps.apiKey, budgetMs, {
                method: 'PUT',
                body: JSON.stringify({ lan }),
            });
            if (!res.ok) {
                deps.log(`local transfer: publish rejected (${res.status}) — relay only until it succeeds`);
                return false;
            }
            return true;
        } catch (err) {
            deps.log(`local transfer: publish failed — ${err instanceof Error ? err.message : String(err)}`);
            return false;
        }
    };

    const publishNow = async (port: number, opts?: { force?: boolean }): Promise<boolean> => {
        try {
            const host = pickHost();
            if (host === null) {
                // The LAN went away (or never existed). Retract a stale endpoint
                // so no sender is pointed at an address we no longer hold.
                if (published !== null && (await put(null))) published = null;
                return false;
            }
            const unchanged = published !== null && published.host === host && published.port === port;
            if (unchanged && !opts?.force) return false;
            const ok = await put({ host, port });
            if (ok) published = { host, port };
            return ok;
        } catch (err) {
            // `publish` is called with `void` from timers and socket events;
            // a throw here (a host picker that fails) would be an unhandled
            // rejection and take the daemon down.
            deps.log(`local transfer: publish skipped — ${err instanceof Error ? err.message : String(err)}`);
            return false;
        }
    };

    const publish: LanPublisher['publish'] = (port, opts) => {
        inFlight = inFlight.then(() => publishNow(port, opts), () => publishNow(port, opts));
        return inFlight;
    };

    // The last write before the port closes gets one retry; `published` is
    // only forgotten once the server confirmed, so a failed retract is
    // retried by the next tick rather than mistaken for done.
    const clearNow = async (budgetMs?: number): Promise<boolean> => {
        if (published === null) return true;
        const ok = (await put(null, budgetMs)) || (await put(null, budgetMs));
        if (ok) published = null;
        return ok;
    };

    // Same chain as publish: a retract must land after any `{host, port}`
    // PUT already in flight, or the record ends up pointing at a dead port.
    const clear: LanPublisher['clear'] = async (opts) => {
        const run = () => clearNow(opts?.timeoutMs);
        inFlight = inFlight.then(run, run);
        await inFlight;
    };

    const stopWatch = (): void => {
        if (watchTimer) clearInterval(watchTimer);
        watchTimer = null;
    };

    const startWatch: LanPublisher['startWatch'] = (port, intervalMs = DEFAULT_WATCH_INTERVAL_MS) => {
        stopWatch();
        watchTimer = setInterval(() => void publish(port), intervalMs);
        watchTimer.unref();
    };

    return { publish, clear, startWatch, stopWatch };
};
