import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// login.ts is the `zeph login` loopback-bridge command. These tests pin the
// pure pieces — URL building, config merge (deviceId must survive), and the
// callback validator (state mismatch must be rejected). The HTTP server and
// browser-open paths are exercised manually (see PLAN E2E step).

const ENV_KEYS = ['HOME'] as const;
const originalEnv: Record<string, string | undefined> = {};
for (const key of ENV_KEYS) originalEnv[key] = process.env[key];

let TMP: string;

beforeEach(() => {
    TMP = mkdtempSync(join(tmpdir(), 'sdk-login-test-'));
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

describe('stripUndefined', () => {
    it('drops undefined-valued keys, keeps the rest', async () => {
        const { stripUndefined } = await import('./login.js');
        expect(stripUndefined({ a: 'x', b: undefined, c: 0 })).toEqual({ a: 'x', c: 0 });
    });
});

describe('buildBridgeUrl', () => {
    it('builds the cli-bridge URL with encoded host', async () => {
        const { buildBridgeUrl } = await import('./login.js');
        const url = buildBridgeUrl('https://app.zeph.to', 51234, 'abc123', "Tak's Mac");
        const parsed = new URL(url);
        expect(parsed.origin + parsed.pathname).toBe('https://app.zeph.to/auth/cli-bridge');
        expect(parsed.searchParams.get('port')).toBe('51234');
        expect(parsed.searchParams.get('state')).toBe('abc123');
        expect(parsed.searchParams.get('host')).toBe("Tak's Mac");
    });

    it('strips a trailing slash on webUrl', async () => {
        const { buildBridgeUrl } = await import('./login.js');
        const url = buildBridgeUrl('https://app.zeph.to/', 1, 's', 'h');
        expect(url.startsWith('https://app.zeph.to/auth/cli-bridge?')).toBe(true);
    });
});

describe('persistConfig', () => {
    it('merges into existing config, preserving deviceId', async () => {
        mkdirSync(join(TMP, '.zeph'), { recursive: true });
        writeFileSync(
            join(TMP, '.zeph', 'config.json'),
            JSON.stringify({ deviceId: 'dev_keepme', apiKey: 'ak_old' }),
        );

        const { persistConfig } = await import('./login.js');
        persistConfig({ apiKey: 'ak_new', hookId: 'hook_x', baseUrl: 'https://api', wsUrl: 'wss://api' });

        const saved = JSON.parse(readFileSync(join(TMP, '.zeph', 'config.json'), 'utf-8'));
        expect(saved).toEqual({
            deviceId: 'dev_keepme',
            apiKey: 'ak_new',
            hookId: 'hook_x',
            baseUrl: 'https://api',
            wsUrl: 'wss://api',
        });
    });

    it('does not erase existing keys when next-value is undefined', async () => {
        mkdirSync(join(TMP, '.zeph'), { recursive: true });
        writeFileSync(
            join(TMP, '.zeph', 'config.json'),
            JSON.stringify({ hookId: 'hook_keep', apiKey: 'ak_old' }),
        );

        const { persistConfig } = await import('./login.js');
        persistConfig({ apiKey: 'ak_new', hookId: undefined, baseUrl: undefined, wsUrl: undefined });

        const saved = JSON.parse(readFileSync(join(TMP, '.zeph', 'config.json'), 'utf-8'));
        expect(saved.apiKey).toBe('ak_new');
        expect(saved.hookId).toBe('hook_keep');
    });
});

describe('resolveTimeoutSec', () => {
    it('falls back to default for a non-numeric value (no instant setTimeout)', async () => {
        const { resolveTimeoutSec } = await import('./login.js');
        expect(resolveTimeoutSec('abc')).toBe(300);
        expect(resolveTimeoutSec('0')).toBe(300);
        expect(resolveTimeoutSec(true)).toBe(300);
        expect(resolveTimeoutSec('45')).toBe(45);
    });
});

describe('runLoginFlow', () => {
    it('returns null immediately when the browser cannot open (headless)', async () => {
        const { runLoginFlow } = await import('./login.js');
        const result = await runLoginFlow({ webUrl: 'https://x', timeoutSec: 60 }, { open: () => false });
        expect(result).toBeNull();
    });

    it('returns null on timeout when no callback arrives', async () => {
        const { runLoginFlow } = await import('./login.js');
        // open succeeds but nothing hits /cb; short timeout resolves to null fast
        const result = await runLoginFlow({ webUrl: 'https://x', timeoutSec: 0.05 }, { open: () => true });
        expect(result).toBeNull();
    });
});

describe('parseCallback', () => {
    it('accepts a matching state and extracts config', async () => {
        const { parseCallback } = await import('./login.js');
        const result = parseCallback(
            '/cb?key=ak_1&hook=hook_1&baseUrl=https://api&wsUrl=wss://api&state=S1',
            'S1',
        );
        expect(result).toEqual({
            ok: true,
            config: { apiKey: 'ak_1', hookId: 'hook_1', baseUrl: 'https://api', wsUrl: 'wss://api' },
        });
    });

    it('rejects a state mismatch with 403', async () => {
        const { parseCallback } = await import('./login.js');
        const result = parseCallback('/cb?key=ak_1&state=WRONG', 'S1');
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.status).toBe(403);
    });

    it('rejects a missing key with 400', async () => {
        const { parseCallback } = await import('./login.js');
        const result = parseCallback('/cb?state=S1', 'S1');
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.status).toBe(400);
    });

    it('ignores non-/cb paths with 404', async () => {
        const { parseCallback } = await import('./login.js');
        const result = parseCallback('/favicon.ico', 'S1');
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.status).toBe(404);
    });
});
