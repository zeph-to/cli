import type { LanPublisher } from './lan-endpoint.js';
import type { LanReceiver } from './lan-receiver.js';

/**
 * Local transfer (ADR-0013) — the listener's lifecycle for it, in one place.
 *
 * Order of events the daemon cannot control: the WebSocket may open before or
 * after the receiver is bound, and SIGTERM may land while the keys are still
 * loading. Every branch here ends the same way — the device record never
 * points at a port nobody is listening on:
 *
 *   keys → bind → (socket already open? publish now) → watch the address
 *   socket open  → force-publish (the record exists from $connect on)
 *   stop         → stop the watch, `lan: null`, close the socket — or, if
 *                  the bind has not finished yet, close it the moment it does
 */

export interface LanTransferDeps {
    log: (msg: string) => void;
    initCrypto: () => Promise<void>;
    /** Bind the receiver; `onError` fires if the bound socket later dies. */
    startReceiver: (hooks: { onError: (err: Error) => void }) => Promise<LanReceiver>;
    createPublisher: (port: number) => LanPublisher;
    /** Whether the WebSocket has reached `open` right now. */
    isOpen: () => boolean;
}

export interface LanTransfer {
    /** Call on every WebSocket `open`. No-op until the receiver is bound. */
    onOpen: () => void;
    /** Retract the endpoint and release the port. Idempotent. Resolves once
     *  the receiver's socket is closed; the retract itself is one frame on a
     *  socket that is already closing, so it is sent and not waited on. */
    stop: () => Promise<void>;
}

interface Live {
    publisher: LanPublisher;
    receiver: LanReceiver;
}

export const createLanTransfer = (deps: LanTransferDeps): LanTransfer => {
    let live: Live | null = null;
    let stopping = false;

    // A bound socket that dies later must not keep being re-affirmed by the
    // watch: retract, release, and turn the feature off with one log line.
    const onReceiverError = (err: Error): void => {
        deps.log(`local transfer: off — receiver failed after bind (${err.message})`);
        void teardown();
    };

    const ready: Promise<void> = deps.initCrypto()
        .then(() => deps.startReceiver({ onError: onReceiverError }))
        .then((receiver) => {
            if (stopping) {
                // Bound after stop() was already called: nothing was published,
                // so there is nothing to retract — just let the port go.
                void receiver.stop();
                return;
            }
            const publisher = deps.createPublisher(receiver.port);
            live = { publisher, receiver };
            publisher.startWatch(receiver.port);
            if (deps.isOpen()) publisher.publish(receiver.port, { force: true });
        })
        .catch((err: unknown) => {
            deps.log(`local transfer: off — ${err instanceof Error ? err.message : String(err)}`);
        });

    const onOpen = (): void => {
        if (live) live.publisher.publish(live.receiver.port, { force: true });
    };

    const teardown = async (): Promise<void> => {
        if (!live) return;
        const current = live;
        live = null;
        current.publisher.stopWatch();
        current.publisher.clear();
        await current.receiver.stop();
    };

    let stopped: Promise<void> | null = null;
    const stop: LanTransfer['stop'] = () => {
        if (stopped) return stopped;
        stopping = true;
        stopped = ready.then(() => teardown());
        return stopped;
    };

    return { onOpen, stop };
};
