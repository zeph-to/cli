import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ZephHook.notify branches by payload size:
//   - body ≤ 512 bytes → POST /pushes/send with the full body inline
//   - body > 512 bytes → request upload URL, PUT to S3, then send the push
//                        with a 200-char preview body + a file attachment
//
// Crypto module has module-scope state (initPromise + cachedKeyPair) so we
// dynamic-import everything inside each test, after vi.resetModules(), to
// guarantee a fresh graph. The errors module also has to come from the
// same fresh graph for instanceof checks to succeed.

type FetchMock = ReturnType<typeof vi.fn>;
let fetchMock: FetchMock;
let lastCalls: Array<{ url: string; init: RequestInit | undefined }>;

const sequenceResponses = (responses: Array<{ ok: boolean; status?: number; json?: unknown }>) => {
    let i = 0;
    fetchMock.mockImplementation(async (url: unknown, init: unknown) => {
        lastCalls.push({ url: String(url), init: init as RequestInit | undefined });
        const r = responses[Math.min(i++, responses.length - 1)];
        return {
            ok: r.ok,
            status: r.status ?? (r.ok ? 200 : 500),
            json: async () => r.json,
        } as unknown as Response;
    });
};

// Server says "encryption disabled" — keeps crypto out of the way of the
// HTTP shape assertions. ZephHook.notify still calls ensureCrypto once.
const noEncryptionResponse = {
    ok: true,
    json: { data: { encryptionEnabled: false, encryptionKeys: null } },
};

const loadHookModule = async () => {
    vi.resetModules();
    const mod = await import('./zeph-hook.js');
    const errors = await import('./errors.js');
    return { ZephHook: mod.ZephHook, ...errors };
};

beforeEach(() => {
    lastCalls = [];
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('ZephHook.notify — short body (inline)', () => {
    it('sends a single POST /pushes/send with title + body', async () => {
        sequenceResponses([
            noEncryptionResponse,
            { ok: true, json: { data: { pushId: 'push_short_01' } } },
        ]);
        const { ZephHook } = await loadHookModule();
        const hook = new ZephHook({ apiKey: 'ak_test', baseUrl: 'https://api.example.com/v1' });
        const result = await hook.notify({ title: 'Build done', body: 'all green' });
        expect(result.pushId).toBe('push_short_01');
        const pushCall = lastCalls.find((c) => c.url.endsWith('/pushes/send'));
        expect(pushCall).toBeDefined();
        const sent = JSON.parse(pushCall!.init!.body as string);
        expect(sent.title).toBe('Build done');
        expect(sent.body).toBe('all green');
    });

    it('throws if server returns no pushId', async () => {
        sequenceResponses([
            noEncryptionResponse,
            { ok: true, json: { data: {} } },
        ]);
        const { ZephHook } = await loadHookModule();
        const hook = new ZephHook({ apiKey: 'ak_test', baseUrl: 'https://api.example.com/v1' });
        await expect(hook.notify({ title: 'oops' })).rejects.toThrow(/no pushId/);
    });
});

describe('ZephHook.notify — long body (file upload path)', () => {
    it('requests upload URL, PUTs to S3, then sends a push with preview + file metadata', async () => {
        const longBody = 'x'.repeat(1000);
        sequenceResponses([
            noEncryptionResponse,
            { ok: true, json: { data: { fileId: 'f1', fileKey: 'fk1', uploadUrl: 'https://s3.example.com/put/abc' } } },
            { ok: true, status: 200, json: {} },
            { ok: true, json: { data: { pushId: 'push_long_01' } } },
        ]);

        const { ZephHook } = await loadHookModule();
        const hook = new ZephHook({ apiKey: 'ak_test', baseUrl: 'https://api.example.com/v1' });
        const result = await hook.notify({ title: 'big report', body: longBody });

        expect(result.pushId).toBe('push_long_01');
        expect(result.fileKey).toBe('fk1');
        expect(result.autoFile).toBe(true);

        const upload = lastCalls.find((c) => c.url.endsWith('/files/upload-request'));
        const s3 = lastCalls.find((c) => c.url.startsWith('https://s3.example.com/'));
        const push = lastCalls.find((c) => c.url.endsWith('/pushes/send'));
        expect(upload).toBeDefined();
        expect(s3).toBeDefined();
        expect(push).toBeDefined();
        expect(s3!.init!.method).toBe('PUT');
        const pushBody = JSON.parse(push!.init!.body as string);
        expect((pushBody.body as string).length).toBeLessThanOrEqual(204);
        expect(pushBody.files).toHaveLength(1);
        expect(pushBody.files[0].fileKey).toBe('fk1');
    });

    it('propagates S3 upload failures', async () => {
        const longBody = 'x'.repeat(1000);
        sequenceResponses([
            noEncryptionResponse,
            { ok: true, json: { data: { fileId: 'f1', fileKey: 'fk1', uploadUrl: 'https://s3.example.com/put/abc' } } },
            { ok: false, status: 503, json: { error: 'unavailable' } },
        ]);

        const { ZephHook } = await loadHookModule();
        const hook = new ZephHook({ apiKey: 'ak_test', baseUrl: 'https://api.example.com/v1' });
        await expect(hook.notify({ title: 'big', body: longBody }))
            .rejects.toThrow(/S3 upload failed/);
    });
});

describe('ZephHook.request — error mapping', () => {
    it('401 → AuthenticationError', async () => {
        sequenceResponses([
            noEncryptionResponse,
            { ok: false, status: 401, json: { error: { code: 'UNAUTHORIZED', message: 'bad key', status: 401 } } },
        ]);
        const { ZephHook, AuthenticationError } = await loadHookModule();
        const hook = new ZephHook({ apiKey: 'ak_test', baseUrl: 'https://api.example.com/v1' });
        await expect(hook.notify({ title: 'x' })).rejects.toBeInstanceOf(AuthenticationError);
    });

    it('403 + QUOTA_EXCEEDED → QuotaExceededError', async () => {
        sequenceResponses([
            noEncryptionResponse,
            { ok: false, status: 403, json: { error: { code: 'QUOTA_EXCEEDED', message: 'over limit', status: 403 } } },
        ]);
        const { ZephHook, QuotaExceededError } = await loadHookModule();
        const hook = new ZephHook({ apiKey: 'ak_test', baseUrl: 'https://api.example.com/v1' });
        await expect(hook.notify({ title: 'x' })).rejects.toBeInstanceOf(QuotaExceededError);
    });

    it('other 4xx → generic ZephError carrying code + status', async () => {
        sequenceResponses([
            noEncryptionResponse,
            { ok: false, status: 400, json: { error: { code: 'BAD_REQUEST', message: 'bad', status: 400 } } },
        ]);
        const { ZephHook, ZephError } = await loadHookModule();
        const hook = new ZephHook({ apiKey: 'ak_test', baseUrl: 'https://api.example.com/v1' });
        try {
            await hook.notify({ title: 'x' });
            expect.fail('should have thrown');
        } catch (err) {
            expect(err).toBeInstanceOf(ZephError);
            expect((err as InstanceType<typeof ZephError>).code).toBe('BAD_REQUEST');
            expect((err as InstanceType<typeof ZephError>).status).toBe(400);
        }
    });
});

describe('ZephHook constructor', () => {
    it('rejects empty apiKey', async () => {
        const { ZephHook } = await loadHookModule();
        expect(() => new ZephHook({ apiKey: '' })).toThrow(/apiKey is required/);
    });

    it('strips trailing slash from baseUrl', async () => {
        const { ZephHook } = await loadHookModule();
        const hook = new ZephHook({ apiKey: 'ak', baseUrl: 'https://api.example.com/v1/' });
        expect((hook as unknown as { baseUrl: string }).baseUrl).toBe('https://api.example.com/v1');
    });
});

describe('ZephHook.list', () => {
    it('passes through limit + type to /pushes', async () => {
        // No crypto step for list — only one fetch expected
        sequenceResponses([
            { ok: true, json: { data: [{ pushId: 'p1', type: 'hook', createdAt: '2026-01-01T00:00:00Z' }], pagination: { hasMore: false } } },
        ]);
        const { ZephHook } = await loadHookModule();
        const hook = new ZephHook({ apiKey: 'ak', baseUrl: 'https://api.example.com/v1' });
        const result = await hook.list({ limit: 10, type: 'hook' });
        expect(result.pushes).toHaveLength(1);
        expect(result.hasMore).toBe(false);
        const listCall = lastCalls.find((c) => c.url.includes('/pushes?'));
        expect(listCall?.url).toContain('limit=10');
        expect(listCall?.url).toContain('type=hook');
    });
});

describe('ZephHook.dismiss', () => {
    it('encodes the push id and POSTs to /pushes/<id>/dismiss', async () => {
        sequenceResponses([
            { ok: true, json: { data: { dismissed: true } } },
        ]);
        const { ZephHook } = await loadHookModule();
        const hook = new ZephHook({ apiKey: 'ak', baseUrl: 'https://api.example.com/v1' });
        const result = await hook.dismiss('push_01:weird/id');
        expect(result.dismissed).toBe(true);
        const dismissCall = lastCalls.find((c) => c.url.includes('/dismiss'));
        expect(dismissCall?.url).toContain('push_01%3Aweird%2Fid');
    });
});
