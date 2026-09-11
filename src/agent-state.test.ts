import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import {
    advanceState, clearRegexCache, evaluateState,
    ENGINE_VERSION,
    type DetectionManifest, type DetectionRule, type StateTracker,
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
            disabledRuleIds: [
                'claude-working-interrupt-hint',
                'claude-working-token-counter',
                'claude-working-elapsed-spinner',
            ],
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

describe('working detection on hint-less CC skins (2026.07.04.2 rules)', () => {
    // Real capture from a Fable 5 session: no "esc to interrupt" hint,
    // prompt box ❯ visible WHILE working — the token-counter spinner
    // line is the only working signal.
    const PANE_WORKING_NO_HINT = [
        '⏺ Running 3 shell commands…',
        '',
        '✶ Fiddle-faddling… (1m 2s · ↓ 1.2k tokens)',
        '',
        '─────────────────────────────',
        '❯',
        '─────────────────────────────',
        '  Fable 5 | cli • feat/agent-state | 55%',
    ].join('\n');

    it('classifies the token-counter spinner as working (not idle)', () => {
        const r = evaluateState(PANE_WORKING_NO_HINT, 'claude', DEFAULT_MANIFEST);
        expect(r.state).toBe('working');
        expect(r.ruleId).toBe('claude-working-token-counter');
    });

    it('elapsed-only spinner (before token counter appears) is working', () => {
        const pane = '✻ Pondering… (3s · esc? no)\n❯';
        expect(evaluateState(pane, 'claude', DEFAULT_MANIFEST).state).toBe('working');
    });

    it('compact pass reads as working despite lacking every spinner signal', () => {
        // Real capture: /compact renders "(51s)" with no "·" suffix, no
        // token counter, no interrupt hint — previously classified idle.
        const pane = [
            '❯ /compact',
            '',
            '✱ Compacting conversation… (51s)',
            '▰▰▰▰▰▰▰▰▱▱▱▱ 44%',
            '─────────────',
            '❯',
        ].join('\n');
        const r = evaluateState(pane, 'claude', DEFAULT_MANIFEST);
        expect(r.state).toBe('working');
        expect(r.ruleId).toBe('claude-working-compacting');
    });

    it('still idle when spinner line is gone', () => {
        const pane = [
            '⏺ Done.',
            '─────────────',
            '❯',
            '─────────────',
            '  ? for shortcuts',
        ].join('\n');
        expect(evaluateState(pane, 'claude', DEFAULT_MANIFEST).state).toBe('idle');
    });
});

// The candidate pi rules on screens the bench did not capture. Each line below
// is the vendor's own string (pi v0.85.1 dist/modes/interactive/components) or
// a live pane's footer, so these pin the pattern edges the bench cannot reach.
describe('candidate pi rules — screens not captured', () => {
    const candidate = JSON.parse(
        readFileSync(new URL('./fixtures/pi-rules.candidate.json', import.meta.url), 'utf-8'),
    ) as { rules: DetectionRule[] };
    const manifest: DetectionManifest = { engineVersion: ENGINE_VERSION, version: '2026.01.01.1', agents: { pi: candidate.rules } };
    const pi = (lines: string[]) => evaluateState(lines.join('\n'), 'pi', manifest).state;

    beforeEach(() => clearRegexCache());

    it('pi core selector dialog → blocked', () => {
        expect(pi(['  Pick a branch', '→ main', '  dev', ' ↑↓ navigate  enter select  escape/ctrl+c cancel', '───', '0.4%/1.0M (auto)'])).toBe('blocked');
    });

    it('pi core input dialog → blocked', () => {
        expect(pi(['  Branch name', '> feat/x', ' enter submit  escape/ctrl+c cancel', '───', '0.4%/1.0M (auto)'])).toBe('blocked');
    });

    it("an ask picker's free-text Other entry → blocked", () => {
        expect(pi(['  Other answer', '> foo', ' Enter to submit • Esc to go back', '───', '0.4%/1.0M'])).toBe('blocked');
    });

    it('a picker still wins over the Working spinner it opened under', () => {
        expect(pi(['── ⠦ Working ──', '> 1. Alpha', '  2. Beta', ' ↑↓ navigate • Enter select • Esc cancel', '0.4%/1.0M'])).toBe('blocked');
    });

    it('footer right after a compaction (context usage unknown) → idle', () => {
        expect(pi(['▎', ' dou-app on  feat/x [░░░░░░░░░░] ?/1.0M', ' ↑258k ↓24k 99.6%'])).toBe('idle');
    });

    it('the startup key legend is not a dialog', () => {
        expect(pi([' escape interrupt · ctrl+c/ctrl+d clear/exit · / commands · ! bash · ctrl+o more', '───', '0.0%/1.0M (auto)'])).toBe('idle');
    });

    it('a status line drawn in braille that is not a spinner frame stays idle', () => {
        expect(pi(['───', '↑531k ↓139k $0.316 5.0%/1.0M (auto)', '⠠⠄ caveman level: FULL'])).toBe('idle');
    });

    it('the spinner counts bare at line start, as a custom editor draws it', () => {
        expect(pi([' ⠦ Working', '▎', ' dou-app on  main [░░░] 7.0%/1.0M'])).toBe('working');
    });

    it('a braille glyph mid-line in leftover output is not the spinner', () => {
        expect(pi(['  build: 12 files ⠙ cached', '───', '↑3.8k ↓33 0.4%/1.0M (auto)'])).toBe('idle');
    });
});
