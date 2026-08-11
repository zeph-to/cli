import { describe, expect, it, vi } from 'vitest';
import { parseActions, requestApproval, type AskDeps } from './ask.js';

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
