import { describe, expect, it, vi } from 'vitest';
import type { NetworkInterfaceInfo } from 'node:os';
import { createLanPublisher, pickLanIpv4 } from './lan-endpoint.js';
import { LISTENER_PRESENCE } from './device-presence.js';

// Local transfer (ADR-0013): the listener publishes where it can be reached
// on its own LAN through the existing device record, so a sender on the same
// network can POST a file straight to it. The endpoint rides the socket the
// daemon already holds (`listener.presence`), because the HTTP device-record
// route is JWT-only. A wrong host or a chatty publisher is a server-side
// rejection or a write storm, so both are pinned.

const iface = (address: string, family: 'IPv4' | 'IPv6', internal = false): NetworkInterfaceInfo =>
    ({ address, family, internal, netmask: '', mac: '', cidr: null } as NetworkInterfaceInfo); // fixture: only the fields pickLanIpv4 reads

describe('pickLanIpv4', () => {
    it('takes the first private, non-internal IPv4 and skips loopback, IPv6 and public addresses', () => {
        const host = pickLanIpv4({
            lo0: [iface('127.0.0.1', 'IPv4', true), iface('::1', 'IPv6', true)],
            utun3: [iface('fe80::1', 'IPv6')],
            en0: [iface('2001:db8::5', 'IPv6'), iface('192.168.1.42', 'IPv4')],
            en1: [iface('10.0.0.7', 'IPv4')],
        });
        expect(host).toBe('192.168.1.42');
    });

    it('refuses a public IPv4 even when it is the only one', () => {
        expect(pickLanIpv4({ en0: [iface('8.8.8.8', 'IPv4')] })).toBeNull();
    });

    it('accepts CGNAT and link-local, the ranges some routers and overlays hand out', () => {
        expect(pickLanIpv4({ en0: [iface('100.64.3.1', 'IPv4')] })).toBe('100.64.3.1');
        expect(pickLanIpv4({ en0: [iface('169.254.9.9', 'IPv4')] })).toBe('169.254.9.9');
    });

    it('returns null with no interfaces at all', () => {
        expect(pickLanIpv4({})).toBeNull();
    });
});

const publisherHarness = (opts: { hosts?: (string | null)[]; connected?: boolean } = {}) => {
    const sent: { lan: unknown }[] = [];
    const hosts = opts.hosts ?? ['192.168.1.42'];
    let hostIndex = 0;
    const logs: string[] = [];
    let connected = opts.connected ?? true;
    const publisher = createLanPublisher({
        log: (m) => logs.push(m),
        send: (msg) => {
            if (!connected) return false;
            const frame = msg as { type: string; data: { lan: unknown } };
            expect(frame.type).toBe(LISTENER_PRESENCE);
            sent.push(frame.data);
            return true;
        },
        pickHost: () => hosts[Math.min(hostIndex++, hosts.length - 1)] ?? null,
    });
    return { publisher, sent, logs, disconnect: () => { connected = false; } };
};

describe('createLanPublisher', () => {
    it('sends {lan: {host, port}} on the presence message', () => {
        const h = publisherHarness();
        expect(h.publisher.publish(54321)).toBe(true);
        expect(h.sent).toEqual([{ lan: { host: '192.168.1.42', port: 54321 } }]);
    });

    it('does not resend an unchanged endpoint, and does when forced (reconnect)', () => {
        const h = publisherHarness();
        h.publisher.publish(54321);
        expect(h.publisher.publish(54321)).toBe(false);
        expect(h.sent).toHaveLength(1);
        expect(h.publisher.publish(54321, { force: true })).toBe(true);
        expect(h.sent).toHaveLength(2);
    });

    it('resends when the LAN address changes', () => {
        const h = publisherHarness({ hosts: ['192.168.1.42', '10.0.0.7'] });
        h.publisher.publish(54321);
        h.publisher.publish(54321);
        expect(h.sent.map((d) => (d.lan as { host: string }).host)).toEqual(['192.168.1.42', '10.0.0.7']);
    });

    it('publishes nothing when no private IPv4 is up, and clears a previously published one', () => {
        const h = publisherHarness({ hosts: ['192.168.1.42', null] });
        h.publisher.publish(54321);
        expect(h.publisher.publish(54321)).toBe(false);
        expect(h.sent).toEqual([
            { lan: { host: '192.168.1.42', port: 54321 } },
            { lan: null },
        ]);
    });

    it('clear() sends lan: null and forgets the last endpoint', () => {
        const h = publisherHarness();
        h.publisher.publish(54321);
        h.publisher.clear();
        expect(h.sent[1]).toEqual({ lan: null });
        // A later publish after clear must write again even though host:port is unchanged.
        expect(h.publisher.publish(54321)).toBe(true);
    });

    it('clear() with nothing published sends nothing', () => {
        const h = publisherHarness();
        h.publisher.clear();
        expect(h.sent).toHaveLength(0);
    });

    it('logs and swallows a socket that is not there — the relay path must keep working', () => {
        const h = publisherHarness({ connected: false });
        expect(h.publisher.publish(54321)).toBe(false);
        expect(h.logs.some((l) => /no connection right now/.test(l))).toBe(true);
        // Not remembered as published: the next open tries again.
        expect(h.publisher.publish(54321)).toBe(false);
    });

    it('watch() republishes only on a host change and stops cleanly', () => {
        vi.useFakeTimers();
        try {
            const h = publisherHarness({ hosts: ['192.168.1.42', '192.168.1.42', '10.0.0.7'] });
            h.publisher.publish(54321);
            h.publisher.startWatch(54321, 1000);
            vi.advanceTimersByTime(1000);
            expect(h.sent).toHaveLength(1);
            vi.advanceTimersByTime(1000);
            expect(h.sent).toHaveLength(2);
            h.publisher.stopWatch();
            vi.advanceTimersByTime(5000);
            expect(h.sent).toHaveLength(2);
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('createLanPublisher — failure paths', () => {
    it('never throws, even when the host picker does', () => {
        const logs: string[] = [];
        const publisher = createLanPublisher({
            log: (m) => logs.push(m),
            send: () => true,
            pickHost: () => { throw new Error('ifaces exploded'); },
        });
        expect(publisher.publish(1)).toBe(false);
        expect(logs).toEqual(['local transfer: publish skipped — ifaces exploded']);
    });

    it('a retract that cannot be sent still forgets the endpoint — isOnline is what keeps senders away', () => {
        const h = publisherHarness();
        h.publisher.publish(54321);
        h.disconnect();
        h.publisher.clear();
        expect(h.sent).toHaveLength(1);
        expect(h.logs.some((l) => /no connection right now/.test(l))).toBe(true);
    });
});
