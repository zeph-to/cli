/**
 * What the daemon does when the server rejects its inventory reports.
 *
 * Measured failure (2026-09-12): the server lost the connection record while
 * the socket stayed open, every `listener.sessions` came back rejected, and the
 * daemon went on reporting into it for eight minutes — "reported 8 session(s)"
 * in the log, no agents at all on the phone. Nothing recovered it but a human
 * restart, because the rejection was logged and dropped.
 *
 * The socket is the only lever the daemon has here, so the policy is two guards
 * around pulling it: pull it when the server asks for a reconnect, and stop
 * pulling once reconnecting has visibly not helped.
 */
import { describe, expect, it } from 'vitest';

const { askedToReconnect, staleConnectionAction, MAX_STALE_CONNECTION_DROPS } =
    await import('./listener.js');

describe('askedToReconnect', () => {
    it('reads the instruction, not the diagnosis', () => {
        // The server's own wording, verbatim.
        expect(askedToReconnect('Connection has no deviceId — reconnect with ?deviceId=...')).toBe(true);
    });

    it('leaves every other rejection alone', () => {
        // Reconnecting fixes a connection the server does not know. It does not
        // fix a report the server refuses to read, and a daemon that reconnects
        // on those would spend its life connecting.
        expect(askedToReconnect('sessions payload too large')).toBe(false);
        expect(askedToReconnect(undefined)).toBe(false);
        expect(askedToReconnect({ message: 'reconnect' })).toBe(false);
    });
});

describe('staleConnectionAction', () => {
    const MSG = 'Connection has no deviceId — reconnect with ?deviceId=...';

    it('drops the socket the first time the server asks', () => {
        expect(staleConnectionAction(MSG, 0)).toBe('drop');
    });

    it('keeps dropping up to the cap', () => {
        expect(staleConnectionAction(MSG, MAX_STALE_CONNECTION_DROPS - 1)).toBe('drop');
    });

    it('stops once reconnecting has not helped that many times', () => {
        // A fresh connection that is rejected again says the problem is not the
        // connection. Better a daemon that logs than one that connect-loops.
        expect(staleConnectionAction(MSG, MAX_STALE_CONNECTION_DROPS)).toBe('exhausted');
    });

    it('ignores a rejection that asks for nothing', () => {
        expect(staleConnectionAction('malformed report', 0)).toBe('ignore');
    });
});
