import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { projectHash } from './gate.js';
import { writeRemoteMarker } from './listener.js';
import { isRemoteHookAgent, runRemoteHook } from './remote-hook.js';

/**
 * TS twin of plugin/tests/test-zeph-remote.sh — same scenarios, same
 * expected behavior. Markers are written through the real writer
 * (listener.ts writeRemoteMarker), so every match test is a full
 * write→read roundtrip: a parity break between the two sides fails here.
 */
describe('runRemoteHook (ADR-0002, gemini/codex)', () => {
    let stateHome: string;
    let savedXdg: string | undefined;

    const NOW = 1_700_000_000_000;
    const at = (msAgo: number) => () => NOW - msAgo;

    beforeEach(() => {
        stateHome = mkdtempSync(join(tmpdir(), 'zeph-remote-hook-'));
        savedXdg = process.env.XDG_STATE_HOME;
        process.env.XDG_STATE_HOME = stateHome;
    });

    afterEach(() => {
        if (savedXdg === undefined) delete process.env.XDG_STATE_HOME;
        else process.env.XDG_STATE_HOME = savedXdg;
        rmSync(stateHome, { recursive: true, force: true });
    });

    const markerPath = (cwd: string): string =>
        join(stateHome, 'zeph', `remote-${projectHash(cwd)!}`);

    const stdin = (prompt: string, cwd: string): string =>
        JSON.stringify({ session_id: 's-1', hook_event_name: 'x', prompt, cwd });

    const TWO_WAY = { ZEPH_HOOK_ID: 'hook_123' } as NodeJS.ProcessEnv;
    const ONE_WAY = {} as NodeJS.ProcessEnv;

    const contextOf = (out: string | null): string => {
        expect(out).not.toBeNull();
        const parsed = JSON.parse(out!) as {
            hookSpecificOutput: { hookEventName: string; additionalContext: string };
        };
        return parsed.hookSpecificOutput.additionalContext;
    };

    it('fresh marker + matching prompt → REMOTE context, marker consumed (gemini)', () => {
        const cwd = '/proj/gemini-happy';
        writeRemoteMarker(cwd, 'fix the login bug', () => NOW);
        const out = runRemoteHook('gemini', stdin('fix the login bug', cwd), TWO_WAY, () => NOW);
        const parsed = JSON.parse(out!) as { hookSpecificOutput: { hookEventName: string } };
        expect(parsed.hookSpecificOutput.hookEventName).toBe('BeforeAgent');
        expect(contextOf(out)).toContain('REMOTE mode');
        expect(existsSync(markerPath(cwd))).toBe(false);
    });

    it('codex echoes its own hookEventName', () => {
        const cwd = '/proj/codex-happy';
        writeRemoteMarker(cwd, 'check the deploy', () => NOW);
        const out = runRemoteHook('codex', stdin('check the deploy', cwd), TWO_WAY, () => NOW);
        const parsed = JSON.parse(out!) as { hookSpecificOutput: { hookEventName: string } };
        expect(parsed.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit');
    });

    it('ZEPH_HOOK_ID unset → one-way conversion CTA, no two-way claim', () => {
        const cwd = '/proj/oneway';
        writeRemoteMarker(cwd, 'check the deploy status', () => NOW);
        const ctx = contextOf(runRemoteHook('gemini', stdin('check the deploy status', cwd), ONE_WAY, () => NOW));
        expect(ctx).toContain('npx @zeph-to/cli setup');
        expect(ctx).not.toContain('end EVERY response');
        expect(existsSync(markerPath(cwd))).toBe(false);
    });

    it('text mismatch → silent, marker kept (terminal race cannot false-match)', () => {
        const cwd = '/proj/mismatch';
        writeRemoteMarker(cwd, 'the phone message', () => NOW);
        expect(runRemoteHook('gemini', stdin('something typed at the terminal', cwd), TWO_WAY, () => NOW)).toBeNull();
        expect(existsSync(markerPath(cwd))).toBe(true);
    });

    it('still matches at 10 min (mid-turn queueing survives the window)', () => {
        const cwd = '/proj/longturn';
        writeRemoteMarker(cwd, 'sent during a long turn', at(600_000));
        expect(runRemoteHook('gemini', stdin('sent during a long turn', cwd), TWO_WAY, () => NOW)).not.toBeNull();
    });

    it('stale marker (>15 min) → silent, marker deleted', () => {
        const cwd = '/proj/stale';
        writeRemoteMarker(cwd, 'old command', at(1_000_000));
        expect(runRemoteHook('gemini', stdin('old command', cwd), TWO_WAY, () => NOW)).toBeNull();
        expect(existsSync(markerPath(cwd))).toBe(false);
    });

    it('muted project → silent, marker left unconsumed (Rule 12)', () => {
        const cwd = '/proj/muted';
        writeRemoteMarker(cwd, 'while muted', () => NOW);
        writeFileSync(join(stateHome, 'zeph', `muted-${projectHash(cwd)!}`), '');
        expect(runRemoteHook('gemini', stdin('while muted', cwd), TWO_WAY, () => NOW)).toBeNull();
        expect(existsSync(markerPath(cwd))).toBe(true);
    });

    it('no marker → silent no-op', () => {
        expect(runRemoteHook('gemini', stdin('any prompt', '/proj/none'), TWO_WAY, () => NOW)).toBeNull();
    });

    it('whitespace-padded prompt still matches (trim mirrors the writer)', () => {
        const cwd = '/proj/trim';
        writeRemoteMarker(cwd, 'run the tests', () => NOW);
        expect(runRemoteHook('gemini', stdin('  run the tests\n', cwd), TWO_WAY, () => NOW)).not.toBeNull();
    });

    it('multi-line prompt matches byte-for-byte', () => {
        const cwd = '/proj/multiline';
        const text = 'first line\nsecond line';
        writeRemoteMarker(cwd, text, () => NOW);
        expect(runRemoteHook('gemini', stdin(text, cwd), TWO_WAY, () => NOW)).not.toBeNull();
    });

    it('trailing U+00A0 NBSP survives the trim on both sides', () => {
        const cwd = '/proj/nbsp';
        const text = 'nbsp end ';
        writeRemoteMarker(cwd, text, () => NOW);
        // NBSP is part of the digest: the exact text matches …
        expect(runRemoteHook('gemini', stdin(text, cwd), TWO_WAY, () => NOW)).not.toBeNull();
        // … and the NBSP-stripped variant must NOT. The first call left this
        // project in REMOTE, so the second one still speaks — as the sticky
        // reminder. What it must never be is the entry note, and the marker it
        // failed to match must survive for a later prompt.
        writeRemoteMarker(cwd, text, () => NOW);
        const ctx = contextOf(runRemoteHook('gemini', stdin('nbsp end', cwd), TWO_WAY, () => NOW));
        expect(ctx).not.toContain('arrived from the user');
        expect(existsSync(markerPath(cwd))).toBe(true);
    });

    it('malformed marker content → silent, no crash', () => {
        const cwd = '/proj/garbage';
        mkdirSync(join(stateHome, 'zeph'), { recursive: true });
        writeFileSync(markerPath(cwd), 'not-a-timestamp junk\n');
        expect(runRemoteHook('gemini', stdin('whatever', cwd), TWO_WAY, () => NOW)).toBeNull();
    });

    it('empty prompt / missing cwd / invalid JSON → silent no-op', () => {
        const cwd = '/proj/empty';
        writeRemoteMarker(cwd, 'phone text', () => NOW);
        expect(runRemoteHook('gemini', stdin('', cwd), TWO_WAY, () => NOW)).toBeNull();
        expect(runRemoteHook('gemini', JSON.stringify({ prompt: 'phone text' }), TWO_WAY, () => NOW)).toBeNull();
        expect(runRemoteHook('gemini', 'not json', TWO_WAY, () => NOW)).toBeNull();
        expect(existsSync(markerPath(cwd))).toBe(true);
    });

    // Sticky REMOTE, same three scenarios as the bash twin's
    // "[sticky state alive…]" blocks in plugin/tests/test-zeph-remote.sh.

    const statePath = (cwd: string): string =>
        join(stateHome, 'zeph', `remote-active-${projectHash(cwd)!}`);

    const seedState = (cwd: string, secondsAgo = 0): void => {
        mkdirSync(join(stateHome, 'zeph'), { recursive: true });
        writeFileSync(statePath(cwd), `${Math.floor(NOW / 1000) - secondsAgo}\n`);
    };

    it('entering REMOTE records the state so later turns keep it', () => {
        const cwd = '/proj/enter';
        writeRemoteMarker(cwd, 'start from the phone', () => NOW);
        runRemoteHook('gemini', stdin('start from the phone', cwd), TWO_WAY, () => NOW);
        expect(existsSync(statePath(cwd))).toBe(true);
    });

    // The device-switch case: no marker, no zeph_ask result, and until the
    // state file existed there was nothing left to say the session was remote.
    it('state alive but no marker → reminder, not the entry note', () => {
        const cwd = '/proj/sticky';
        seedState(cwd);
        const ctx = contextOf(runRemoteHook('gemini', stdin('typed at the terminal', cwd), TWO_WAY, () => NOW));
        expect(ctx).toContain('REMOTE');
        expect(ctx).not.toContain('arrived from the user');
        expect(existsSync(statePath(cwd))).toBe(true);
    });

    it('state past the TTL → silent, and the state is swept', () => {
        const cwd = '/proj/sticky-stale';
        seedState(cwd, 20_000);
        expect(runRemoteHook('gemini', stdin('much later', cwd), TWO_WAY, () => NOW)).toBeNull();
        expect(existsSync(statePath(cwd))).toBe(false);
    });

    it('state alive but muted → silent (mute outranks, Rule 12)', () => {
        const cwd = '/proj/sticky-muted';
        seedState(cwd);
        writeFileSync(join(stateHome, 'zeph', `muted-${projectHash(cwd)!}`), '');
        expect(runRemoteHook('gemini', stdin('anything', cwd), TWO_WAY, () => NOW)).toBeNull();
        expect(existsSync(statePath(cwd))).toBe(true);
    });

    it('state alive but no ZEPH_HOOK_ID → silent (no zeph_ask to remind about)', () => {
        const cwd = '/proj/sticky-oneway';
        seedState(cwd);
        expect(runRemoteHook('gemini', stdin('typed at the terminal', cwd), ONE_WAY, () => NOW)).toBeNull();
        expect(existsSync(statePath(cwd))).toBe(true);
    });
});

describe('isRemoteHookAgent', () => {
    it('accepts exactly the agents whose hooks the cli installs', () => {
        expect(isRemoteHookAgent('gemini')).toBe(true);
        expect(isRemoteHookAgent('codex')).toBe(true);
        expect(isRemoteHookAgent('cc')).toBe(false);
        expect(isRemoteHookAgent('')).toBe(false);
    });
});
