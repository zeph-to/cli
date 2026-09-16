import { describe, expect, it, vi } from 'vitest';
import { createLanTransfer } from './lan-transfer.js';
import type { LanPublisher } from './lan-endpoint.js';
import type { LanReceiver } from './lan-receiver.js';

// The listener's local-transfer lifecycle (ADR-0013), pulled out of the
// daemon's main so the two orderings that matter can be pinned: the socket
// opening before or after the receiver is bound, and SIGTERM landing before
// the receiver is even up. A record left pointing at a closed port is the
// failure every branch here guards against.

const deferred = <T,>() => {
    let resolve!: (v: T) => void;
    let reject!: (e: Error) => void;
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
};

const harness = () => {
    const logs: string[] = [];
    const init = deferred<void>();
    const bind = deferred<LanReceiver>();
    const receiver: LanReceiver = { port: 54321, stop: vi.fn(async () => undefined) };
    const publisher: LanPublisher = {
        publish: vi.fn(() => true),
        clear: vi.fn(),
        startWatch: vi.fn(),
        stopWatch: vi.fn(),
    };
    let open = false;
    let receiverError: ((err: Error) => void) | null = null;
    const transfer = createLanTransfer({
        log: (m) => logs.push(m),
        initCrypto: () => init.promise,
        startReceiver: ({ onError }) => { receiverError = onError; return bind.promise; },
        createPublisher: () => publisher,
        isOpen: () => open,
    });
    const settle = () => new Promise((r) => setTimeout(r, 0));
    return { transfer, logs, init, bind, receiver, publisher, settle, setOpen: (v: boolean) => { open = v; }, failReceiver: (err: Error) => receiverError?.(err) };
};

describe('createLanTransfer', () => {
    it('binds after the keys load, watches, and publishes on the next socket open', async () => {
        const h = harness();
        h.transfer.onOpen();                       // socket opened before the receiver exists — nothing to publish yet
        h.init.resolve(); h.bind.resolve(h.receiver); await h.settle();
        expect(h.publisher.startWatch).toHaveBeenCalledWith(54321);
        expect(h.publisher.publish).not.toHaveBeenCalled();
        h.transfer.onOpen();
        expect(h.publisher.publish).toHaveBeenCalledWith(54321, { force: true });
    });

    it('publishes immediately when the socket is already open by the time the receiver binds', async () => {
        const h = harness();
        h.setOpen(true);
        h.init.resolve(); h.bind.resolve(h.receiver); await h.settle();
        expect(h.publisher.publish).toHaveBeenCalledWith(54321, { force: true });
    });

    it('stop() retracts the endpoint and closes the socket, once', async () => {
        const h = harness();
        h.init.resolve(); h.bind.resolve(h.receiver); await h.settle();
        await h.transfer.stop();
        await h.transfer.stop();
        expect(h.publisher.stopWatch).toHaveBeenCalledTimes(1);
        expect(h.publisher.clear).toHaveBeenCalledTimes(1);
        expect(h.receiver.stop).toHaveBeenCalledTimes(1);
        h.transfer.onOpen();                       // a late open after stop must not republish a closed port
        expect(h.publisher.publish).not.toHaveBeenCalled();
    });

    it('stop() retracts the endpoint and releases the port', async () => {
        const h = harness();
        h.init.resolve(); h.bind.resolve(h.receiver); await h.settle();
        await h.transfer.stop();
        expect(h.publisher.stopWatch).toHaveBeenCalled();
        expect(h.publisher.clear).toHaveBeenCalled();
        expect(h.receiver.stop).toHaveBeenCalled();
    });

    it('SIGTERM before the receiver is up: closes it on arrival, never publishes or watches', async () => {
        const h = harness();
        const stopping = h.transfer.stop();        // keys still loading
        h.init.resolve(); h.bind.resolve(h.receiver); await h.settle();
        await stopping;
        expect(h.receiver.stop).toHaveBeenCalledTimes(1);
        expect(h.publisher.startWatch).not.toHaveBeenCalled();
        expect(h.publisher.publish).not.toHaveBeenCalled();
        expect(h.publisher.clear).not.toHaveBeenCalled();   // nothing was ever published
    });

    it('a receiver that dies after bind is retracted and released, and the watch stops', async () => {
        const h = harness();
        h.init.resolve(); h.bind.resolve(h.receiver); await h.settle();
        h.failReceiver(new Error('EMFILE')); await h.settle();
        expect(h.publisher.stopWatch).toHaveBeenCalledTimes(1);
        expect(h.publisher.clear).toHaveBeenCalledTimes(1);
        expect(h.receiver.stop).toHaveBeenCalledTimes(1);
        expect(h.logs).toEqual(['local transfer: off — receiver failed after bind (EMFILE)']);
        h.transfer.onOpen();
        expect(h.publisher.publish).not.toHaveBeenCalled();
        await h.transfer.stop();                   // later SIGTERM finds nothing left to do
        expect(h.publisher.clear).toHaveBeenCalledTimes(1);
    });

    it('a failed key load or bind turns the feature off with one log line', async () => {
        const h = harness();
        h.init.reject(new Error('no keys')); await h.settle();
        expect(h.logs).toEqual(['local transfer: off — no keys']);
        h.transfer.onOpen();
        expect(h.publisher.publish).not.toHaveBeenCalled();
        await expect(h.transfer.stop()).resolves.toBeUndefined();
    });
});

describe('listener module', () => {
    it('binds no socket and publishes nothing just by being imported (the inventory worker imports it)', async () => {
        vi.resetModules();
        const receiver = await import('./lan-receiver.js');
        const startSpy = vi.spyOn(receiver, 'startLanReceiver');
        vi.doMock('./lan-receiver.js', () => receiver);
        await import('./listener.js');
        expect(startSpy).not.toHaveBeenCalled();
    });
});
