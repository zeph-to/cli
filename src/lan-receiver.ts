import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

/**
 * Local transfer (ADR-0013) — the listener's LAN-facing HTTP server.
 *
 * Binds an OS-assigned port on every interface; the port is what
 * `lan-endpoint.ts` publishes. Nothing here is reachable from the internet
 * on purpose (the server only ever stores a private IPv4 for it), but a
 * public Wi-Fi is a LAN too, so every route the receiver grows must
 * authenticate before it reads a body.
 *
 * Slice 02 binds and answers 404 to everything; the ping and upload routes
 * arrive with slice 04.
 */

export interface LanReceiverOptions {
    log: (msg: string) => void;
    /** A server error after the bind. The socket is unusable from here;
     *  the caller retracts the endpoint and turns the feature off. */
    onError?: (err: Error) => void;
}

export interface LanReceiver {
    port: number;
    /** Close the socket. Idempotent; resolves once the port is released. */
    stop: () => Promise<void>;
}

const notFound = (_req: IncomingMessage, res: ServerResponse): void => {
    res.statusCode = 404;
    res.end();
};

export const startLanReceiver = (opts: LanReceiverOptions): Promise<LanReceiver> =>
    new Promise((resolve, reject) => {
        const server: Server = createServer(notFound);
        // A client that opens a socket and never sends headers must not hold
        // a slot; uploads themselves get a longer budget per request later.
        server.headersTimeout = 5_000;
        server.requestTimeout = 30_000;
        let listening = false;
        // Stays attached for the server's whole life: an `error` with no
        // listener is an uncaught throw, and this socket must never be the
        // thing that takes the relay-serving daemon down with it.
        server.on('error', (err: Error) => {
            if (!listening) { reject(err); return; }
            opts.log(`local transfer: server error — ${err.message}`);
            opts.onError?.(err);
        });
        server.listen(0, '0.0.0.0', () => {
            listening = true;
            const address = server.address();
            if (typeof address !== 'object' || address === null) {
                // Cannot happen after a TCP listen; if it does, publishing
                // port 0 would only be refused by the server, silently.
                server.close();
                reject(new Error('bound socket reported no address'));
                return;
            }
            const port = address.port;
            opts.log(`local transfer: listening on 0.0.0.0:${port}`);

            let closed: Promise<void> | null = null;
            const stop = (): Promise<void> => {
                if (closed) return closed;
                closed = new Promise<void>((done) => {
                    server.close(() => done());
                    server.closeAllConnections();
                });
                return closed;
            };
            resolve({ port, stop });
        });
    });
