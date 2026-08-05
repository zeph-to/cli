import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

// tmux is faked wholesale (as in listener-stream-lease.test.ts): what is under
// test is the ephemeral input path's guards and ordering, not tmux itself.
// `zeph-shell` reports a shell as its pane command — the RCE guard's subject.
const FIELD_SEP = '␟';
const SESSIONS = ['zeph-a', 'zeph-shell', 'zeph-rate'];

/** Every tmux call the code made, in order — the injection evidence. */
let tmuxCalls: string[][] = [];

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
    const rejections = () => sent.filter((f) => f.error === 'input_rejected');

    it('injects whitelisted keys into a session with a live stream', () => {
        openStream('zeph-a');
        expect(handleCommandInput(input(), send)).toBe(true);
        expect(injections()).toEqual(['-t zeph-a Down']);
        expect(rejections()).toEqual([]);
    });

    it('injects literal text with -l so tmux cannot read it as commands', () => {
        openStream('zeph-a');
        handleCommandInput(input({ keys: undefined, body: 'hello; rm -rf /' }), send);
        expect(injections()).toEqual(['-l -t zeph-a hello; rm -rf /', '-t zeph-a Enter']);
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

    it('refuses an encrypted payload while E2EE is unimplemented', () => {
        // Fail closed: injecting the plaintext that rode alongside would leave
        // a sender believing its input was protected when it was not.
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
        expect(injections()).toHaveLength(2); // text + Enter
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
        // Fail closed until the daemon can decrypt the inbound envelope.
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
});
