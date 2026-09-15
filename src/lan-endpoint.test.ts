import { describe, expect, it, vi } from 'vitest';
import type { NetworkInterfaceInfo } from 'node:os';
import { createLanPublisher, pickLanIpv4 } from './lan-endpoint.js';

// Local transfer (ADR-0013): the listener publishes where it can be reached
// on its own LAN through the existing device record, so a sender on the same
// network can POST a file straight to it. The publisher is the only thing
// that talks to the server here; a wrong host or a chatty publisher is a
// server-side rejection or a write storm, so both are pinned.

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

interface Call { url: string; init: RequestInit & { headers?: Record<string, string> } }

const publisherHarness = (opts: { hosts?: (string | null)[]; status?: number } = {}) => {
    const calls: Call[] = [];
    const hosts = opts.hosts ?? ['192.168.1.42'];
    let hostIndex = 0;
    const logs: string[] = [];
    const fetchFn = vi.fn(async (url: string | URL, init?: RequestInit) => {
        calls.push({ url: String(url), init: init ?? {} });
        return { ok: (opts.status ?? 200) < 400, status: opts.status ?? 200 } as Response; // fixture: publisher reads ok/status only
    });
    const publisher = createLanPublisher({
        deviceId: 'dev_listener_abc',
        apiKey: 'zk_test',
        baseUrl: 'https://api.example/v1',
        log: (m) => logs.push(m),
        fetchFn,
        pickHost: () => hosts[Math.min(hostIndex++, hosts.length - 1)] ?? null,
    });
    const bodies = () => calls.map((c) => JSON.parse(String(c.init.body)));
    return { publisher, calls, bodies, logs, fetchFn };
};

describe('createLanPublisher', () => {
    it('PUTs {lan: {host, port}} on the device record with the API key', async () => {
        const h = publisherHarness();
        const published = await h.publisher.publish(54321);
        expect(published).toBe(true);
        expect(h.calls).toHaveLength(1);
        expect(h.calls[0].url).toBe('https://api.example/v1/devices/dev_listener_abc');
        expect(h.calls[0].init.method).toBe('PUT');
        expect(h.calls[0].init.headers?.['X-API-Key']).toBe('zk_test');
        expect(h.bodies()[0]).toEqual({ lan: { host: '192.168.1.42', port: 54321 } });
    });

    it('does not re-PUT an unchanged endpoint, and does when forced (reconnect)', async () => {
        const h = publisherHarness();
        await h.publisher.publish(54321);
        expect(await h.publisher.publish(54321)).toBe(false);
        expect(h.calls).toHaveLength(1);
        expect(await h.publisher.publish(54321, { force: true })).toBe(true);
        expect(h.calls).toHaveLength(2);
    });

    it('re-PUTs when the LAN address changes', async () => {
        const h = publisherHarness({ hosts: ['192.168.1.42', '10.0.0.7'] });
        await h.publisher.publish(54321);
        await h.publisher.publish(54321);
        expect(h.bodies().map((b) => b.lan.host)).toEqual(['192.168.1.42', '10.0.0.7']);
    });

    it('publishes nothing when no private IPv4 is up, and clears a previously published one', async () => {
        const h = publisherHarness({ hosts: ['192.168.1.42', null] });
        await h.publisher.publish(54321);
        expect(await h.publisher.publish(54321)).toBe(false);
        expect(h.bodies()).toEqual([
            { lan: { host: '192.168.1.42', port: 54321 } },
            { lan: null },
        ]);
    });

    it('clear() PUTs lan: null and forgets the last endpoint', async () => {
        const h = publisherHarness();
        await h.publisher.publish(54321);
        await h.publisher.clear();
        expect(h.bodies()[1]).toEqual({ lan: null });
        // A later publish after clear must write again even though host:port is unchanged.
        expect(await h.publisher.publish(54321)).toBe(true);
    });

    it('logs and swallows a server rejection — the relay path must keep working', async () => {
        const h = publisherHarness({ status: 400 });
        await expect(h.publisher.publish(54321)).resolves.toBe(false);
        expect(h.logs.some((l) => /local transfer/.test(l) && /400/.test(l))).toBe(true);
        // Not remembered as published: the next call tries again.
        await h.publisher.publish(54321);
        expect(h.calls).toHaveLength(2);
    });

    it('logs and swallows a network failure', async () => {
        const h = publisherHarness();
        h.fetchFn.mockRejectedValueOnce(new Error('ECONNREFUSED'));
        await expect(h.publisher.publish(54321)).resolves.toBe(false);
        expect(h.logs.some((l) => /ECONNREFUSED/.test(l))).toBe(true);
    });

    it('watch() republishes only on a host change and stops cleanly', async () => {
        vi.useFakeTimers();
        try {
            const h = publisherHarness({ hosts: ['192.168.1.42', '192.168.1.42', '10.0.0.7'] });
            await h.publisher.publish(54321);
            h.publisher.startWatch(54321, 1000);
            await vi.advanceTimersByTimeAsync(1000);
            expect(h.calls).toHaveLength(1);
            await vi.advanceTimersByTimeAsync(1000);
            expect(h.calls).toHaveLength(2);
            h.publisher.stopWatch();
            await vi.advanceTimersByTimeAsync(5000);
            expect(h.calls).toHaveLength(2);
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('createLanPublisher — failure paths', () => {
    it('never rejects, even when the host picker throws', async () => {
        const logs: string[] = [];
        const publisher = createLanPublisher({
            deviceId: 'd', apiKey: 'k', baseUrl: 'https://api.example/v1',
            log: (m) => logs.push(m), fetchFn: vi.fn(), pickHost: () => { throw new Error('ifaces exploded'); },
        });
        await expect(publisher.publish(1)).resolves.toBe(false);
        expect(logs).toEqual(['local transfer: publish skipped — ifaces exploded']);
    });

    it('clear({timeoutMs}) bounds each retract attempt with its own signal — the shutdown budget', async () => {
        // AbortSignal.timeout runs on real timers, so the budget is kept tiny.
        const h = publisherHarness();
        await h.publisher.publish(54321);
        let aborted = 0;
        h.fetchFn.mockImplementation((_url: string | URL, init?: RequestInit) =>
            new Promise<Response>((_resolve, reject) => {
                init?.signal?.addEventListener('abort', () => { aborted += 1; reject(new Error('aborted')); });
            }));
        await h.publisher.clear({ timeoutMs: 20 });
        expect(aborted).toBe(2);                     // both attempts cut off by the budget, not hung
        expect(h.logs.filter((l) => /publish failed/.test(l))).toHaveLength(2);
    });

    it('a failed retract keeps the endpoint remembered so the next tick retries it', async () => {
        const h = publisherHarness();
        await h.publisher.publish(54321);
        h.fetchFn.mockRejectedValueOnce(new Error('down')).mockRejectedValueOnce(new Error('down'));
        await h.publisher.clear();                 // both attempts fail
        expect(h.fetchFn).toHaveBeenCalledTimes(3);
        await h.publisher.clear();                 // still remembered → tries again, succeeds first time
        expect(h.fetchFn).toHaveBeenCalledTimes(4);
        await h.publisher.clear();                 // nothing left to retract
        expect(h.fetchFn).toHaveBeenCalledTimes(4);
    });
});

describe('createLanPublisher — ordering', () => {
    it('a retract issued while a publish is in flight lands after it', async () => {
        const order: string[] = [];
        let releasePublish!: () => void;
        const gate = new Promise<void>((r) => { releasePublish = r; });
        const fetchFn = vi.fn(async (_url: string | URL, init?: RequestInit) => {
            const lan = JSON.parse(String(init?.body)).lan;
            if (lan !== null) await gate;             // the {host, port} PUT is slow
            order.push(lan === null ? 'retract' : 'publish');
            return { ok: true, status: 200 } as Response; // fixture: publisher reads ok/status only
        });
        const publisher = createLanPublisher({
            deviceId: 'dev_listener_abc', apiKey: 'zk', baseUrl: 'https://api.example/v1',
            log: () => undefined, fetchFn, pickHost: () => '192.168.1.42',
        });
        const publishing = publisher.publish(54321);
        const clearing = publisher.clear();
        releasePublish();
        await Promise.all([publishing, clearing]);
        expect(order).toEqual(['publish', 'retract']);
    });
});
