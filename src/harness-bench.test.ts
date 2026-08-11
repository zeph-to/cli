/**
 * Harness capability bench — does the shipped rule set actually classify the
 * screens each supported agent really draws?
 *
 * Why this exists separately from agent-state.test.ts: that suite feeds the
 * engine hand-written approximations, which proves the rule *shapes* work but
 * can never catch a vendor changing its UI. Every fixture here is a verbatim
 * `tmux capture-pane -p` of a live session, captured by running the agent —
 * originally observed for this repo, never transcribed from another project
 * (the boundary in agent-rules.default.ts:5-7 and SPEC-AGENT-AWARENESS.md:7).
 *
 * The bench reports a matrix of harness × state. A blank cell is NOT a failure:
 * codex and gemini ship with empty rule sets on purpose ("Honest ignorance
 * beats guessed state" — agent-rules.default.ts:20-21), because rules arrive as
 * OTA data rather than in a release (§S7). What the bench asserts is that the
 * engine's answer matches what the bundle claims to know:
 *
 *   - harness WITH bundled rules → the real pane must classify correctly.
 *     This is the regression gate: a vendor UI change turns a cell red.
 *   - harness WITHOUT bundled rules → the real pane must come back `unknown`.
 *     This is the honesty gate: it fails the moment someone half-fills a rule
 *     set and starts guessing states the bundle cannot actually detect.
 *
 * Adding a fixture for a new agent is therefore the first half of publishing an
 * OTA rule set, and this file is what makes that publishable.
 *
 * ── Re-capturing a fixture ────────────────────────────────────────
 * Fixtures go stale when a vendor redraws its UI. Replace one by observing the
 * screen again — never by hand-editing the file, or the bench stops testing
 * reality:
 *
 *     tmux new-session -d -s bench -x 110 -y 45 '<agent-binary>'
 *     # drive the session to the screen you want, then:
 *     tmux capture-pane -p -t bench -S -40 > src/fixtures/panes/<agent>-<state>.txt
 *     tmux kill-session -t bench
 *
 * Then trim the capture to the screen itself. Two things must not survive into
 * the repo: trailing blank rows tmux pads the pane height with, and absolute
 * paths from the capturing machine (`/Users/...`) — local noise that has
 * nothing to do with the state signal.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
    clearRegexCache, ENGINE_VERSION, evaluateState,
    type AgentState, type DetectionManifest, type DetectionRule,
} from './agent-state.js';
import { DEFAULT_MANIFEST } from './agent-rules.default.js';
import { compareManifestVersions } from './agent-rules-fetch.js';
import type { AgentKind } from './remote-agents.js';

const PANES_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'panes');

interface BenchCase {
    agent: AgentKind;
    /** What a user looking at this pane would say the agent is doing. */
    expected: AgentState;
    fixture: string;
    /** The screen this capture came from, for the matrix and for the next reader. */
    screen: string;
}

/**
 * Captured 2026-08-11 — Claude Code v2.1.227, Gemini CLI v0.46.0, both in a
 * 110x45 tmux pane, using the recipe above.
 */
const CASES: readonly BenchCase[] = [
    { agent: 'claude', expected: 'working', fixture: 'claude-working.txt', screen: 'spinner with elapsed time + token counter' },
    { agent: 'claude', expected: 'blocked', fixture: 'claude-blocked-askuserquestion.txt', screen: 'AskUserQuestion picker' },
    { agent: 'claude', expected: 'blocked', fixture: 'claude-blocked-trust-dialog.txt', screen: 'folder trust dialog' },
    { agent: 'claude', expected: 'idle', fixture: 'claude-idle.txt', screen: 'prompt at rest' },
    { agent: 'gemini', expected: 'working', fixture: 'gemini-working.txt', screen: 'Thinking… spinner with cancel hint' },
    { agent: 'gemini', expected: 'blocked', fixture: 'gemini-blocked-trust-dialog.txt', screen: 'folder trust dialog' },
    { agent: 'gemini', expected: 'idle', fixture: 'gemini-idle.txt', screen: 'input box at rest' },
];

/**
 * Which agents the bench has captured at all. Exhaustive over `AgentKind` on
 * purpose: adding a remote-control agent fails to compile until someone says
 * whether the bench covers it, so a new harness can't slip in unobserved.
 */
const HAS_FIXTURES: Record<AgentKind, boolean> = {
    claude: true,
    gemini: true,
    // Not installed on the machine that captured these; `zeph setup` still
    // writes its hooks and rules, so this is a real gap, not an oversight.
    codex: false,
};

const readPane = (fixture: string): string => readFileSync(join(PANES_DIR, fixture), 'utf-8');

const hasBundledRules = (agent: AgentKind): boolean => (DEFAULT_MANIFEST.agents[agent] ?? []).length > 0;

const classify = (c: BenchCase) => {
    clearRegexCache();
    return evaluateState(readPane(c.fixture), c.agent, DEFAULT_MANIFEST);
};

describe('harness bench — bundled rules vs real panes', () => {
    for (const c of CASES) {
        const covered = hasBundledRules(c.agent);
        const label = covered
            ? `${c.agent}: ${c.screen} → ${c.expected}`
            : `${c.agent}: ${c.screen} → unknown (no bundled rules yet)`;

        it(label, () => {
            const result = classify(c);
            if (covered) {
                expect(result.state).toBe(c.expected);
                // A correct answer from no rule at all would mean the engine
                // guessed; every covered cell must name the rule that decided it.
                expect(result.ruleId).toBeTruthy();
            } else {
                expect(result.state).toBe('unknown');
            }
        });
    }

    // The matrix is a REPORT, not a gate — the per-case tests above are what
    // fail. Printing it from afterAll keeps that honest: a test whose assertion
    // cannot fail would be a report wearing a test's clothes.
    afterAll(() => {
        const states: AgentState[] = ['working', 'blocked', 'idle'];
        const rows = (Object.keys(HAS_FIXTURES) as AgentKind[]).map((agent) => {
            if (!HAS_FIXTURES[agent]) return `  ${agent.padEnd(8)} no fixtures captured yet`;
            const cells = states.map((state) => {
                const c = CASES.find((x) => x.agent === agent && x.expected === state);
                if (!c) return `${state}: no fixture`;
                if (!hasBundledRules(agent)) return `${state}: uncovered`;
                const got = classify(c);
                return `${state}: ${got.state === state ? got.ruleId : `MISMATCH(${got.state})`}`;
            });
            return `  ${agent.padEnd(8)} ${cells.join(' | ')}`;
        });
        process.stdout.write(['harness bench matrix:', ...rows, ''].join('\n'));
    });
});

/**
 * Candidate rules — verified here, published elsewhere.
 *
 * Rules for an agent the bundle deliberately leaves empty still have to be
 * proven against real panes before they go out, or publishing walks straight
 * past the gate this file exists to be. The candidate set lives as data in
 * fixtures/gemini-rules.candidate.json and is copied verbatim into
 * zeph/apps/server/src/agent-rules/manifest.json when published; the engine
 * that runs it here is the same one the listener runs.
 *
 * Nothing mechanical ties the two repos together — that repo's manifest cannot
 * be read from this repo's CI, the same limit PUBLISHED_FLOOR lives with. What
 * this does buy: rules cannot be *authored* without a real pane proving each
 * one, and a vendor UI change turns these red exactly like the bundled set.
 */
const CANDIDATE_CASES: readonly BenchCase[] = CASES.filter((c) => c.agent === 'gemini');

describe('candidate gemini rules — verified before publishing', () => {
    const candidate = JSON.parse(
        readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'gemini-rules.candidate.json'), 'utf-8'),
    ) as { rules: DetectionRule[] };

    const manifest: DetectionManifest = {
        engineVersion: ENGINE_VERSION,
        version: DEFAULT_MANIFEST.version,
        agents: { gemini: candidate.rules },
    };

    for (const c of CANDIDATE_CASES) {
        it(`${c.screen} → ${c.expected}`, () => {
            clearRegexCache();
            const result = evaluateState(readPane(c.fixture), c.agent, manifest);
            expect(result.state).toBe(c.expected);
            expect(result.ruleId).toBeTruthy();
        });
    }

    it('leaves the bundle alone — an offline listener still reports unknown', () => {
        // The whole point of publishing over the air: a daemon that cannot
        // reach the endpoint must keep saying `unknown` rather than carry a
        // half-verified guess in its binary.
        expect(DEFAULT_MANIFEST.agents.gemini ?? []).toHaveLength(0);
    });

    it('every candidate rule is structurally valid for the listener validator', () => {
        for (const rule of candidate.rules) {
            expect(rule.id.length).toBeGreaterThan(0);
            expect(['working', 'blocked', 'idle', 'unknown']).toContain(rule.state);
            expect(typeof rule.priority).toBe('number');
        }
        const ids = candidate.rules.map((r) => r.id);
        expect(new Set(ids).size).toBe(ids.length);
    });
});

/**
 * The bundle must never claim a version the published manifest hasn't reached.
 *
 * `loadManifestFromCache` and the fetch path both gate on
 * `compareManifestVersions(remote, DEFAULT_MANIFEST.version) >= 0`
 * (agent-rules-fetch.ts:148,217). Bumping the bundle past what
 * api.zeph.to serves makes every fetched manifest `stale-ignored` — and with it
 * the `disabledRuleIds` kill-switch, which is the one lever that turns off a
 * bad rule without a release. That is the failure the 0.5.10 rollback taught
 * (SPEC-AGENT-AWARENESS.md §S7).
 *
 * PUBLISHED_FLOOR mirrors zeph/apps/server/src/agent-rules/manifest.json. It is
 * a constant rather than a live read for hermeticity, NOT because the value is
 * out of reach: agent-rules-fetch.ts pulls that same manifest from the public
 * `api.zeph.to/v1/agent-detection/manifest`, so a unit test could too — and
 * then would fail whenever the network did, which is not what this test is for.
 *
 * The cost is a hand-maintained mirror with no drift gate, unlike the
 * plugin→cli artifacts that `sync-from-plugin.mjs --check` keeps honest. If
 * this pair drifts often enough to hurt, the fix is a scheduled job that reads
 * the live endpoint and fails only itself — not making this test depend on a
 * network. Raising the floor is a deliberate act: publish there first, then
 * move this line. A floor that lags the published version is harmless — it only
 * ever blocks a bundle bump, never a fetch.
 */
const PUBLISHED_FLOOR = '2026.08.11.1';

describe('bundled manifest vs published manifest', () => {
    it('does not outrank what the endpoint serves', () => {
        expect(compareManifestVersions(DEFAULT_MANIFEST.version, PUBLISHED_FLOOR)).toBeLessThanOrEqual(0);
    });

    it('keeps the kill-switch reachable for every bundled rule', () => {
        // disabledRuleIds targets ids; a duplicate id would make the switch
        // ambiguous, and an empty one makes it unusable.
        const ids = Object.values(DEFAULT_MANIFEST.agents).flatMap((rules) => rules ?? []).map((r) => r.id);
        expect(ids.length).toBeGreaterThan(0);
        expect(ids.every((id) => id.length > 0)).toBe(true);
        expect(new Set(ids).size).toBe(ids.length);
    });
});
