import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleAsk, parseActions, remoteTransition, requestApproval, type AskDeps } from './ask.js';
import { isRemoteActive, touchRemoteActive } from './gate.js';

// handleAsk reads the saved login for its base URL; keep the developer's
// ~/.zeph/config.json out of the tests.
vi.mock('./config.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('./config.js')>()),
    loadConfig: () => ({}),
}));

const OPTS = {
    apiKey: 'k',
    baseUrl: 'https://api.example/v1',
    hookId: 'hook_1',
    title: 'Run rm -rf ./dist?',
    timeoutSeconds: 30,
    actions: [{ id: 'approve', label: 'Approve' }, { id: 'deny', label: 'Deny' }],
};

/** A fetch stub that answers trigger once, then walks a scripted poll list. */
const stubFetch = (pollBodies: unknown[]) => {
    const calls: Array<{ url: string; method: string; body?: unknown }> = [];
    let poll = 0;
    const fetchFn = (async (url: string, init?: RequestInit) => {
        calls.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined });
        if (url.endsWith('/trigger')) {
            return { ok: true, status: 200, json: async () => ({ data: { eventId: 'evt_1' } }) } as unknown as Response;
        }
        const body = pollBodies[Math.min(poll, pollBodies.length - 1)];
        poll += 1;
        return { ok: true, status: 200, json: async () => body } as unknown as Response;
    }) as unknown as typeof fetch;
    return { fetchFn, calls };
};

const deps = (fetchFn: typeof fetch, clock = { t: 0 }): AskDeps => ({
    fetchFn,
    now: () => clock.t,
    // Time only moves when the code waits, so a poll loop cannot spin forever
    // in a test and a timeout is reached deterministically rather than by
    // wall-clock luck.
    sleep: async (ms: number) => { clock.t += ms; },
});

describe('parseActions', () => {
    it('reads id:Label pairs', () => {
        expect(parseActions('approve:Approve,deny:Deny')).toEqual([
            { id: 'approve', label: 'Approve' },
            { id: 'deny', label: 'Deny' },
        ]);
    });

    it('uses the id as the label when only an id is given', () => {
        expect(parseActions('ok')).toEqual([{ id: 'ok', label: 'ok' }]);
    });

    it('keeps colons inside a label', () => {
        expect(parseActions('go:Deploy: prod')).toEqual([{ id: 'go', label: 'Deploy: prod' }]);
    });

    it('drops empty segments rather than sending a blank button', () => {
        expect(parseActions('a:A,,b:B,')).toEqual([{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }]);
    });

    it('returns an empty list for an empty spec', () => {
        expect(parseActions('')).toEqual([]);
        expect(parseActions(undefined)).toEqual([]);
    });
});

describe('requestApproval', () => {
    it('returns the tapped action', async () => {
        const { fetchFn, calls } = stubFetch([{ data: { response: { actionId: 'approve' } } }]);
        const result = await requestApproval(OPTS, deps(fetchFn));
        expect(result).toEqual({ answered: true, actionId: 'approve' });
        expect(calls[0].url).toBe('https://api.example/v1/hooks/hook_1/trigger');
        expect(calls[0].method).toBe('POST');
    });

    it('returns free text when the user typed instead of tapping', async () => {
        const { fetchFn } = stubFetch([{ data: { response: { value: 'not now' } } }]);
        const result = await requestApproval(OPTS, deps(fetchFn));
        expect(result).toEqual({ answered: true, value: 'not now' });
    });

    it('keeps polling until an answer arrives', async () => {
        const { fetchFn, calls } = stubFetch([
            { data: { response: null } },
            { data: { response: null } },
            { data: { response: { actionId: 'deny' } } },
        ]);
        const result = await requestApproval(OPTS, deps(fetchFn));
        expect(result).toEqual({ answered: true, actionId: 'deny' });
        // 1 trigger + 3 polls
        expect(calls).toHaveLength(4);
    });

    it('gives up at the deadline instead of polling forever', async () => {
        const { fetchFn, calls } = stubFetch([{ data: { response: null } }]);
        const result = await requestApproval({ ...OPTS, timeoutSeconds: 5 }, deps(fetchFn));
        expect(result).toEqual({ answered: false });
        // The exact count depends on the interval; what matters is that it stopped.
        expect(calls.length).toBeLessThan(20);
    });

    it('sends the question, the buttons and the timeout to the hook', async () => {
        const { fetchFn, calls } = stubFetch([{ data: { response: { actionId: 'approve' } } }]);
        await requestApproval({ ...OPTS, body: 'in /repo' }, deps(fetchFn));
        expect(calls[0].body).toMatchObject({
            title: 'Run rm -rf ./dist?',
            body: 'in /repo',
            timeout: 30,
            actions: [{ id: 'approve', label: 'Approve' }, { id: 'deny', label: 'Deny' }],
        });
    });

    it('reports a transport failure as unanswered rather than throwing', async () => {
        // A hook calling this needs one shape back, always: an approval gate
        // that throws is an approval gate that stops being a gate.
        const fetchFn = (async () => { throw new Error('offline'); }) as unknown as typeof fetch;
        const result = await requestApproval(OPTS, deps(fetchFn));
        expect(result).toEqual({ answered: false, error: 'offline' });
    });

    it('reports an API error as unanswered', async () => {
        const fetchFn = (async () => ({
            ok: false, status: 401, json: async () => ({ error: { message: 'bad key' } }),
        })) as unknown as typeof fetch;
        const result = await requestApproval(OPTS, deps(fetchFn));
        expect(result).toEqual({ answered: false, error: 'bad key' });
    });

    it('survives a poll that fails midway and keeps waiting', async () => {
        let call = 0;
        const fetchFn = (async (url: string) => {
            call += 1;
            if (url.endsWith('/trigger')) {
                return { ok: true, status: 200, json: async () => ({ data: { eventId: 'e' } }) } as unknown as Response;
            }
            if (call === 2) throw new Error('flaky');
            return { ok: true, status: 200, json: async () => ({ data: { response: { actionId: 'approve' } } }) } as unknown as Response;
        }) as unknown as typeof fetch;
        const result = await requestApproval(OPTS, deps(fetchFn));
        expect(result).toEqual({ answered: true, actionId: 'approve' });
    });

    it('does not wait past the deadline just because a poll is slow to be scheduled', async () => {
        const clock = { t: 0 };
        const { fetchFn } = stubFetch([{ data: { response: null } }]);
        const spy = vi.fn(async (ms: number) => { clock.t += ms; });
        await requestApproval({ ...OPTS, timeoutSeconds: 2 }, { fetchFn, now: () => clock.t, sleep: spy });
        expect(clock.t).toBeLessThanOrEqual(2000 + 1000);
    });
});

describe('send and exit', () => {
    const SENT = { data: { response: { value: 'ship it', exitRemote: true } } };

    it('offers the button only on an ask that sets acceptsExit', async () => {
        const offered = stubFetch([SENT]);
        await requestApproval({ ...OPTS, acceptsExit: true }, deps(offered.fetchFn));
        expect(offered.calls[0].body).toMatchObject({ acceptsExit: true });

        const gate = stubFetch([SENT]);
        await requestApproval(OPTS, deps(gate.fetchFn));
        expect(gate.calls[0].body).not.toHaveProperty('acceptsExit');
    });

    it('marks the answer as send-and-exit only when the ask offered it', async () => {
        const offered = stubFetch([SENT]);
        expect(await requestApproval({ ...OPTS, acceptsExit: true }, deps(offered.fetchFn)))
            .toEqual({ answered: true, value: 'ship it', exitRemote: true });

        // An approval gate has no mode to end, whatever the phone sent.
        const gate = stubFetch([SENT]);
        expect(await requestApproval(OPTS, deps(gate.fetchFn)))
            .toEqual({ answered: true, value: 'ship it' });
    });

    it('does not read plain text on an offering ask as an exit', async () => {
        const { fetchFn } = stubFetch([{ data: { response: { value: 'run the tests' } } }]);
        expect(await requestApproval({ ...OPTS, acceptsExit: true }, deps(fetchFn)))
            .toEqual({ answered: true, value: 'run the tests' });
    });

    it('takes an exit with no text as an answer instead of waiting out the deadline', async () => {
        const { fetchFn, calls } = stubFetch([{ data: { response: { exitRemote: true } } }]);
        expect(await requestApproval({ ...OPTS, acceptsExit: true }, deps(fetchFn)))
            .toEqual({ answered: true, value: '', exitRemote: true });
        expect(calls).toHaveLength(2);
    });
});

describe('remoteTransition — mcp-server remoteTransitionFor', () => {
    it.each(['done', 'Done', 'STOP', ' exit '])('ends REMOTE on the Done-like button %j', (id) => {
        expect(remoteTransition({ answered: true, actionId: id })).toBe('exit');
    });

    it('ends REMOTE on a send-and-exit answer', () => {
        expect(remoteTransition({ answered: true, value: 'ship it', exitRemote: true })).toBe('exit');
    });

    it('enters REMOTE on any other answer', () => {
        expect(remoteTransition({ answered: true, actionId: 'review' })).toBe('enter');
        expect(remoteTransition({ answered: true, value: 'redo it' })).toBe('enter');
    });

    it('leaves the mode alone when nobody answered', () => {
        expect(remoteTransition({ answered: false })).toBe('keep');
        expect(remoteTransition({ answered: false, error: 'HTTP 500' })).toBe('keep');
    });
});

describe('zeph ask --accepts-exit', () => {
    let dir: string;
    let out: string[];
    const answer = (response: { actionId?: string; value?: string; exitRemote?: boolean }) =>
        vi.stubGlobal('fetch', stubFetch([{ data: { response } }]).fetchFn);
    const printed = () => JSON.parse(out.join(''));

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'zeph-ask-'));
        vi.stubEnv('XDG_STATE_HOME', join(dir, 'state'));
        vi.stubEnv('TMUX', '');
        vi.stubEnv('ZEPH_API_KEY', 'k');
        vi.stubEnv('ZEPH_HOOK_ID', 'hook_1');
        vi.spyOn(process, 'cwd').mockReturnValue(dir);
        out = [];
        vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
            out.push(String(chunk));
            return true;
        });
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
        vi.unstubAllGlobals();
        rmSync(dir, { recursive: true, force: true });
    });

    const ASK = { title: 'next?', actions: 'review:Review,done:Done', timeout: '5', 'accepts-exit': true } as const;

    it('ends REMOTE and prints the final instruction with zephState NORMAL', async () => {
        touchRemoteActive(dir);
        answer({ value: 'ship it', exitRemote: true });
        expect(await handleAsk(ASK)).toBe(0);
        expect(printed()).toEqual({ answered: true, value: 'ship it', zephState: 'NORMAL' });
        expect(isRemoteActive(dir)).toBe(false);
    });

    it('ends REMOTE on a Done-like button', async () => {
        touchRemoteActive(dir);
        answer({ actionId: 'done' });
        await handleAsk(ASK);
        expect(printed()).toEqual({ answered: true, actionId: 'done', zephState: 'NORMAL' });
        expect(isRemoteActive(dir)).toBe(false);
    });

    it('enters REMOTE on plain text, like any other answer', async () => {
        answer({ value: 'run the tests' });
        await handleAsk(ASK);
        expect(printed()).toEqual({ answered: true, value: 'run the tests', zephState: 'REMOTE' });
        expect(isRemoteActive(dir)).toBe(true);
    });

    it('leaves REMOTE alone and names no state when nobody answered', async () => {
        touchRemoteActive(dir);
        vi.stubGlobal('fetch', (async () => { throw new Error('offline'); }) as unknown as typeof fetch);
        expect(await handleAsk(ASK)).toBe(1);
        expect(printed()).toEqual({ answered: false, error: 'offline' });
        expect(isRemoteActive(dir)).toBe(true);
    });

    it('leaves REMOTE alone and names no state on an ask without the flag', async () => {
        touchRemoteActive(dir);
        answer({ value: 'ship it', exitRemote: true });
        await handleAsk({ title: 'next?', actions: 'done:Done', timeout: '5' });
        expect(printed()).toEqual({ answered: true, value: 'ship it' });
        expect(isRemoteActive(dir)).toBe(true);

        out = [];
        answer({ actionId: 'done' });
        await handleAsk({ title: 'Run rm -rf ./dist?', actions: 'done:Done', timeout: '5' });
        expect(printed()).toEqual({ answered: true, actionId: 'done' });
        expect(isRemoteActive(dir)).toBe(true);
    });
});
