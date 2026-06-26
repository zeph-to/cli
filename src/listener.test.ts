import { describe, expect, it, beforeEach } from 'vitest';
import { mkdirSync, mkdtempSync, existsSync, utimesSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { parseSessionName, checkRateLimit, handlePush, gcAttachments } from './listener.js';

describe('checkRateLimit', () => {
    beforeEach(() => {
        // The bucket map is module-scope; use a fresh session per test
        // so buckets don't leak between cases.
    });

    it('allows up to the bucket size, then drops', () => {
        const s = `s-${Date.now()}-${Math.random()}`;
        const now = 1_000_000;
        // First 30 succeed
        for (let i = 0; i < 30; i++) expect(checkRateLimit(s, now)).toBe(true);
        // 31st without time advancing is dropped
        expect(checkRateLimit(s, now)).toBe(false);
    });

    it('refills proportionally over the window', () => {
        const s = `s-${Date.now()}-${Math.random()}`;
        const t0 = 1_000_000;
        // Drain the bucket
        for (let i = 0; i < 30; i++) checkRateLimit(s, t0);
        expect(checkRateLimit(s, t0)).toBe(false);
        // Half a window later → ~half the tokens back → many succeed before drop
        const t1 = t0 + 30_000;
        let succeeded = 0;
        for (let i = 0; i < 30; i++) if (checkRateLimit(s, t1)) succeeded++;
        expect(succeeded).toBeGreaterThanOrEqual(14);
        expect(succeeded).toBeLessThanOrEqual(16);
    });

    it('tracks buckets per-session independently', () => {
        const a = `a-${Date.now()}-${Math.random()}`;
        const b = `b-${Date.now()}-${Math.random()}`;
        const now = 1_000_000;
        for (let i = 0; i < 30; i++) checkRateLimit(a, now);
        expect(checkRateLimit(a, now)).toBe(false);
        // Session b is untouched
        expect(checkRateLimit(b, now)).toBe(true);
    });
});

describe('handlePush', () => {
    const baseDeps = (override: Parameters<typeof handlePush>[1] = {}) => ({
        paneCommand: () => 'claude',
        inject: () => true,
        rateLimit: () => true,
        ...override,
    });

    const agentCmd = (overrides: Partial<Parameters<typeof handlePush>[0]> = {}) => ({
        pushId: '1',
        type: 'agent.command' as const,
        agentSessionName: 'zeph-myapp',
        body: 'do the thing',
        ...overrides,
    });

    it('ignores pushes that are not agent.command', async () => {
        let injected = false;
        const ok = await handlePush(
            { pushId: '1', type: 'note', body: 'Just a regular notification' },
            baseDeps({ inject: () => { injected = true; return true; } }),
        );
        expect(ok).toBe(false);
        expect(injected).toBe(false);
    });

    it('ignores agent.command without agentSessionName', async () => {
        let injected = false;
        const ok = await handlePush(
            { pushId: '1', type: 'agent.command', body: 'hello' },
            baseDeps({ inject: () => { injected = true; return true; } }),
        );
        expect(ok).toBe(false);
        expect(injected).toBe(false);
    });

    it('ignores encrypted pushes (no key to decrypt body)', async () => {
        let injected = false;
        const ok = await handlePush(
            agentCmd({ isEncrypted: true }),
            baseDeps({ inject: () => { injected = true; return true; } }),
        );
        expect(ok).toBe(false);
        expect(injected).toBe(false);
    });

    it('injects when session exists and pane runs an agent', async () => {
        let calledWith: { session: string; text: string } | null = null;
        const ok = await handlePush(
            agentCmd(),
            baseDeps({
                paneCommand: () => 'claude',
                inject: (session, text) => { calledWith = { session, text }; return true; },
            }),
        );
        expect(ok).toBe(true);
        expect(calledWith).toEqual({ session: 'zeph-myapp', text: 'do the thing' });
    });

    it('refuses to inject when pane is at a shell (RCE guard)', async () => {
        let injected = false;
        const ok = await handlePush(
            agentCmd({ body: 'rm -rf' }),
            baseDeps({
                paneCommand: () => 'bash',
                inject: () => { injected = true; return true; },
            }),
        );
        expect(ok).toBe(false);
        expect(injected).toBe(false);
    });

    it('refuses when the tmux session does not exist', async () => {
        let injected = false;
        const ok = await handlePush(
            agentCmd({ agentSessionName: 'ghost' }),
            baseDeps({
                paneCommand: () => null,
                inject: () => { injected = true; return true; },
            }),
        );
        expect(ok).toBe(false);
        expect(injected).toBe(false);
    });

    it('drops on rate-limit', async () => {
        let injected = false;
        const ok = await handlePush(
            agentCmd(),
            baseDeps({
                rateLimit: () => false,
                inject: () => { injected = true; return true; },
            }),
        );
        expect(ok).toBe(false);
        expect(injected).toBe(false);
    });

    it('accepts python/node/codex/gemini as non-shell commands', async () => {
        for (const cmd of ['claude', 'codex', 'gemini', 'node', 'python3']) {
            const ok = await handlePush(
                agentCmd(),
                baseDeps({ paneCommand: () => cmd }),
            );
            expect(ok, `expected ${cmd} to be allowed`).toBe(true);
        }
    });

    it('refuses on every common shell name', async () => {
        for (const shell of ['bash', 'zsh', 'fish', 'sh', 'dash', 'ksh', 'tcsh', 'csh', 'pwsh']) {
            const ok = await handlePush(
                agentCmd(),
                baseDeps({ paneCommand: () => shell }),
            );
            expect(ok, `expected ${shell} to be refused`).toBe(false);
        }
    });

    it('drops empty body (no spurious Enter)', async () => {
        let injected = false;
        const ok = await handlePush(
            agentCmd({ body: '' }),
            baseDeps({ inject: () => { injected = true; return true; } }),
        );
        expect(ok).toBe(false);
        expect(injected).toBe(false);
    });

    it('downloads attachments then injects body + paths', async () => {
        let calledWith: { session: string; text: string } | null = null;
        const ok = await handlePush(
            agentCmd({ files: [{ fileKey: 'fk1', fileName: 'shot.png' }] }),
            baseDeps({
                inject: (session, text) => { calledWith = { session, text }; return true; },
                downloadAttachments: async () => ['/tmp/zeph/shot.png'],
            }),
        );
        expect(ok).toBe(true);
        expect(calledWith).toEqual({ session: 'zeph-myapp', text: 'do the thing\n/tmp/zeph/shot.png' });
    });

    it('injects paths only when body is empty', async () => {
        let text: string | null = null;
        const ok = await handlePush(
            agentCmd({ body: '', files: [{ fileKey: 'fk1', fileName: 'a.png' }] }),
            baseDeps({
                inject: (_s, t) => { text = t; return true; },
                downloadAttachments: async () => ['/tmp/a.png'],
            }),
        );
        expect(ok).toBe(true);
        expect(text).toBe('/tmp/a.png');
    });

    it('isolates download failure — still injects the body', async () => {
        let text: string | null = null;
        const ok = await handlePush(
            agentCmd({ files: [{ fileKey: 'fk1', fileName: 'a.png' }] }),
            baseDeps({
                inject: (_s, t) => { text = t; return true; },
                downloadAttachments: async () => { throw new Error('network down'); },
            }),
        );
        expect(ok).toBe(true);
        expect(text).toBe('do the thing');
    });

    it('drops when body empty and all attachments failed (no paths)', async () => {
        let injected = false;
        const ok = await handlePush(
            agentCmd({ body: '', files: [{ fileKey: 'fk1', fileName: 'a.png' }] }),
            baseDeps({
                inject: () => { injected = true; return true; },
                downloadAttachments: async () => [],
            }),
        );
        expect(ok).toBe(false);
        expect(injected).toBe(false);
    });
});

describe('gcAttachments', () => {
    it('removes dirs older than the TTL and keeps fresh ones', () => {
        const root = mkdtempSync(join(tmpdir(), 'zeph-gc-'));
        const now = 1_000_000_000_000;
        const ttl = 60_000;
        const old = join(root, 'old');
        const fresh = join(root, 'fresh');
        mkdirSync(old);
        mkdirSync(fresh);
        // mtime in seconds for utimes; old is well past the TTL.
        utimesSync(old, new Date(now - ttl - 10_000), new Date(now - ttl - 10_000));
        utimesSync(fresh, new Date(now - 1_000), new Date(now - 1_000));

        const removed = gcAttachments(now, root, ttl);
        expect(removed).toBe(1);
        expect(existsSync(old)).toBe(false);
        expect(existsSync(fresh)).toBe(true);
    });

    it('returns 0 when the attachments dir does not exist', () => {
        expect(gcAttachments(Date.now(), join(tmpdir(), 'zeph-gc-missing-xyz'))).toBe(0);
    });
});

describe('parseSessionName', () => {
    it('strips the zeph- prefix into the project field', () => {
        expect(parseSessionName('zeph-encl')).toEqual({ project: 'encl', label: null });
    });

    it('keeps dashes inside the project name (Phase 1: no label parsing yet)', () => {
        expect(parseSessionName('zeph-my-cool-app')).toEqual({ project: 'my-cool-app', label: null });
    });

    it('returns null for non-zeph-prefixed names', () => {
        expect(parseSessionName('main')).toBeNull();
        expect(parseSessionName('zeph')).toBeNull();   // no dash, no project
        expect(parseSessionName('zeph-')).toBeNull();  // empty project
        expect(parseSessionName('')).toBeNull();
    });
});
