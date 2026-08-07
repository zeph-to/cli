import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

// tmux is faked wholesale (as in listener-stream-lease.test.ts): what is under
// test is the ephemeral input path's guards and ordering, not tmux itself.
// `zeph-shell` reports a shell as its pane command — the RCE guard's subject.
const FIELD_SEP = '␟';
const SESSIONS = ['zeph-a', 'zeph-shell', 'zeph-rate', 'zeph-cost'];

/** Every tmux call the code made, in order — the injection evidence. */
let tmuxCalls: string[][] = [];

let bufferFails = false;
let pasteFails = false;

const fakeTmux = (args: readonly string[]) => {
    // Drop the optional `-S <socket>` prefix tmuxArgs() prepends.
    const a = args[0] === '-S' ? args.slice(2) : args;
    tmuxCalls.push([...a]);
    if (a[0] === 'list-sessions') {
        const stdout = SESSIONS.map((n) => [n, '0', '1700000000', '1700000000'].join(FIELD_SEP)).join('\n');
        return { status: 0, stdout, stderr: '' };
    }
    if (a[0] === 'display-message') {
        const paneCommand = a[3] === 'zeph-shell' ? 'zsh' : 'node';
        // Two callers, two formats: the inject guard asks for the current
        // command alone, the inventory asks for the four-field pane record.
        if (a[4] === '#{pane_current_command}') return { status: 0, stdout: paneCommand, stderr: '' };
        return { status: 0, stdout: [paneCommand, 'claude', '/tmp/proj', '1234'].join(FIELD_SEP), stderr: '' };
    }
    if (a[0] === 'capture-pane') return { status: 0, stdout: 'idle pane\n', stderr: '' };
    if (a[0] === 'send-keys') return { status: 0, stdout: '', stderr: '' };
    // Text is delivered as a paste, not as typing (see pasteText). `bufferFails`
    // / `pasteFails` let a test drive the fallback back onto `send-keys -l`.
    if (a[0] === 'set-buffer') return { status: bufferFails ? 1 : 0, stdout: '', stderr: '' };
    if (a[0] === 'paste-buffer') return { status: pasteFails ? 1 : 0, stdout: '', stderr: '' };
    if (a[0] === 'delete-buffer') return { status: 0, stdout: '', stderr: '' };
    return { status: 1, stdout: '', stderr: '' };
};

vi.mock('child_process', async (importOriginal) => {
    const actual = await importOriginal<typeof import('child_process')>();
    return {
        ...actual,
        spawnSync: (cmd: string, args?: readonly string[]) =>
            cmd === 'tmux' ? fakeTmux(args ?? []) : { status: 1, stdout: '', stderr: '' },
    };
});

// Redirect the device-id file and the remote-origin marker into a temp dir
// before listener.ts resolves either at import time.
const TMP = mkdtempSync(join(tmpdir(), 'zeph-input-'));
process.env.HOME = TMP;
process.env.XDG_STATE_HOME = join(TMP, 'state');

const {
    handleCommandInput,
    handleStreamControl,
    stopAllStreams,
    computeListenerDeviceId,
    checkRateLimit,
    validateInputMessage,
    pendingInputDecrypts,
    MAX_INPUT_KEYS,
    MAX_INPUT_BODY_CHARS,
} = await import('./listener.js');

const { INPUT_HOLD_MS, MAX_PENDING_INPUTS } = await import('./input-sequencer.js');

describe('agent.command.input — ephemeral injection into a streamed pane', () => {
    const device = computeListenerDeviceId();
    let sent: Array<Record<string, unknown>>;

    const send = (data: Record<string, unknown>) => { sent.push(data); };

    beforeEach(() => {
        vi.useFakeTimers();
        vi.spyOn(console, 'log').mockImplementation(() => {});
        tmuxCalls = [];
        sent = [];
        bufferFails = false;
        pasteFails = false;
    });
    afterEach(() => {
        stopAllStreams();
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    /** Take the stream lease that input rides on. */
    const openStream = (sessionName: string) => {
        handleStreamControl(
            { subtype: 'agent.stream.start', targetDeviceId: device, sessionName, renew: true },
            send,
        );
        sent = [];
        tmuxCalls = [];
    };

    const input = (over: Record<string, unknown> = {}) => ({
        subtype: 'agent.command.input',
        targetDeviceId: device,
        sessionName: 'zeph-a',
        keys: ['down'],
        seq: 1,
        epoch: 100,
        ...over,
    });

    const injections = () => tmuxCalls.filter((c) => c[0] === 'send-keys').map((c) => c.slice(1).join(' '));
    /** Every tmux call the delivery made, in order — the paste path spans three. */
    const tmuxInvocations = () =>
        tmuxCalls.filter((c) => ['send-keys', 'set-buffer', 'paste-buffer', 'delete-buffer'].includes(c[0])).map((c) => c.join(' '));
    const rejections = () => sent.filter((f) => f.error === 'input_rejected');

    it('injects whitelisted keys into a session with a live stream', () => {
        openStream('zeph-a');
        expect(handleCommandInput(input(), send)).toBe(true);
        expect(injections()).toEqual(['-t zeph-a Down']);
        expect(rejections()).toEqual([]);
    });

    it('delivers text as a paste, then Enter — never as a burst of typing', () => {
        // A TUI that re-renders per character cannot keep up with a whole
        // Hangul message arriving as keystrokes: characters go missing and the
        // wrapped line is painted twice. `-p` brackets the paste only when the
        // application asked for it, so this is safe against one that did not.
        openStream('zeph-a');
        handleCommandInput(input({ keys: undefined, body: 'hello; rm -rf /' }), send);
        expect(tmuxInvocations()).toEqual([
            // `--` so a message beginning with a dash stays data, and the
            // buffer contents are data to paste-buffer — same property `-l`
            // had: no escape inside a message can drive another tmux command.
            'set-buffer -b zeph-inject -- hello; rm -rf /',
            'paste-buffer -d -p -b zeph-inject -t zeph-a',
            'send-keys -t zeph-a Enter',
        ]);
    });

    it('falls back to typing when the buffer cannot be set', () => {
        // Delivered imperfectly beats not delivered.
        bufferFails = true;
        openStream('zeph-a');
        handleCommandInput(input({ keys: undefined, body: 'hello' }), send);
        expect(injections()).toEqual(['-l -t zeph-a hello', '-t zeph-a Enter']);
    });

    it('drops the buffer it filled when the paste fails, then falls back', () => {
        // `-d` never ran, so the message would otherwise sit in a tmux buffer.
        pasteFails = true;
        openStream('zeph-a');
        handleCommandInput(input({ keys: undefined, body: 'hello' }), send);
        expect(tmuxInvocations()).toContain('delete-buffer -b zeph-inject');
        expect(injections()).toEqual(['-l -t zeph-a hello', '-t zeph-a Enter']);
    });

    it('refuses input for a session with no live stream', () => {
        // No lease means nobody is watching the pane this would type into.
        // The rejection is what tells the sender to fall back to a REST push.
        expect(handleCommandInput(input(), send)).toBe(true);
        expect(injections()).toEqual([]);
        expect(rejections()[0]).toMatchObject({
            subtype: 'agent.stream.frame',
            sessionName: 'zeph-a',
            error: 'input_rejected',
        });
    });

    it('names the refused sender on the rejection so devices cannot claim each other\'s refusals', () => {
        // Two devices type into one pane with independent seq/epoch runs; a
        // colliding stamp alone must not trigger the other device's REST resend.
        handleCommandInput(input({ deviceId: 'dev-phone' }), send);
        expect(rejections()[0]).toMatchObject({
            error: 'input_rejected',
            seq: 1,
            epoch: 100,
            inputDeviceId: 'dev-phone',
        });
    });

    it('stops accepting input once the stream is gone', () => {
        openStream('zeph-a');
        stopAllStreams();
        handleCommandInput(input(), send);
        expect(injections()).toEqual([]);
        expect(rejections()).toHaveLength(1);
    });

    it('leaves another machine\'s input alone', () => {
        // The relay fans ephemeral messages out to every connection of this
        // user, and two machines can run the same tmux session name.
        openStream('zeph-a');
        expect(handleCommandInput(input({ targetDeviceId: 'dev_someone_else' }), send)).toBe(false);
        expect(injections()).toEqual([]);
        expect(sent).toEqual([]);
    });

    it('refuses prototype-chain key names — the whitelist knows only what was put in', () => {
        // Plain-object indexing resolved `constructor`/`__proto__` to functions
        // that spawnSync stringified straight into the pane. The Map-backed
        // whitelist must refuse both like any unknown key.
        openStream('zeph-a');
        handleCommandInput(input({ keys: ['constructor'] }), send);
        handleCommandInput(input({ keys: ['__proto__'], seq: 2 }), send);
        expect(injections()).toEqual([]);
        expect(rejections()).toHaveLength(2);
    });

    it('refuses keys outside the whitelist, and refuses the batch wholesale', () => {
        openStream('zeph-a');
        handleCommandInput(input({ keys: ['C-c'] }), send);
        // A partial batch would leave the pane in a worse mid-state than none.
        handleCommandInput(input({ seq: 2, keys: ['down', 'M-x'] }), send);
        expect(injections()).toEqual([]);
        expect(rejections()).toHaveLength(2);
    });

    it('refuses an encrypted payload on a plaintext stream', () => {
        // Nothing binds the envelope to a subscriber on a stream that handshook
        // no key, and injecting the plaintext riding alongside would leave a
        // sender believing its input was protected when it was not.
        openStream('zeph-a');
        handleCommandInput(input({ encrypted: { iv: 'x', ciphertext: 'y' } }), send);
        handleCommandInput(input({ seq: 2, keys: undefined, body: 'hi', encrypted: {} }), send);
        expect(injections()).toEqual([]);
        expect(rejections()).toHaveLength(2);
    });

    it('refuses malformed messages', () => {
        openStream('zeph-a');
        for (const bad of [
            { keys: undefined, body: undefined },
            { keys: ['down'], body: 'both' },
            { seq: undefined },
            { epoch: undefined },
        ]) handleCommandInput(input(bad), send);
        expect(injections()).toEqual([]);
        expect(rejections()).toHaveLength(4);
        // Nothing to address the error to when the session is unnamed.
        sent = [];
        expect(handleCommandInput(input({ sessionName: undefined }), send)).toBe(true);
        expect(sent).toEqual([]);
    });

    it('refuses more keys than the REST path accepts', () => {
        // Parity with the server's MAX_KEYS_PER_COMMAND (apps/server pushes.ts):
        // the low-latency door into the same pane must not be the wider one.
        expect(MAX_INPUT_KEYS).toBe(10);
        openStream('zeph-a');
        handleCommandInput(input({ keys: new Array(MAX_INPUT_KEYS + 1).fill('down') }), send);
        expect(injections()).toEqual([]);
        expect(rejections()).toHaveLength(1);
        handleCommandInput(input({ seq: 2, keys: new Array(MAX_INPUT_KEYS).fill('down') }), send);
        expect(injections()).toHaveLength(1);
    });

    it('refuses a body past the injection cap', () => {
        expect(MAX_INPUT_BODY_CHARS).toBe(4096);
        openStream('zeph-a');
        handleCommandInput(input({ keys: undefined, body: 'x'.repeat(MAX_INPUT_BODY_CHARS + 1) }), send);
        expect(injections()).toEqual([]);
        expect(rejections()).toHaveLength(1);
        handleCommandInput(input({ seq: 2, keys: undefined, body: 'x'.repeat(MAX_INPUT_BODY_CHARS) }), send);
        expect(tmuxInvocations()).toHaveLength(3); // set-buffer + paste-buffer + Enter
    });

    it('lets a burst of key taps through, and still caps command submits at 30', () => {
        // Arrowing through a menu or holding Backspace is ordinary human speed.
        // Charging a keystroke as if it were a whole instruction refused the
        // phone's key row after a couple of seconds of normal tapping.
        // A session of its own: the bucket is module state, and another test
        // in this file drains `zeph-rate` on purpose.
        openStream('zeph-cost');
        let landed = 0;
        for (let seq = 1; seq <= 60; seq++) {
            tmuxCalls = [];
            handleCommandInput(input({ sessionName: 'zeph-cost', seq }), send);
            if (injections().length) landed++;
        }
        expect(landed).toBe(60);

        // Submits are the expensive half, and their ceiling is unchanged: the
        // 60 taps above cost 60 of 120, leaving room for 15 of the 30.
        let submits = 0;
        for (let seq = 61; seq <= 100; seq++) {
            tmuxCalls = [];
            handleCommandInput(input({ sessionName: 'zeph-cost', seq, keys: undefined, body: 'go' }), send);
            if (injections().length) submits++;
        }
        expect(submits).toBe(15);
    });

    it('refuses a seq or epoch that is not a safe non-negative integer', () => {
        // Number.isFinite admits 1e21, which parks the high-water mark past
        // anything a sender can count back to, and 1.5, which no later integer
        // can ever equal — every following key would sit out the hold.
        for (const bad of [{ seq: 1.5 }, { seq: -1 }, { seq: 1e21 }, { epoch: 2.5 }, { epoch: -1 }, { epoch: 1e21 }]) {
            openStream('zeph-a');
            handleCommandInput(input(bad), send);
            expect(injections(), JSON.stringify(bad)).toEqual([]);
            expect(rejections(), JSON.stringify(bad)).toHaveLength(1);
        }
    });

    it('rejects input once the reorder buffer is full', () => {
        expect(MAX_PENDING_INPUTS).toBe(32);
        openStream('zeph-a');
        handleCommandInput(input({ seq: 1, keys: ['up'] }), send);
        // seq 2 never arrives, so each of these buffers behind the gap.
        for (let i = 0; i < MAX_PENDING_INPUTS; i++) {
            handleCommandInput(input({ seq: 3 + i, keys: ['down'] }), send);
        }
        expect(rejections()).toEqual([]);
        handleCommandInput(input({ seq: 3 + MAX_PENDING_INPUTS, keys: ['down'] }), send);
        expect(rejections()).toHaveLength(1);
    });

    it('echoes seq/epoch on a rejection so the sender can match it', () => {
        // The web has several keystrokes in flight at once; a bare
        // input_rejected tells it something failed but not which one.
        openStream('zeph-a');
        handleCommandInput(input({ seq: 5, epoch: 100, keys: ['C-c'] }), send);
        expect(rejections()[0]).toMatchObject({ error: 'input_rejected', seq: 5, epoch: 100 });
    });

    it('orders each sender separately so two devices do not silence each other', () => {
        // The relay stamps the sending connection's deviceId onto every
        // ephemeral payload. One sequencer per session would let the web's
        // epoch supersede the phone's and drop everything the phone types next.
        openStream('zeph-a');
        handleCommandInput(input({ deviceId: 'dev_phone', seq: 1, epoch: 100, keys: ['up'] }), send);
        handleCommandInput(input({ deviceId: 'dev_web', seq: 1, epoch: 200, keys: ['down'] }), send);
        handleCommandInput(input({ deviceId: 'dev_phone', seq: 2, epoch: 100, keys: ['left'] }), send);
        expect(injections()).toEqual(['-t zeph-a Up', '-t zeph-a Down', '-t zeph-a Left']);
    });

    it('drops every sender\'s ordering state when the stream stops', () => {
        openStream('zeph-a');
        handleCommandInput(input({ deviceId: 'dev_phone', seq: 7, keys: ['up'] }), send);
        stopAllStreams();
        openStream('zeph-a');
        handleCommandInput(input({ deviceId: 'dev_phone', seq: 1, epoch: 100, keys: ['down'] }), send);
        expect(injections()).toEqual(['-t zeph-a Down']);
    });

    it('refuses plaintext input on an E2EE stream', () => {
        // Outbound frames are already encrypted for this subscriber, so typing
        // a plaintext keystroke in would leave the inbound half in the clear.
        // An encrypted stream takes encrypted input or none.
        handleStreamControl(
            { subtype: 'agent.stream.start', targetDeviceId: device, sessionName: 'zeph-a', renew: true, subscriberPublicKey: 'pk' },
            send,
        );
        sent = [];
        tmuxCalls = [];
        handleCommandInput(input(), send);
        expect(injections()).toEqual([]);
        expect(rejections()).toHaveLength(1);
    });

    it('consults the rate bucket before probing the pane', () => {
        // A flushed hold delivers a whole burst back to back, and the pane
        // probe is a blocking spawnSync — the cheap gate has to come first.
        openStream('zeph-rate');
        while (checkRateLimit('zeph-rate')) { /* drain the shared bucket */ }
        tmuxCalls = [];
        handleCommandInput(input({ sessionName: 'zeph-rate' }), send);
        expect(tmuxCalls).toEqual([]);
    });

    it('refuses ill-typed fields instead of throwing into the socket handler', () => {
        // The wire shape is an unchecked cast over relay JSON. A throw here
        // would escape the ws message handler and take the daemon with it.
        openStream('zeph-a');
        for (const bad of [
            { keys: 'down' },
            { keys: [] },
            { keys: [1, 2] },
            { keys: [{ length: 1 }] },
            { keys: undefined, body: { toString: 'nope' } },
            { sessionName: 42 },
        ]) expect(() => handleCommandInput(input(bad), send)).not.toThrow();
        expect(injections()).toEqual([]);
    });

    it('refuses to type into a pane sitting at a shell', () => {
        // Same RCE guard as the REST path: a shell prompt + send-keys is
        // arbitrary command execution.
        openStream('zeph-shell');
        handleCommandInput(input({ sessionName: 'zeph-shell', body: 'id', keys: undefined }), send);
        expect(injections()).toEqual([]);
        // A silent drop here contradicts the handler's own contract: the
        // sender learns nothing and never falls back to a REST push.
        expect(rejections()).toHaveLength(1);
    });

    it('spends the same rate-limit budget as the REST push path', () => {
        // A private counter here would double the effective 30/min cap.
        // Its own session: a drained bucket doesn't refill under fake timers,
        // so draining zeph-a's would silently gag every later test.
        openStream('zeph-rate');
        while (checkRateLimit('zeph-rate')) { /* drain the shared bucket */ }
        handleCommandInput(input({ sessionName: 'zeph-rate' }), send);
        expect(injections()).toEqual([]);
        expect(rejections()).toHaveLength(1);
    });

    it('reorders keys that arrive out of sequence', () => {
        openStream('zeph-a');
        handleCommandInput(input({ seq: 1, keys: ['up'] }), send);
        handleCommandInput(input({ seq: 3, keys: ['left'] }), send);
        handleCommandInput(input({ seq: 2, keys: ['down'] }), send);
        expect(injections()).toEqual(['-t zeph-a Up', '-t zeph-a Down', '-t zeph-a Left']);
    });

    it('types a held key once its gap times out rather than dropping it', () => {
        openStream('zeph-a');
        handleCommandInput(input({ seq: 1, keys: ['up'] }), send);
        handleCommandInput(input({ seq: 3, keys: ['left'] }), send);
        expect(injections()).toEqual(['-t zeph-a Up']);
        vi.advanceTimersByTime(INPUT_HOLD_MS);
        expect(injections()).toEqual(['-t zeph-a Up', '-t zeph-a Left']);
    });

    it('drops a duplicate rather than typing the key twice', () => {
        openStream('zeph-a');
        handleCommandInput(input({ seq: 1, keys: ['up'] }), send);
        handleCommandInput(input({ seq: 1, keys: ['up'] }), send);
        expect(injections()).toEqual(['-t zeph-a Up']);
    });

    it('accepts the first key of a re-subscribed stream', () => {
        // A restarted sender counts from seq 1 again; the previous run's
        // high-water mark must not swallow the new run's opening keys.
        openStream('zeph-a');
        handleCommandInput(input({ seq: 7, keys: ['up'] }), send);
        stopAllStreams();
        openStream('zeph-a');
        handleCommandInput(input({ seq: 1, epoch: 100, keys: ['down'] }), send);
        expect(injections()).toEqual(['-t zeph-a Down']);
    });

    it('validateInputMessage keeps the wire contract without touching tmux', () => {
        const ok = validateInputMessage({ sessionName: 'zeph-a', keys: ['escape'], seq: 4, epoch: 9 });
        expect(ok).toEqual({
            ok: true,
            input: { sessionName: 'zeph-a', seq: 4, epoch: 9, tokens: ['Escape'], text: null },
        });
        expect(validateInputMessage({ sessionName: 'zeph-a', body: 'hi', seq: 4, epoch: 9 })).toMatchObject({
            ok: true,
            input: { tokens: null, text: 'hi' },
        });
        expect(tmuxCalls).toEqual([]);
    });

    // ─── E2EE input ─────────────────────────────────────────────────
    //
    // Real ECDH keys throughout — a stubbed envelope would prove nothing about
    // a path whose whole job is cryptographic. The subscriber is played by this
    // host's own device keypair: ECDH is symmetric, so an envelope
    // `encryptEphemeral` seals for that key carries it as `senderPublicKey`
    // AND opens with it, which is exactly the shape a real web subscriber
    // produces. That the WEB's encrypt() produces the same five fields is
    // crypto.test.ts's job (decryptEphemeral ← webEncrypt); what is under test
    // here is the routing and the guards around it.
    describe('encrypted input', () => {
        /** Open an E2EE stream whose subscriber holds `subscriberPublicKey`. */
        const openE2eeStream = (subscriberPublicKey: string, sessionName = 'zeph-a') => {
            handleStreamControl(
                { subtype: 'agent.stream.start', targetDeviceId: device, sessionName, renew: true, subscriberPublicKey },
                send,
            );
            sent = [];
            tmuxCalls = [];
        };

        /** A stranger's public key — a device that is not the subscriber. */
        const strangerPublicKey = async (): Promise<string> => {
            const { webcrypto } = await import('node:crypto');
            const wc = webcrypto as unknown as Crypto;
            const pair = await wc.subtle.generateKey(
                { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey', 'deriveBits'],
            ) as CryptoKeyPair;
            const spki = new Uint8Array(await wc.subtle.exportKey('spki', pair.publicKey));
            let bin = '';
            for (let i = 0; i < spki.length; i++) bin += String.fromCharCode(spki[i]);
            return btoa(bin);
        };

        const hostKey = () => import('./crypto.js').then((m) => m.initDeviceCrypto());

        /**
         * Seal one payload the way the web does: the routing stamp
         * (sessionName, seq, epoch) rides INSIDE the ciphertext next to the
         * keys, so a relay that captured an envelope cannot replay it under a
         * fresh plaintext stamp. Defaults match `input()`'s, so a sealed
         * message and the frame carrying it agree unless a test says otherwise.
         */
        const seal = async (
            payload: Record<string, unknown>,
            stamp: Record<string, unknown> = {},
            recipient?: string,
        ) => {
            const { encryptEphemeral } = await import('./crypto.js');
            return encryptEphemeral(
                JSON.stringify({ sessionName: 'zeph-a', seq: 1, epoch: 100, ...payload, ...stamp }),
                recipient ?? (await hostKey()),
            );
        };

        it('refuses new envelopes once the decrypt queue is full', async () => {
            // The subscriber-key binding is a string compare against a public
            // key every same-account connection saw, so it cannot bound the
            // ECDH work a flooding client queues — the depth cap must.
            const { MAX_PENDING_DECRYPTS } = await import('./listener.js');
            openE2eeStream(await hostKey());
            const envelope = await seal({ keys: ['down'] });

            for (let i = 0; i < MAX_PENDING_DECRYPTS + 5; i++) {
                handleCommandInput(input({ seq: 1, keys: undefined, encrypted: envelope }), send);
            }
            expect(rejections().length).toBeGreaterThanOrEqual(5);
            await pendingInputDecrypts();
        });

        it('stops taking sealed input after repeated failed decrypts', async () => {
            // The binding says who may enqueue an ECDH derive, not that they
            // can produce an openable envelope — so a flood of garbage would
            // otherwise spend the one shared decrypt chain indefinitely.
            const subscriberKey = await hostKey();
            openE2eeStream(subscriberKey, 'zeph-a');
            const garbage = { ciphertext: 'AAAA', iv: 'AAAA', encryptedKey: 'AAAA', keyIv: 'AAAA', senderPublicKey: subscriberKey };

            for (let i = 0; i < 6; i++) {
                handleCommandInput(input({ sessionName: 'zeph-a', seq: i + 1, keys: undefined, encrypted: garbage }), send);
                await pendingInputDecrypts();
            }
            // Struck out: a genuine envelope now gets no decrypt either, until
            // the stream is re-subscribed.
            handleCommandInput(
                input({ sessionName: 'zeph-a', seq: 9, keys: undefined, encrypted: await seal({ keys: ['down'] }, { sessionName: 'zeph-a', seq: 9 }) }),
                send,
            );
            await pendingInputDecrypts();
            expect(injections()).toEqual([]);

            // A fresh subscription mints a fresh entry, so the strikes are gone.
            openE2eeStream(subscriberKey, 'zeph-a');
            handleCommandInput(
                input({ sessionName: 'zeph-a', seq: 1, keys: undefined, encrypted: await seal({ keys: ['down'] }, { sessionName: 'zeph-a', seq: 1 }) }),
                send,
            );
            await pendingInputDecrypts();
            expect(injections()).toEqual(['-t zeph-a Down']);
        });

        it('injects keys carried inside an envelope from the stream subscriber', async () => {
            openE2eeStream(await hostKey());

            handleCommandInput(input({ keys: undefined, encrypted: await seal({ keys: ['down'] }) }), send);
            await pendingInputDecrypts();

            expect(injections()).toEqual(['-t zeph-a Down']);
            expect(rejections()).toEqual([]);
        });

        it('injects literal text carried inside an envelope', async () => {
            openE2eeStream(await hostKey());

            handleCommandInput(input({ keys: undefined, encrypted: await seal({ body: 'hello; rm -rf /' }) }), send);
            await pendingInputDecrypts();

            expect(tmuxInvocations()).toEqual([
                'set-buffer -b zeph-inject -- hello; rm -rf /',
                'paste-buffer -d -p -b zeph-inject -t zeph-a',
                'send-keys -t zeph-a Enter',
            ]);
        });

        it('never puts the decrypted payload back on the wire', async () => {
            // The relay carries the refusal frames, so a decrypted key name
            // echoed into one would undo the encryption it just came out of.
            openE2eeStream(await hostKey());

            handleCommandInput(input({ keys: undefined, encrypted: await seal({ keys: ['C-c'] }) }), send);
            await pendingInputDecrypts();

            expect(rejections()).toHaveLength(1);
            expect(JSON.stringify(sent)).not.toContain('C-c');
        });

        // ── Replay binding ──
        //
        // The relay is the party E2EE distrusts, and it sees every envelope go
        // past. Without the stamp sealed inside, it could keep a captured
        // keystroke and re-send it under a seq the daemon has not used yet —
        // the ciphertext still opens, the subscriber key still matches, and a
        // real key lands in the pane a second time at a moment of its choosing.

        it('refuses a captured envelope replayed under a fresh seq', async () => {
            openE2eeStream(await hostKey());
            const encrypted = await seal({ keys: ['down'] }, { seq: 1 });

            // The genuine send, then the relay's replay of the very same bytes
            // under the next seq — which the sequencer would otherwise take as
            // an ordinary following keystroke.
            handleCommandInput(input({ seq: 1, keys: undefined, encrypted }), send);
            await pendingInputDecrypts();
            handleCommandInput(input({ seq: 2, keys: undefined, encrypted }), send);
            await pendingInputDecrypts();

            expect(injections()).toEqual(['-t zeph-a Down']);
            expect(rejections()).toHaveLength(1);
        });

        it('refuses an envelope re-stamped with another epoch or session', async () => {
            openE2eeStream(await hostKey());
            openE2eeStream(await hostKey(), 'zeph-rate'); // a second stream to aim at

            // Same three seals, each contradicted by the plaintext frame in one
            // field. Every one of them decrypts perfectly.
            handleCommandInput(input({ keys: undefined, epoch: 999, encrypted: await seal({ keys: ['down'] }) }), send);
            handleCommandInput(input({ seq: 2, keys: undefined, encrypted: await seal({ keys: ['down'] }, { seq: 2, sessionName: 'zeph-rate' }) }), send);
            handleCommandInput(input({ seq: 3, keys: undefined, encrypted: await seal({ keys: ['down'] }, { seq: 3, epoch: 7 }) }), send);
            await pendingInputDecrypts();

            expect(injections()).toEqual([]);
            expect(rejections()).toHaveLength(3);
        });

        it('refuses an envelope carrying no stamp at all', async () => {
            // A sealed payload from a client too old to stamp: it cannot be
            // told apart from a replay, so it is refused rather than trusted.
            openE2eeStream(await hostKey());
            const { encryptEphemeral } = await import('./crypto.js');

            handleCommandInput(
                input({ keys: undefined, encrypted: await encryptEphemeral(JSON.stringify({ keys: ['down'] }), await hostKey()) }),
                send,
            );
            await pendingInputDecrypts();

            expect(injections()).toEqual([]);
            expect(rejections()).toHaveLength(1);
        });

        it('refuses an envelope sealed by anyone but the stream subscriber', async () => {
            // The binding is what makes E2EE input exclusive to the device that
            // is watching. This envelope is perfectly decryptable by this host —
            // only the key it names is not the one that handshook the stream —
            // so nothing but the binding check can refuse it.
            openE2eeStream(await strangerPublicKey());

            handleCommandInput(input({ keys: undefined, encrypted: await seal({ keys: ['down'] }) }), send);
            await pendingInputDecrypts();

            expect(injections()).toEqual([]);
            expect(rejections()).toHaveLength(1);
        });

        it('refuses an undecryptable envelope without taking the daemon down', async () => {
            const subscriberKey = await hostKey();
            openE2eeStream(subscriberKey);

            // Passes the binding check, then fails every way an envelope can:
            // unparseable Base64, valid Base64 that is not ciphertext, and a
            // shape missing fields entirely.
            const garbage = [
                { ciphertext: '!!!', iv: '!!!', encryptedKey: '!!!', keyIv: '!!!', senderPublicKey: subscriberKey },
                { ciphertext: 'AAAA', iv: 'AAAA', encryptedKey: 'AAAA', keyIv: 'AAAA', senderPublicKey: subscriberKey },
                { senderPublicKey: subscriberKey },
            ];
            garbage.forEach((encrypted, i) =>
                handleCommandInput(input({ seq: i + 1, keys: undefined, encrypted }), send));
            await pendingInputDecrypts();

            expect(injections()).toEqual([]);
            expect(rejections()).toHaveLength(3);
        });

        it('refuses an envelope that is not an envelope at all', async () => {
            openE2eeStream(await hostKey());

            // `encrypted` is relay JSON like every other field — a string, an
            // array or a null must be refused, not thrown on.
            for (const [i, encrypted] of ['nope', 42, null, [], { senderPublicKey: 7 }].entries()) {
                handleCommandInput(input({ seq: i + 1, keys: undefined, encrypted }), send);
            }
            await pendingInputDecrypts();

            expect(injections()).toEqual([]);
            expect(rejections()).toHaveLength(5);
        });

        it('applies the whitelist and the caps to the DECRYPTED payload', async () => {
            // The envelope hides the payload from the relay, not from the
            // daemon's own guards — every check the plaintext path runs has to
            // run again on the other side of the decrypt.
            openE2eeStream(await hostKey());

            const payloads = [
                { keys: Array.from({ length: MAX_INPUT_KEYS + 1 }, () => 'down') },
                { keys: ['M-x'] },
                { keys: ['__proto__'] },
                { body: 'x'.repeat(MAX_INPUT_BODY_CHARS + 1) },
                { keys: ['down'], body: 'both' },
                {},
            ];
            for (const [i, payload] of payloads.entries()) {
                handleCommandInput(
                    input({ seq: i + 1, keys: undefined, encrypted: await seal(payload, { seq: i + 1 }) }),
                    send,
                );
            }
            await pendingInputDecrypts();

            expect(injections()).toEqual([]);
            expect(rejections()).toHaveLength(payloads.length);
        });

        it('ignores plaintext keys riding alongside an envelope', async () => {
            // A relay that appends its own `keys` to a real encrypted message
            // must not get them typed. Only the ciphertext decides.
            openE2eeStream(await hostKey());

            handleCommandInput(input({ keys: ['up'], body: undefined, encrypted: await seal({ keys: ['down'] }) }), send);
            await pendingInputDecrypts();

            expect(injections()).toEqual(['-t zeph-a Down']);
        });

        it('refuses input for a stream that was replaced while the decrypt was in flight', async () => {
            // A re-subscribe can swap the subscriber key under an in-flight
            // decrypt; delivering into the new incarnation would type a key the
            // current subscriber never sent.
            openE2eeStream(await hostKey());

            // Both prepared up front: the replacement has to land in the same
            // synchronous run as the send, or the decrypt simply wins the race
            // and the test proves nothing.
            const encrypted = await seal({ keys: ['down'] });
            const newSubscriber = await strangerPublicKey();
            handleCommandInput(input({ keys: undefined, encrypted }), send);
            openE2eeStream(newSubscriber); // restarts the stream under the decrypt
            await pendingInputDecrypts();

            expect(injections()).toEqual([]);
            expect(rejections()).toHaveLength(1);
        });

        it('echoes the refused seq/epoch and sender so the web can fall back', async () => {
            const subscriberKey = await hostKey();
            openE2eeStream(subscriberKey);

            handleCommandInput(
                input({ keys: undefined, deviceId: 'dev-phone', seq: 5, epoch: 42, encrypted: { senderPublicKey: subscriberKey } }),
                send,
            );
            await pendingInputDecrypts();

            expect(rejections()[0]).toMatchObject({
                subtype: 'agent.stream.frame',
                sessionName: 'zeph-a',
                error: 'input_rejected',
                seq: 5,
                epoch: 42,
                inputDeviceId: 'dev-phone',
            });
        });
    });
});
