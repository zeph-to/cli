import { describe, expect, it, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { projectHash } from './gate.js';
import { writeRemoteMarker } from './listener.js';
import { isRemoteHookAgent, runRemoteHook } from './remote-hook.js';

// config.ts binds ~/.zeph/config.json to $HOME at import time, so HOME moves
// BEFORE the imports run (vi.hoisted) — the same real-$HOME seam cli.test.ts
// uses, without a module mock. The dir is created/removed around the suite.
const HOME = vi.hoisted(() => {
    const saved = process.env.HOME;
    process.env.HOME = `${process.env.TMPDIR || '/tmp'}/zeph-remote-hook-home-${process.pid}`;
    return { dir: process.env.HOME, saved };
});
const CONFIG_FILE = `${HOME.dir}/.zeph/config.json`;
/** ~/.zeph/config.json as `zeph setup` leaves it; no id = a notify-only install. */
const writeConfig = (hookId?: string): void => {
    mkdirSync(`${HOME.dir}/.zeph`, { recursive: true });
    writeFileSync(CONFIG_FILE, JSON.stringify({ apiKey: 'k', ...(hookId ? { hookId } : {}) }));
};
afterAll(() => {
    if (HOME.saved === undefined) delete process.env.HOME;
    else process.env.HOME = HOME.saved;
    rmSync(HOME.dir, { recursive: true, force: true });
});

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
        rmSync(CONFIG_FILE, { force: true });
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

    it('fresh marker + matching prompt → REMOTE context, echoes before_agent_start (pi)', () => {
        const cwd = '/proj/pi-happy';
        writeRemoteMarker(cwd, 'fix the login bug', () => NOW);
        const out = runRemoteHook('pi', stdin('fix the login bug', cwd), TWO_WAY, () => NOW);
        const parsed = JSON.parse(out!) as { hookSpecificOutput: { hookEventName: string } };
        expect(parsed.hookSpecificOutput.hookEventName).toBe('before_agent_start');
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

    it('ZEPH_HOOK_ID unset but hookId in config.json → two-way, state recorded', () => {
        const cwd = '/proj/config-only';
        writeConfig('hook_cfg');
        writeRemoteMarker(cwd, 'from the phone, config only', () => NOW);
        const ctx = contextOf(runRemoteHook('gemini', stdin('from the phone, config only', cwd), ONE_WAY, () => NOW));
        expect(ctx).toContain('end EVERY response');
        expect(ctx).not.toContain('npx @zeph-to/cli setup');
        expect(existsSync(statePath(cwd))).toBe(true);
    });

    it('unresolved ${ZEPH_HOOK_ID} placeholder → treated as unset (one-way when config has no id)', () => {
        const cwd = '/proj/placeholder';
        writeConfig();
        writeRemoteMarker(cwd, 'placeholder in env', () => NOW);
        const env = { ZEPH_HOOK_ID: '${ZEPH_HOOK_ID}' } as NodeJS.ProcessEnv;
        const ctx = contextOf(runRemoteHook('gemini', stdin('placeholder in env', cwd), env, () => NOW));
        expect(ctx).toContain('npx @zeph-to/cli setup');
        expect(ctx).not.toContain('end EVERY response');
    });

    it('state alive, env unset, hookId in config.json → a terminal turn still ends REMOTE', () => {
        const cwd = '/proj/sticky-config';
        writeConfig('hook_cfg');
        seedState(cwd);
        const ctx = contextOf(runRemoteHook('gemini', stdin('typed at the terminal', cwd), ONE_WAY, () => NOW));
        expect(ctx).toContain('LEFT sticky REMOTE mode');
        expect(existsSync(statePath(cwd))).toBe(false);
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
        // … and the NBSP-stripped variant must NOT. This is the ambiguous
        // case, not a terminal turn: a fresh marker the prompt failed to match
        // means a phone message is still in flight, so the hook stays silent,
        // keeps the marker for a later prompt, and leaves REMOTE alone.
        writeRemoteMarker(cwd, text, () => NOW);
        expect(runRemoteHook('gemini', stdin('nbsp end', cwd), TWO_WAY, () => NOW)).toBeNull();
        expect(existsSync(markerPath(cwd))).toBe(true);
        expect(existsSync(statePath(cwd))).toBe(true);
    });

    it('malformed marker content → silent, no crash, and the junk is swept', () => {
        const cwd = '/proj/garbage';
        mkdirSync(join(stateHome, 'zeph'), { recursive: true });
        writeFileSync(markerPath(cwd), 'not-a-timestamp junk\n');
        expect(runRemoteHook('gemini', stdin('whatever', cwd), TWO_WAY, () => NOW)).toBeNull();
        expect(existsSync(markerPath(cwd))).toBe(false);
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

    // No marker means the user's own keyboard — a phone answer comes back as a
    // tool_result and never reaches a prompt hook. So they are back, and the
    // session leaves REMOTE instead of answering the terminal with a phone loop.
    it('state alive but no marker → the exit note, and the state is cleared', () => {
        const cwd = '/proj/sticky';
        seedState(cwd);
        const ctx = contextOf(runRemoteHook('gemini', stdin('typed at the terminal', cwd), TWO_WAY, () => NOW));
        expect(ctx).toContain('LEFT sticky REMOTE mode');
        expect(ctx).not.toContain('arrived from the user');
        expect(existsSync(statePath(cwd))).toBe(false);
        // Said once: with the state gone, later terminal turns cost nothing.
        expect(runRemoteHook('gemini', stdin('and another one', cwd), TWO_WAY, () => NOW)).toBeNull();
    });

    // Ambiguous evidence: the digest missing does not mean the user typed —
    // the message may be queued behind a long turn, or the two sides may hash
    // a composition differently. Dropping REMOTE strands a user still on the
    // phone, so the mode is left exactly as it was.
    it('fresh marker left unmatched → silent, and REMOTE survives', () => {
        const cwd = '/proj/sticky-pending';
        seedState(cwd);
        writeRemoteMarker(cwd, 'the phone message', () => NOW);
        expect(runRemoteHook('gemini', stdin('not the injected text', cwd), TWO_WAY, () => NOW)).toBeNull();
        expect(existsSync(statePath(cwd))).toBe(true);
        expect(existsSync(markerPath(cwd))).toBe(true);
    });

    it('empty prompt with a marker pending → no evidence, REMOTE survives', () => {
        const cwd = '/proj/sticky-empty';
        seedState(cwd);
        writeRemoteMarker(cwd, 'the phone message', () => NOW);
        expect(runRemoteHook('gemini', stdin('', cwd), TWO_WAY, () => NOW)).toBeNull();
        expect(existsSync(statePath(cwd))).toBe(true);
    });

    it('stale marker on a live session → still a terminal turn, REMOTE ends', () => {
        const cwd = '/proj/sticky-stale-marker';
        seedState(cwd);
        writeRemoteMarker(cwd, 'old phone text', () => NOW - 1_000_000);
        const ctx = contextOf(runRemoteHook('gemini', stdin('typed at the terminal', cwd), TWO_WAY, () => NOW));
        expect(ctx).toContain('LEFT sticky REMOTE mode');
        expect(existsSync(statePath(cwd))).toBe(false);
        expect(existsSync(markerPath(cwd))).toBe(false);
    });

    it('a phone message after that re-enters REMOTE', () => {
        const cwd = '/proj/sticky-reentry';
        seedState(cwd);
        runRemoteHook('gemini', stdin('typed at the terminal', cwd), TWO_WAY, () => NOW);
        writeRemoteMarker(cwd, 'back on the phone', () => NOW);
        const ctx = contextOf(runRemoteHook('gemini', stdin('back on the phone', cwd), TWO_WAY, () => NOW));
        expect(ctx).toContain('arrived from the user');
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
        expect(isRemoteHookAgent('pi')).toBe(true);
        // opencode's plugin API has no verified injection path (v1) — the
        // command must reject it, not silently serve a dead hook.
        expect(isRemoteHookAgent('opencode')).toBe(false);
        expect(isRemoteHookAgent('cc')).toBe(false);
        expect(isRemoteHookAgent('')).toBe(false);
    });
});
