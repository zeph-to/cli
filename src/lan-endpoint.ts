import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os';
import { LISTENER_PRESENCE } from './device-presence.js';

/**
 * Local transfer (ADR-0013) — the listener's side of the rendezvous.
 *
 * There is no mDNS. The listener writes `lan: { host, port }` on its own
 * device record by sending `listener.presence` over the WebSocket it already
 * holds; a sender on the same network reads it back from `GET /devices` and
 * tries a direct upload before the S3 relay. The socket is the transport
 * because it is what proves which device is speaking — the HTTP device-record
 * route is JWT-only and the daemon holds an API key.
 *
 * Liveness is the device's `isOnline` (that same socket), so this module
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
    log: (msg: string) => void;
    /** Send one frame on the live socket; false when there is none. The
     *  server's answer (`listener.presence.ack` / `.error`) arrives on the
     *  socket's message handler, not here. */
    send: (msg: object) => boolean;
    pickHost?: () => string | null;
}

export interface LanPublisher {
    /**
     * Publish `{host, port}` if it differs from what was last published (or
     * always, with `force` — used on every WebSocket open, because the device
     * record may have been recreated). True when a frame went out. Never
     * throws: a socket that is not there leaves the relay path unaffected.
     */
    publish: (port: number, opts?: { force?: boolean }) => boolean;
    /** `lan: null` on the device record — shutdown, or the LAN went away.
     *  Best-effort: every reader gates on `isOnline`, so an endpoint left
     *  behind by a socket that dropped is already inert. */
    clear: () => void;
    /** Poll the address and republish on change. One watcher at a time. */
    startWatch: (port: number, intervalMs?: number) => void;
    stopWatch: () => void;
}

const DEFAULT_WATCH_INTERVAL_MS = 60_000;

export const createLanPublisher = (deps: LanPublisherDeps): LanPublisher => {
    const pickHost = deps.pickHost ?? (() => pickLanIpv4());

    let published: { host: string; port: number } | null = null;
    let watchTimer: NodeJS.Timeout | null = null;

    /** One frame. Synchronous, so a watch tick cannot interleave with the
     *  forced publish from a socket open the way two in-flight writes could. */
    const announce = (lan: { host: string; port: number } | null): boolean => {
        const sent = deps.send({ type: LISTENER_PRESENCE, data: { lan } });
        if (!sent) deps.log('local transfer: endpoint not published — no connection right now, relay until the next open');
        return sent;
    };

    const publish: LanPublisher['publish'] = (port, opts) => {
        try {
            const host = pickHost();
            if (host === null) {
                // The LAN went away (or never existed). Retract a stale endpoint
                // so no sender is pointed at an address we no longer hold.
                if (published !== null && announce(null)) published = null;
                return false;
            }
            const unchanged = published !== null && published.host === host && published.port === port;
            if (unchanged && !opts?.force) return false;
            const sent = announce({ host, port });
            if (sent) published = { host, port };
            return sent;
        } catch (err) {
            // Called from timers and socket events; a throw here (a host
            // picker that fails) must not take the daemon down.
            deps.log(`local transfer: publish skipped — ${err instanceof Error ? err.message : String(err)}`);
            return false;
        }
    };

    const clear: LanPublisher['clear'] = () => {
        if (published === null) return;
        // Forgotten either way: the socket is closing, and what keeps a
        // sender away from this port after that is `isOnline`, not this field.
        announce(null);
        published = null;
    };

    const stopWatch = (): void => {
        if (watchTimer) clearInterval(watchTimer);
        watchTimer = null;
    };

    const startWatch: LanPublisher['startWatch'] = (port, intervalMs = DEFAULT_WATCH_INTERVAL_MS) => {
        stopWatch();
        watchTimer = setInterval(() => publish(port), intervalMs);
        watchTimer.unref();
    };

    return { publish, clear, startWatch, stopWatch };
};
