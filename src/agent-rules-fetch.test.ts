import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// HOME-swap + resetModules pattern (see crypto.test.ts): the module
// computes its cache path from CONFIG_DIR at import time, so each test
// re-imports it under a throwaway HOME.

const ENV_KEYS = ['HOME', 'ZEPH_AGENT_RULES_URL', 'ZEPH_BASE_URL'] as const;
const originalEnv: Record<string, string | undefined> = {};
for (const key of ENV_KEYS) originalEnv[key] = process.env[key];
let TMP: string;

beforeEach(() => {
    TMP = mkdtempSync(join(tmpdir(), 'agent-rules-test-'));
    for (const key of ENV_KEYS) delete process.env[key];
    process.env.HOME = TMP;
    vi.resetModules();
});

afterEach(() => {
    rmSync(TMP, { recursive: true, force: true });
    for (const key of ENV_KEYS) {
        if (originalEnv[key] === undefined) delete process.env[key];
        else process.env[key] = originalEnv[key];
    }
});

const importModule = async () => await import('./agent-rules-fetch.js');

const VALID_MANIFEST = {
    engineVersion: 1,
    version: '2026.08.01.1',
    agents: {
        claude: [
            { id: 'r1', state: 'working', priority: 100, contains: ['busy'] },
        ],
    },
};

const okResponse = (body: unknown, etag?: string) => ({
    ok: true,
    status: 200,
    headers: { get: (k: string) => (k.toLowerCase() === 'etag' ? etag ?? null : null) },
    text: async () => JSON.stringify(body),
}) as unknown as Response;

describe('validateManifest', () => {
    it('accepts a well-formed manifest', async () => {
        const m = await importModule();
        expect(m.validateManifest(VALID_MANIFEST)).not.toBeNull();
    });

    it.each([
        ['wrong engine version', { ...VALID_MANIFEST, engineVersion: 99 }],
        ['missing version', { ...VALID_MANIFEST, version: '' }],
        ['non-array rules', { ...VALID_MANIFEST, agents: { claude: 'nope' } }],
        ['bad rule state', { ...VALID_MANIFEST, agents: { claude: [{ id: 'x', state: 'busy', priority: 1 }] } }],
        ['rule without id', { ...VALID_MANIFEST, agents: { claude: [{ state: 'idle', priority: 1 }] } }],
        ['tailLines out of range', { ...VALID_MANIFEST, agents: { claude: [{ id: 'x', state: 'idle', priority: 1, tailLines: 999 }] } }],
        ['non-object', 'not a manifest'],
        ['null', null],
    ])('rejects %s', async (_name, bad) => {
        const m = await importModule();
        expect(m.validateManifest(bad)).toBeNull();
    });
});

describe('refreshManifest', () => {
    it('activates and caches a fetched manifest', async () => {
        const m = await importModule();
        const fetchMock = vi.fn(async () => okResponse(VALID_MANIFEST, 'W/"abc"'));
        const r = await m.refreshManifest(fetchMock as unknown as typeof fetch);
        expect(r.outcome).toBe('updated');
        expect(r.source).toBe('remote');
        expect(m.getActiveManifest().version).toBe('2026.08.01.1');
        const cached = JSON.parse(readFileSync(join(TMP, '.zeph', 'agent-rules.json'), 'utf-8'));
        expect(cached.etag).toBe('W/"abc"');
        expect(cached.manifest.version).toBe('2026.08.01.1');
    });

    it('sends If-None-Match from the cache and keeps state on 304', async () => {
        const m = await importModule();
        await m.refreshManifest(vi.fn(async () => okResponse(VALID_MANIFEST, 'W/"abc"')) as unknown as typeof fetch);
        const fetch304 = vi.fn(async (_url: string, init: RequestInit) => {
            expect((init.headers as Record<string, string>)['If-None-Match']).toBe('W/"abc"');
            return { ok: false, status: 304, headers: { get: () => null }, text: async () => '' } as unknown as Response;
        });
        const r = await m.refreshManifest(fetch304 as unknown as typeof fetch);
        expect(r.outcome).toBe('not-modified');
        expect(m.getActiveManifest().version).toBe('2026.08.01.1');
    });

    it('keeps the active manifest on an invalid payload', async () => {
        const m = await importModule();
        const before = m.getActiveManifest().version;
        const r = await m.refreshManifest(vi.fn(async () => okResponse({ engineVersion: 99 })) as unknown as typeof fetch);
        expect(r.outcome).toBe('invalid');
        expect(m.getActiveManifest().version).toBe(before);
        expect(m.getActiveManifestSource()).toBe('bundled');
    });

    it('keeps the active manifest on a network error', async () => {
        const m = await importModule();
        const r = await m.refreshManifest(vi.fn(async () => { throw new Error('offline'); }) as unknown as typeof fetch);
        expect(r.outcome).toBe('error');
        expect(m.getActiveManifestSource()).toBe('bundled');
    });

    it('rejects an oversized body without activating it', async () => {
        const m = await importModule();
        const huge = { ...VALID_MANIFEST, padding: 'x'.repeat(300 * 1024) };
        const r = await m.refreshManifest(vi.fn(async () => okResponse(huge)) as unknown as typeof fetch);
        expect(r.outcome).toBe('invalid');
        expect(existsSync(join(TMP, '.zeph', 'agent-rules.json'))).toBe(false);
    });

    it('honors ZEPH_AGENT_RULES_URL', async () => {
        process.env.ZEPH_AGENT_RULES_URL = 'https://example.test/rules.json';
        vi.resetModules();
        const m = await importModule();
        const fetchMock = vi.fn(async (url: string) => {
            expect(url).toBe('https://example.test/rules.json');
            return okResponse(VALID_MANIFEST);
        });
        await m.refreshManifest(fetchMock as unknown as typeof fetch);
        expect(fetchMock).toHaveBeenCalledOnce();
    });
});

describe('loadManifestFromCache', () => {
    it('promotes a valid disk cache at startup', async () => {
        mkdirSync(join(TMP, '.zeph'), { recursive: true });
        writeFileSync(join(TMP, '.zeph', 'agent-rules.json'),
            JSON.stringify({ etag: 'W/"x"', manifest: VALID_MANIFEST }));
        const m = await importModule();
        expect(m.loadManifestFromCache()).toBe('cache');
        expect(m.getActiveManifest().version).toBe('2026.08.01.1');
    });

    it('falls back to bundled on a corrupt cache', async () => {
        mkdirSync(join(TMP, '.zeph'), { recursive: true });
        writeFileSync(join(TMP, '.zeph', 'agent-rules.json'), '{broken json');
        const m = await importModule();
        expect(m.loadManifestFromCache()).toBe('bundled');
    });

    it('falls back to bundled when the cached manifest fails validation', async () => {
        mkdirSync(join(TMP, '.zeph'), { recursive: true });
        writeFileSync(join(TMP, '.zeph', 'agent-rules.json'),
            JSON.stringify({ manifest: { ...VALID_MANIFEST, engineVersion: 99 } }));
        const m = await importModule();
        expect(m.loadManifestFromCache()).toBe('bundled');
    });
});

describe('version precedence (bundled vs OTA)', () => {
    // npm publishes land minutes after merge; the server manifest waits
    // for a full deploy. In that window the endpoint serves OLDER rules
    // than the bundled ones — they must not shadow the fresh build.
    const STALE_MANIFEST = { ...VALID_MANIFEST, version: '2020.01.01.1' };

    it('compareManifestVersions orders numerically per segment', async () => {
        const m = await importModule();
        expect(m.compareManifestVersions('2026.07.04.3', '2026.07.04.2')).toBe(1);
        expect(m.compareManifestVersions('2026.07.04.9', '2026.07.04.10')).toBe(-1);
        expect(m.compareManifestVersions('2026.07.04', '2026.07.04.1')).toBe(-1);
        expect(m.compareManifestVersions('2026.07.04.3', '2026.07.04.3')).toBe(0);
        expect(m.compareManifestVersions('abc', 'def')).toBe(0); // malformed → equal, never throws
    });

    it('refreshManifest ignores a remote manifest older than bundled (still caches for ETag)', async () => {
        const m = await importModule();
        const bundled = m.getActiveManifest().version;
        const r = await m.refreshManifest(vi.fn(async () => okResponse(STALE_MANIFEST, 'W/"old"')) as unknown as typeof fetch);
        expect(r.outcome).toBe('stale-ignored');
        expect(r.version).toBe('2020.01.01.1');
        expect(m.getActiveManifest().version).toBe(bundled);
        expect(m.getActiveManifestSource()).toBe('bundled');
        const cached = JSON.parse(readFileSync(join(TMP, '.zeph', 'agent-rules.json'), 'utf-8'));
        expect(cached.etag).toBe('W/"old"'); // 304s stop refetch churn
    });

    it('loadManifestFromCache keeps bundled over an older cached manifest', async () => {
        mkdirSync(join(TMP, '.zeph'), { recursive: true });
        writeFileSync(join(TMP, '.zeph', 'agent-rules.json'),
            JSON.stringify({ manifest: STALE_MANIFEST }));
        const m = await importModule();
        expect(m.loadManifestFromCache()).toBe('bundled');
        expect(m.getActiveManifest().version).not.toBe('2020.01.01.1');
    });

    it('equal versions still promote the cache (server may kill-switch without content change)', async () => {
        const m0 = await importModule();
        const sameVersion = { ...VALID_MANIFEST, version: m0.getActiveManifest().version };
        mkdirSync(join(TMP, '.zeph'), { recursive: true });
        writeFileSync(join(TMP, '.zeph', 'agent-rules.json'),
            JSON.stringify({ manifest: sameVersion }));
        vi.resetModules();
        const m = await importModule();
        expect(m.loadManifestFromCache()).toBe('cache');
    });
});

describe('rulesUrl stage derivation', () => {
    it('derives the manifest path from the configured base URL (dev /d1)', async () => {
        mkdirSync(join(TMP, '.zeph'), { recursive: true });
        writeFileSync(join(TMP, '.zeph', 'config.json'),
            JSON.stringify({ baseUrl: 'https://api.zeph.to/d1' }));
        const m = await importModule();
        expect(m.rulesUrl()).toBe('https://api.zeph.to/d1/agent-detection/manifest');
    });

    it('falls back to the prod /v1 base without config', async () => {
        const m = await importModule();
        expect(m.rulesUrl()).toBe('https://api.zeph.to/v1/agent-detection/manifest');
    });

    it('explicit ZEPH_AGENT_RULES_URL still wins', async () => {
        process.env.ZEPH_AGENT_RULES_URL = 'https://example.test/rules.json';
        vi.resetModules();
        const m = await importModule();
        expect(m.rulesUrl()).toBe('https://example.test/rules.json');
    });
});
