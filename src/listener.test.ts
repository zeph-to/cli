import { describe, expect, it, beforeEach } from 'vitest';
import { parseSessionName, checkRateLimit, handlePush } from './listener.js';

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

    it('ignores pushes that are not agent.command', () => {
        let injected = false;
        const ok = handlePush(
            { pushId: '1', type: 'note', body: 'Just a regular notification' },
            baseDeps({ inject: () => { injected = true; return true; } }),
        );
        expect(ok).toBe(false);
        expect(injected).toBe(false);
    });

    it('ignores agent.command without agentSessionName', () => {
        let injected = false;
        const ok = handlePush(
            { pushId: '1', type: 'agent.command', body: 'hello' },
            baseDeps({ inject: () => { injected = true; return true; } }),
        );
        expect(ok).toBe(false);
        expect(injected).toBe(false);
    });

    it('ignores encrypted pushes (no key to decrypt body)', () => {
        let injected = false;
        const ok = handlePush(
            agentCmd({ isEncrypted: true }),
            baseDeps({ inject: () => { injected = true; return true; } }),
        );
        expect(ok).toBe(false);
        expect(injected).toBe(false);
    });

    it('injects when session exists and pane runs an agent', () => {
        let calledWith: { session: string; text: string } | null = null;
        const ok = handlePush(
            agentCmd(),
            baseDeps({
                paneCommand: () => 'claude',
                inject: (session, text) => { calledWith = { session, text }; return true; },
            }),
        );
        expect(ok).toBe(true);
        expect(calledWith).toEqual({ session: 'zeph-myapp', text: 'do the thing' });
    });

    it('refuses to inject when pane is at a shell (RCE guard)', () => {
        let injected = false;
        const ok = handlePush(
            agentCmd({ body: 'rm -rf' }),
            baseDeps({
                paneCommand: () => 'bash',
                inject: () => { injected = true; return true; },
            }),
        );
        expect(ok).toBe(false);
        expect(injected).toBe(false);
    });

    it('refuses when the tmux session does not exist', () => {
        let injected = false;
        const ok = handlePush(
            agentCmd({ agentSessionName: 'ghost' }),
            baseDeps({
                paneCommand: () => null,
                inject: () => { injected = true; return true; },
            }),
        );
        expect(ok).toBe(false);
        expect(injected).toBe(false);
    });

    it('drops on rate-limit', () => {
        let injected = false;
        const ok = handlePush(
            agentCmd(),
            baseDeps({
                rateLimit: () => false,
                inject: () => { injected = true; return true; },
            }),
        );
        expect(ok).toBe(false);
        expect(injected).toBe(false);
    });

    it('accepts python/node/codex/gemini as non-shell commands', () => {
        for (const cmd of ['claude', 'codex', 'gemini', 'node', 'python3']) {
            const ok = handlePush(
                agentCmd(),
                baseDeps({ paneCommand: () => cmd }),
            );
            expect(ok, `expected ${cmd} to be allowed`).toBe(true);
        }
    });

    it('refuses on every common shell name', () => {
        for (const shell of ['bash', 'zsh', 'fish', 'sh', 'dash', 'ksh', 'tcsh', 'csh', 'pwsh']) {
            const ok = handlePush(
                agentCmd(),
                baseDeps({ paneCommand: () => shell }),
            );
            expect(ok, `expected ${shell} to be refused`).toBe(false);
        }
    });

    it('drops empty body (no spurious Enter)', () => {
        let injected = false;
        const ok = handlePush(
            agentCmd({ body: '' }),
            baseDeps({ inject: () => { injected = true; return true; } }),
        );
        expect(ok).toBe(false);
        expect(injected).toBe(false);
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
