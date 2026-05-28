import { describe, expect, it, beforeEach } from 'vitest';
import { parseInjection, parseSessionName, checkRateLimit, handlePush } from './listener.js';

describe('parseInjection', () => {
    it('parses `@session text`', () => {
        expect(parseInjection('@zeph-myapp 리팩토링 부탁')).toEqual({
            session: 'zeph-myapp',
            text: '리팩토링 부탁',
        });
    });

    it('preserves internal whitespace and trims edges', () => {
        expect(parseInjection('@s1   hello   world  ')).toEqual({
            session: 's1',
            text: 'hello   world',
        });
    });

    it('accepts multi-line text', () => {
        expect(parseInjection('@s1\nline one\nline two')).toEqual({
            session: 's1',
            text: 'line one\nline two',
        });
    });

    it('returns null when prefix is not at start', () => {
        expect(parseInjection('hi @session world')).toBeNull();
    });

    it('returns null when there is no text body', () => {
        expect(parseInjection('@session')).toBeNull();
        expect(parseInjection('@session   ')).toBeNull();
    });

    it('returns null on empty or undefined', () => {
        expect(parseInjection('')).toBeNull();
        expect(parseInjection(undefined)).toBeNull();
    });

    it('rejects session names with shell-unsafe chars', () => {
        // ; and $ are not in the allowed [A-Za-z0-9._-] charset, so the
        // session regex fails and the whole thing returns null.
        expect(parseInjection('@a;b hi')).toBeNull();
        expect(parseInjection('@a$b hi')).toBeNull();
    });
});

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

    it('ignores pushes without the @session prefix', () => {
        let injected = false;
        const ok = handlePush(
            { pushId: '1', body: 'Just a regular notification' },
            baseDeps({ inject: () => { injected = true; return true; } }),
        );
        expect(ok).toBe(false);
        expect(injected).toBe(false);
    });

    it('ignores encrypted pushes (no key to decrypt body)', () => {
        let injected = false;
        const ok = handlePush(
            { pushId: '1', body: '@s1 should be ignored', isEncrypted: true },
            baseDeps({ inject: () => { injected = true; return true; } }),
        );
        expect(ok).toBe(false);
        expect(injected).toBe(false);
    });

    it('injects when session exists and pane runs an agent', () => {
        let calledWith: { session: string; text: string } | null = null;
        const ok = handlePush(
            { pushId: '1', body: '@zeph-myapp do thing' },
            baseDeps({
                paneCommand: () => 'claude',
                inject: (session, text) => { calledWith = { session, text }; return true; },
            }),
        );
        expect(ok).toBe(true);
        expect(calledWith).toEqual({ session: 'zeph-myapp', text: 'do thing' });
    });

    it('refuses to inject when pane is at a shell (RCE guard)', () => {
        let injected = false;
        const ok = handlePush(
            { pushId: '1', body: '@s1 rm -rf' },
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
            { pushId: '1', body: '@ghost-session hi' },
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
            { pushId: '1', body: '@s1 hi' },
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
                { pushId: '1', body: '@s1 hi' },
                baseDeps({ paneCommand: () => cmd }),
            );
            expect(ok, `expected ${cmd} to be allowed`).toBe(true);
        }
    });

    it('refuses on every common shell name', () => {
        for (const shell of ['bash', 'zsh', 'fish', 'sh', 'dash', 'ksh', 'tcsh', 'csh', 'pwsh']) {
            const ok = handlePush(
                { pushId: '1', body: '@s1 hi' },
                baseDeps({ paneCommand: () => shell }),
            );
            expect(ok, `expected ${shell} to be refused`).toBe(false);
        }
    });

    it("prefers structured agent.command type over body's @-prefix", () => {
        let calledWith: { session: string; text: string } | null = null;
        const ok = handlePush(
            // body intentionally has @another-session to prove the
            // structured path wins; agentSessionName is the authority.
            {
                pushId: '1',
                type: 'agent.command',
                agentSessionName: 'zeph-myapp',
                body: '@another-session this body should not route here',
            },
            baseDeps({
                paneCommand: () => 'claude',
                inject: (session, text) => { calledWith = { session, text }; return true; },
            }),
        );
        expect(ok).toBe(true);
        expect(calledWith).toEqual({
            session: 'zeph-myapp',
            text: '@another-session this body should not route here',
        });
    });

    it('agent.command path still applies the shell-pane guard', () => {
        let injected = false;
        const ok = handlePush(
            { pushId: '1', type: 'agent.command', agentSessionName: 'zeph-x', body: 'rm -rf' },
            baseDeps({
                paneCommand: () => 'bash',
                inject: () => { injected = true; return true; },
            }),
        );
        expect(ok).toBe(false);
        expect(injected).toBe(false);
    });

    it('agent.command path still applies the rate limit', () => {
        let injected = false;
        const ok = handlePush(
            { pushId: '1', type: 'agent.command', agentSessionName: 'zeph-x', body: 'hi' },
            baseDeps({
                rateLimit: () => false,
                inject: () => { injected = true; return true; },
            }),
        );
        expect(ok).toBe(false);
        expect(injected).toBe(false);
    });

    it('agent.command with empty body is dropped (no spurious Enter)', () => {
        let injected = false;
        const ok = handlePush(
            { pushId: '1', type: 'agent.command', agentSessionName: 'zeph-x', body: '' },
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
