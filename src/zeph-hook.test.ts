import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

describe('ZephHook.renameAgentSession', () => {
    it('PATCHes the agent-session alias endpoint with the alias body', async () => {
        sequenceResponses([{ ok: true, json: { data: { deviceId: 'dev_listener_abc' } } }]);
        const { ZephHook } = await loadHookModule();
        const hook = new ZephHook({ apiKey: 'ak', baseUrl: 'https://api.example.com/v1' });

        const res = await hook.renameAgentSession('dev_listener_abc', 'zeph-proj', 'Prod deploy');

        expect(res.deviceId).toBe('dev_listener_abc');
        const call = lastCalls.find((c) => c.url.includes('/agent-sessions/'));
        expect(call?.url).toBe('https://api.example.com/v1/devices/dev_listener_abc/agent-sessions/zeph-proj');
        expect(call?.init?.method).toBe('PATCH');
        expect(JSON.parse(call!.init!.body as string)).toEqual({ alias: 'Prod deploy' });
    });
});

// E2E is Pro-only (ADR-0008). A process that initialized crypto while the
// account was Pro only learns about a downgrade when the send is refused with
// 403 PRO_REQUIRED — the push must still go out, as plaintext.
describe('ZephHook.notify — PRO_REQUIRED plaintext fallback', () => {
    const ENV_KEYS = ['HOME', 'XDG_CONFIG_HOME'] as const;
    const savedEnv: Record<string, string | undefined> = {};
    let TMP: string;

    beforeEach(() => {
        for (const key of ENV_KEYS) {
            savedEnv[key] = process.env[key];
            delete process.env[key];
        }
        TMP = mkdtempSync(join(tmpdir(), 'sdk-hook-e2e-'));
        process.env.HOME = TMP;
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
    });

    afterEach(() => {
        rmSync(TMP, { recursive: true, force: true });
        for (const key of ENV_KEYS) {
            if (savedEnv[key] === undefined) delete process.env[key];
            else process.env[key] = savedEnv[key];
        }
        vi.restoreAllMocks();
    });

    /**
     * Boot responses for an encrypted send: the account opt-in, then the
     * device list the message key gets wrapped for. The device public key has
     * to be a real P-256 SPKI — an unusable one makes wrapping fail, and the
     * push would fall back to plaintext before the 403 under test.
     */
    const encryptionEnabledBoot = async () => {
        const kp = await crypto.subtle.generateKey(
            { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey', 'deriveBits'],
        );
        const spki = await crypto.subtle.exportKey('spki', kp.publicKey);
        const publicKey = Buffer.from(new Uint8Array(spki)).toString('base64');
        return [
            { ok: true, json: { data: { encryptionEnabled: true, encryptionKeys: null } } },
            { ok: true, json: { data: [{ deviceId: 'dev_phone', publicKey }] } },
        ];
    };

    const proRequired = {
        ok: false,
        status: 403,
        json: { error: { code: 'PRO_REQUIRED', message: 'End-to-end encryption requires Zeph Pro', status: 403 } },
    };

    it('resends the plaintext payload after an encrypted send is refused', async () => {
        sequenceResponses([
            ...(await encryptionEnabledBoot()),
            proRequired,
            { ok: true, json: { data: { pushId: 'push_plain_01' } } },
        ]);
        const { ZephHook } = await loadHookModule();
        const hook = new ZephHook({ apiKey: 'ak_test', baseUrl: 'https://api.example.com/v1' });

        const result = await hook.notify({ title: 'Build done', body: 'all green' });

        expect(result.pushId).toBe('push_plain_01');
        const sends = lastCalls.filter((c) => c.url.endsWith('/pushes/send'));
        expect(sends).toHaveLength(2);
        expect(JSON.parse(sends[0].init!.body as string).isEncrypted).toBe(true);
        const retried = JSON.parse(sends[1].init!.body as string);
        expect(retried.isEncrypted).toBeUndefined();
        expect(retried.title).toBe('Build done');
        expect(retried.body).toBe('all green');
    });

    it('re-uploads the file as plaintext on the long-body path', async () => {
        sequenceResponses([
            ...(await encryptionEnabledBoot()),
            { ok: true, json: { data: { fileId: 'f1', fileKey: 'fk_enc', uploadUrl: 'https://s3.example.com/put/enc' } } },
            { ok: true, status: 200, json: {} },
            proRequired,
            { ok: true, json: { data: { fileId: 'f2', fileKey: 'fk_plain', uploadUrl: 'https://s3.example.com/put/plain' } } },
            { ok: true, status: 200, json: {} },
            { ok: true, json: { data: { pushId: 'push_plain_02' } } },
        ]);
        const { ZephHook } = await loadHookModule();
        const hook = new ZephHook({ apiKey: 'ak_test', baseUrl: 'https://api.example.com/v1' });
        const longBody = 'x'.repeat(1000);

        const result = await hook.notify({ title: 'big report', body: longBody });

        expect(result.fileKey).toBe('fk_plain');
        expect(lastCalls.filter((c) => c.url.endsWith('/files/upload-request'))).toHaveLength(2);
        const uploads = lastCalls.filter((c) => c.url.startsWith('https://s3.example.com/'));
        expect(uploads).toHaveLength(2);
        expect(uploads[1].init!.body).toBe(longBody);
        const sends = lastCalls.filter((c) => c.url.endsWith('/pushes/send'));
        const retried = JSON.parse(sends[1].init!.body as string);
        expect(retried.isEncrypted).toBeUndefined();
        expect(retried.files[0].iv).toBeUndefined();
        expect(retried.files[0].deviceKeyMap).toBeUndefined();
    });

    // ── The encrypted shape itself ────────────────────────────────
    it('wraps the message key per device and strips the plaintext title and url', async () => {
        sequenceResponses([
            ...(await encryptionEnabledBoot()),
            { ok: true, json: { data: { pushId: 'push_enc_01' } } },
        ]);
        const { ZephHook } = await loadHookModule();
        const hook = new ZephHook({ apiKey: 'ak_test', baseUrl: 'https://api.example.com/v1' });

        await hook.notify({ title: 'Deploy done', body: 'prod is live', url: 'https://secret.example.com/build/42' });

        const sent = JSON.parse(lastCalls.find((c) => c.url.endsWith('/pushes/send'))!.init!.body as string);
        expect(sent.isEncrypted).toBe(true);
        expect(sent.senderPublicKey).toBeTruthy();
        expect(Object.keys(sent.deviceKeyMap)).toEqual(['dev_phone']);
        expect(JSON.parse(sent.deviceKeyMap.dev_phone)).toEqual({
            encryptedKey: expect.any(String), keyIv: expect.any(String),
        });
        // The url is sealed inside the ciphertext; a plaintext copy at the top
        // level would hand the server the one thing isEncrypted promises it
        // cannot see — and on a link push the url IS the payload.
        expect(sent.title).toBeUndefined();
        expect(sent.url).toBeUndefined();
        expect(sent.body).not.toContain('secret.example.com');
    });

    it('keeps the url in the clear when the push is not encrypted', async () => {
        sequenceResponses([
            { ok: true, json: { data: { encryptionEnabled: false, encryptionKeys: null } } },
            { ok: true, json: { data: { pushId: 'push_plain_03' } } },
        ]);
        const { ZephHook } = await loadHookModule();
        const hook = new ZephHook({ apiKey: 'ak_test', baseUrl: 'https://api.example.com/v1' });

        await hook.notify({ title: 'Link', url: 'https://example.com/x' });

        const sent = JSON.parse(lastCalls.find((c) => c.url.endsWith('/pushes/send'))!.init!.body as string);
        expect(sent.isEncrypted).toBeUndefined();
        expect(sent.url).toBe('https://example.com/x');
    });

    // ── Fallbacks that are not PRO_REQUIRED ───────────────────────
    it('sends plaintext when no device has a per-device public key', async () => {
        sequenceResponses([
            { ok: true, json: { data: { encryptionEnabled: true, encryptionKeys: null } } },
            { ok: true, json: { data: [{ deviceId: 'dev_old' }] } },
            { ok: true, json: { data: { pushId: 'push_plain_04' } } },
        ]);
        const { ZephHook } = await loadHookModule();
        const hook = new ZephHook({ apiKey: 'ak_test', baseUrl: 'https://api.example.com/v1' });

        await hook.notify({ title: 'Build done', body: 'all green' });

        // Ciphertext nobody holds a key for is worse than a readable push.
        const sent = JSON.parse(lastCalls.find((c) => c.url.endsWith('/pushes/send'))!.init!.body as string);
        expect(sent.isEncrypted).toBeUndefined();
        expect(sent.body).toBe('all green');
    });

    it('sends plaintext when the device list cannot be fetched', async () => {
        sequenceResponses([
            { ok: true, json: { data: { encryptionEnabled: true, encryptionKeys: null } } },
            { ok: false, status: 500, json: { error: { code: 'ERROR', message: 'boom', status: 500 } } },
            { ok: true, json: { data: { pushId: 'push_plain_05' } } },
        ]);
        const { ZephHook } = await loadHookModule();
        const hook = new ZephHook({ apiKey: 'ak_test', baseUrl: 'https://api.example.com/v1' });

        await hook.notify({ title: 'Build done', body: 'all green' });

        const sent = JSON.parse(lastCalls.find((c) => c.url.endsWith('/pushes/send'))!.init!.body as string);
        expect(sent.isEncrypted).toBeUndefined();
        expect(sent.body).toBe('all green');
    });

    it('propagates a second PRO_REQUIRED instead of looping', async () => {
        sequenceResponses([...(await encryptionEnabledBoot()), proRequired, proRequired]);
        const { ZephHook, ZephError } = await loadHookModule();
        const hook = new ZephHook({ apiKey: 'ak_test', baseUrl: 'https://api.example.com/v1' });

        try {
            await hook.notify({ title: 'x' });
            expect.fail('should have thrown');
        } catch (err) {
            expect(err).toBeInstanceOf(ZephError);
            expect((err as InstanceType<typeof ZephError>).code).toBe('PRO_REQUIRED');
        }
        expect(lastCalls.filter((c) => c.url.endsWith('/pushes/send'))).toHaveLength(2);
    });
});
