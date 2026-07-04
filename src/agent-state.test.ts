import { beforeEach, describe, expect, it } from 'vitest';
import {
    advanceState, clearRegexCache, evaluateState,
    ENGINE_VERSION,
    type DetectionManifest, type StateTracker,
} from './agent-state.js';
import { DEFAULT_MANIFEST } from './agent-rules.default.js';

// ── Synthetic pane fixtures ──────────────────────────────────────
// Hand-written approximations of Claude Code screens; the point is to
// exercise the rule shapes (affordance text + prompt glyph), not to be
// pixel-faithful.

const PANE_WORKING = [
    '● Reading src/listener.ts…',
    '',
    '✻ Churning… (12s · esc to interrupt)',
].join('\n');

const PANE_BLOCKED_PERMISSION = [
    'Bash command: rm -rf ./dist',
    '',
    'Do you want to proceed?',
    '❯ 1. Yes',
    '  2. No, tell Claude what to do differently',
    '',
    'Enter to select · esc to cancel',
].join('\n');

const PANE_IDLE = [
    '● Done. All tests green.',
    '',
    '╭──────────────────────────────╮',
    '│ ❯                            │',
    '╰──────────────────────────────╯',
    '  ? for shortcuts',
].join('\n');

const PANE_TRANSCRIPT = [
    'Showing detailed transcript',
    'some scrolled content here',
    'ctrl+o to toggle',
].join('\n');

const PANE_GIBBERISH = 'lorem ipsum nothing recognizable';

beforeEach(() => {
    clearRegexCache();
});

describe('evaluateState against DEFAULT_MANIFEST (claude)', () => {
    it('detects working from the interrupt hint', () => {
        const r = evaluateState(PANE_WORKING, 'claude', DEFAULT_MANIFEST);
        expect(r.state).toBe('working');
        expect(r.ruleId).toBe('claude-working-interrupt-hint');
    });

    it('detects a blocking permission dialog', () => {
        const r = evaluateState(PANE_BLOCKED_PERMISSION, 'claude', DEFAULT_MANIFEST);
        expect(r.state).toBe('blocked');
        expect(r.ruleId).toBe('claude-blocked-dialog');
    });

    it('does not classify working-with-interrupt as blocked', () => {
        // "esc to interrupt" contains "esc" — the not-clause must keep
        // the blocked rule from firing on a working screen that also
        // shows a navigation hint in scrollback.
        const pane = PANE_WORKING + '\nuse arrows to navigate history';
        const r = evaluateState(pane, 'claude', DEFAULT_MANIFEST);
        expect(r.state).toBe('working');
    });

    it('detects idle from the prompt glyph', () => {
        const r = evaluateState(PANE_IDLE, 'claude', DEFAULT_MANIFEST);
        expect(r.state).toBe('idle');
    });

    it('freezes state on the transcript overlay (skipStateUpdate)', () => {
        const r = evaluateState(PANE_TRANSCRIPT, 'claude', DEFAULT_MANIFEST, 'working');
        expect(r.state).toBe('working');
        expect(r.ruleId).toBe('claude-transcript-overlay');
    });

    it('returns unknown when nothing matches', () => {
        expect(evaluateState(PANE_GIBBERISH, 'claude', DEFAULT_MANIFEST).state).toBe('unknown');
    });

    it('returns unknown for agents with no rules (codex/gemini)', () => {
        expect(evaluateState(PANE_WORKING, 'codex', DEFAULT_MANIFEST).state).toBe('unknown');
        expect(evaluateState(PANE_IDLE, 'gemini', DEFAULT_MANIFEST).state).toBe('unknown');
    });
});

describe('manifest safety', () => {
    const manifestWith = (rules: DetectionManifest['agents']['claude']): DetectionManifest => ({
        engineVersion: ENGINE_VERSION,
        version: '2026.01.01.1',
        agents: { claude: rules, codex: [], gemini: [] },
    });

    it('honors disabledRuleIds as a kill-switch', () => {
        const manifest: DetectionManifest = {
            ...DEFAULT_MANIFEST,
            disabledRuleIds: ['claude-working-interrupt-hint'],
        };
        expect(evaluateState(PANE_WORKING, 'claude', manifest).state).toBe('unknown');
    });

    it('isolates an invalid regex to its own rule', () => {
        const manifest = manifestWith([
            { id: 'bad', state: 'blocked', priority: 900, regex: ['[unclosed'] },
            { id: 'good', state: 'working', priority: 800, contains: ['esc to interrupt'] },
        ]);
        const r = evaluateState(PANE_WORKING, 'claude', manifest);
        expect(r.state).toBe('working');
        expect(r.ruleId).toBe('good');
    });

    it('rejects patterns above the length cap', () => {
        const manifest = manifestWith([
            { id: 'huge', state: 'blocked', priority: 900, regex: ['a'.repeat(201)] },
        ]);
        expect(evaluateState('aaa', 'claude', manifest).state).toBe('unknown');
    });

    it('truncates oversized input from the front and still matches the tail', () => {
        const noise = 'x'.repeat(20_000);
        const pane = noise + '\n' + PANE_WORKING;
        expect(evaluateState(pane, 'claude', DEFAULT_MANIFEST).state).toBe('working');
    });

    it('higher priority wins regardless of array order', () => {
        const manifest = manifestWith([
            { id: 'low', state: 'idle', priority: 100, contains: ['marker'] },
            { id: 'high', state: 'blocked', priority: 200, contains: ['marker'] },
        ]);
        expect(evaluateState('marker', 'claude', manifest).ruleId).toBe('high');
    });
});

describe('advanceState flap suppression', () => {
    const at = (state: 'working' | 'blocked' | 'idle' | 'unknown') => ({ state });

    it('confirms the first observation immediately (baseline)', () => {
        const t = advanceState(undefined, at('working'), 1000);
        expect(t.confirmed).toBe('working');
        expect(t.confirmedAt).toBe(1000);
    });

    it('requires two consecutive sightings to change state', () => {
        let t: StateTracker = advanceState(undefined, at('working'), 0);
        t = advanceState(t, at('blocked'), 5000);
        expect(t.confirmed).toBe('working');      // candidate only
        expect(t.candidate).toBe('blocked');
        t = advanceState(t, at('blocked'), 10000);
        expect(t.confirmed).toBe('blocked');      // promoted
        expect(t.confirmedAt).toBe(10000);
    });

    it('drops a one-cycle flap', () => {
        let t: StateTracker = advanceState(undefined, at('working'), 0);
        t = advanceState(t, at('idle'), 5000);    // menu flash
        t = advanceState(t, at('working'), 10000); // back to normal
        expect(t.confirmed).toBe('working');
        expect(t.candidate).toBeUndefined();
        t = advanceState(t, at('idle'), 15000);
        expect(t.confirmed).toBe('working');       // still one sighting
    });

    it('resets the candidate when a third state appears', () => {
        let t: StateTracker = advanceState(undefined, at('working'), 0);
        t = advanceState(t, at('idle'), 5000);
        t = advanceState(t, at('blocked'), 10000);
        expect(t.confirmed).toBe('working');
        expect(t.candidate).toBe('blocked');       // idle candidate replaced
        t = advanceState(t, at('blocked'), 15000);
        expect(t.confirmed).toBe('blocked');
    });
});
