/**
 * Agent state detection engine — classifies a tmux pane's visible text
 * into `working | blocked | idle | unknown` using declarative rules.
 *
 * Design constraints (see zeph/docs/SPEC-AGENT-AWARENESS.md §S1):
 * - Rules are DATA, not code: they ship bundled but are replaceable
 *   over the air (§S7), so agent UI changes never require a daemon
 *   release. Everything here must therefore survive hostile or
 *   malformed manifests: pattern-length caps, input-size caps, and
 *   per-rule isolation of regex compile failures.
 * - Pure functions only. The listener owns timing, tmux, and I/O;
 *   this module owns classification and flap suppression so both are
 *   unit-testable without a terminal.
 * - `done` is deliberately NOT a wire state: "finished but unseen" is
 *   per-user view state, derived client-side. The daemon reports only
 *   what it can observe.
 */
import type { AgentKind } from './remote-agents.js';

export type AgentState = 'working' | 'blocked' | 'idle' | 'unknown';

export interface RuleCondition {
    /** All strings must appear (case-insensitive). */
    contains?: string[];
    /** All patterns must match. */
    regex?: string[];
}

export interface DetectionRule {
    id: string;
    state: AgentState;
    /** Higher wins; first match ends evaluation. */
    priority: number;
    /** 'tail' = last N non-empty lines (default), 'whole' = full capture. */
    region?: 'tail' | 'whole';
    /** Lines for region 'tail'. Default 10. */
    tailLines?: number;
    contains?: string[];
    regex?: string[];
    /** At least one condition group must match (OR). */
    any?: RuleCondition[];
    /** No condition group may match (exclusion). */
    not?: RuleCondition[];
    /**
     * On match, keep the previous state instead of this rule's state.
     * For overlay screens (transcript viewer, menus) that would
     * otherwise pollute the state while the agent is still working.
     */
    skipStateUpdate?: boolean;
}

export interface DetectionManifest {
    engineVersion: number;
    /** Date.revision, e.g. "2026.07.04.1" — for OTA freshness compare. */
    version: string;
    /** Kill-switch: rule ids to ignore without shipping a new manifest shape. */
    disabledRuleIds?: string[];
    agents: Partial<Record<AgentKind, DetectionRule[]>>;
}

export const ENGINE_VERSION = 1;

// OTA manifests are semi-trusted: schema-validated but authored by
// humans and fetched over the network. Caps bound the worst case of a
// pathological regex (ReDoS) — a 200-char pattern over ≤8 KiB input
// keeps even catastrophic backtracking in the low milliseconds.
const MAX_PATTERN_LENGTH = 200;
const MAX_INPUT_BYTES = 8 * 1024;
const DEFAULT_TAIL_LINES = 10;

export interface EvaluationResult {
    state: AgentState;
    /** Rule that decided the state — for verbose logs and rule debugging. */
    ruleId?: string;
}

// Compiled-regex cache. Rules are static between manifest swaps, so
// compiling once per (pattern) is enough; a failed compile is cached as
// null so a bad OTA pattern logs once, not every 5-second cycle.
const regexCache = new Map<string, RegExp | null>();

const compilePattern = (pattern: string): RegExp | null => {
    if (regexCache.has(pattern)) return regexCache.get(pattern) ?? null;
    let compiled: RegExp | null = null;
    if (pattern.length <= MAX_PATTERN_LENGTH) {
        try {
            compiled = new RegExp(pattern, 'im');
        } catch {
            compiled = null;
        }
    }
    regexCache.set(pattern, compiled);
    return compiled;
};

/** Test hook: manifest swaps call this so stale patterns don't pin memory. */
export const clearRegexCache = (): void => {
    regexCache.clear();
};

const conditionMatches = (cond: RuleCondition, text: string, lowerText: string): boolean => {
    for (const needle of cond.contains ?? []) {
        if (!lowerText.includes(needle.toLowerCase())) return false;
    }
    for (const pattern of cond.regex ?? []) {
        const compiled = compilePattern(pattern);
        // A pattern that failed to compile can never be satisfied —
        // fail the condition rather than silently passing it, so a
        // broken OTA rule becomes inert instead of over-matching.
        if (!compiled || !compiled.test(text)) return false;
    }
    return true;
};

const ruleMatches = (rule: DetectionRule, text: string, lowerText: string): boolean => {
    if (!conditionMatches({ contains: rule.contains, regex: rule.regex }, text, lowerText)) return false;
    if (rule.any && rule.any.length > 0) {
        if (!rule.any.some((c) => conditionMatches(c, text, lowerText))) return false;
    }
    for (const excluded of rule.not ?? []) {
        if (conditionMatches(excluded, text, lowerText)) return false;
    }
    return true;
};

const tailOf = (lines: string[], count: number): string =>
    lines.filter((l) => l.trim().length > 0).slice(-count).join('\n');

/**
 * Classify one pane capture. `prev` feeds skipStateUpdate rules — an
 * overlay match returns the previous confirmed state unchanged.
 */
export const evaluateState = (
    paneText: string,
    agentKind: AgentKind,
    manifest: DetectionManifest,
    prev: AgentState = 'unknown',
): EvaluationResult => {
    // Truncate from the FRONT: the bottom of the pane is where every
    // agent renders its live status, so the tail is the signal.
    let text = paneText;
    if (Buffer.byteLength(text, 'utf-8') > MAX_INPUT_BYTES) {
        text = text.slice(-MAX_INPUT_BYTES);
    }
    const lines = text.split('\n');
    const disabled = new Set(manifest.disabledRuleIds ?? []);
    const rules = (manifest.agents[agentKind] ?? [])
        .filter((r) => !disabled.has(r.id))
        .sort((a, b) => b.priority - a.priority);

    for (const rule of rules) {
        const scope = rule.region === 'whole'
            ? text
            : tailOf(lines, rule.tailLines ?? DEFAULT_TAIL_LINES);
        if (ruleMatches(rule, scope, scope.toLowerCase())) {
            if (rule.skipStateUpdate) return { state: prev, ruleId: rule.id };
            return { state: rule.state, ruleId: rule.id };
        }
    }
    return { state: 'unknown' };
};

/**
 * Safe one-pattern probe for output-match watches (§S5 v2). Same caps
 * as rule evaluation — user-authored watch patterns are exactly as
 * untrusted as OTA rules. Returns the matched line for the push body.
 */
export const findPatternMatch = (pattern: string, paneText: string): { line: string } | null => {
    let text = paneText;
    if (Buffer.byteLength(text, 'utf-8') > MAX_INPUT_BYTES) {
        text = text.slice(-MAX_INPUT_BYTES);
    }
    const compiled = compilePattern(pattern);
    if (!compiled) return null;
    const match = compiled.exec(text);
    if (!match) return null;
    const start = text.lastIndexOf('\n', match.index) + 1;
    const endIdx = text.indexOf('\n', match.index);
    const line = text.slice(start, endIdx === -1 ? undefined : endIdx).trim();
    return { line };
};

// ── Flap suppression ─────────────────────────────────────────────

export interface StateTracker {
    /** Last CONFIRMED state — what gets reported to the server. */
    confirmed: AgentState;
    confirmedAt: number;
    ruleId?: string;
    /** Pending different observation awaiting its second sighting. */
    candidate?: AgentState;
    candidateRuleId?: string;
    /** Hash of the pane text behind the last evaluation (skip re-eval). */
    contentHash?: string;
}

/**
 * Consecutive-confirmation debounce: a NEW state must be observed on
 * two consecutive cycles (~10 s at the 5 s report interval) before it
 * replaces the confirmed one. Menus flashed open, mid-render frames,
 * and scroll artifacts all last one cycle and die as candidates.
 *
 * The very first observation confirms immediately — a fresh tracker
 * has no baseline to protect, and the server treats a session's first
 * reported state as baseline, not as a transition (§S2).
 */
export const advanceState = (
    tracker: StateTracker | undefined,
    observed: EvaluationResult,
    now: number,
): StateTracker => {
    if (!tracker) {
        return { confirmed: observed.state, confirmedAt: now, ruleId: observed.ruleId };
    }
    if (observed.state === tracker.confirmed) {
        // Re-confirmation clears any pending candidate.
        return { ...tracker, candidate: undefined, candidateRuleId: undefined, ruleId: observed.ruleId ?? tracker.ruleId };
    }
    if (observed.state === tracker.candidate) {
        // Second consecutive sighting — promote.
        return { confirmed: observed.state, confirmedAt: now, ruleId: observed.ruleId };
    }
    return { ...tracker, candidate: observed.state, candidateRuleId: observed.ruleId };
};
