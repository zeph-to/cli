import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ZEPH_CORE_HOOK_DRIVEN, ZEPH_CORE_RULE_ONLY } from './zeph-core.generated.js';

// Belt-and-braces drift check: when a zeph-to/plugin checkout sits at the
// sibling ../plugin (the default dev layout), re-run the sync script in
// --check mode so local `npm test` catches generated-file drift without
// waiting for CI (which does the same against plugin main via a cross-repo
// checkout). Skipped on standalone clones.

const REPO_ROOT = join(__dirname, '..');
const PLUGIN_ROOT = join(REPO_ROOT, '..', 'plugin');
const hasPluginCheckout = existsSync(join(PLUGIN_ROOT, 'scripts', 'extract-core.js'));

describe.skipIf(!hasPluginCheckout)('rules-sync: generated artifacts match ../plugin', () => {
    it('sync-from-plugin --check passes', () => {
        expect(() =>
            execFileSync('node', [join(REPO_ROOT, 'scripts', 'sync-from-plugin.mjs'), '--check'], {
                encoding: 'utf-8',
                stdio: ['ignore', 'pipe', 'pipe'],
            }),
        ).not.toThrow();
    });
});

describe('rules-sync: generated core is wired into the templates', () => {
    it('hook-driven rules carry the shared core and the --auto notify command', async () => {
        const tmpl = await import('./templates.js');
        expect(tmpl.CURSOR_RULE).toContain('Sticky REMOTE mode');
        expect(tmpl.CURSOR_HOOKS).toContain('--auto');
    });

    it('rule-only rules carry the shared core too', async () => {
        const tmpl = await import('./templates.js');
        expect(tmpl.CLINE_RULE).toContain('Sticky REMOTE mode');
        expect(tmpl.AIDER_RULE).toContain('Sticky REMOTE mode');
    });
});

// The core scopes Rules 1/2/8/9 to REMOTE and tells NORMAL it owes no
// zeph_ask. That is safe exactly where a prompt-submit hook can announce the
// phone message that starts REMOTE. Only Gemini, Codex and Pi have that hook;
// for every other agent a zeph_ask answer is the sole way in, so their rule
// file must keep asking after real work or the phone loop can never begin.
describe('rules-sync: REMOTE entry for agents without a prompt-submit hook', () => {
    const ENTRY = 'Entering REMOTE without a prompt hook';

    it('agents with no prompt hook restore the after-work ask', async () => {
        const tmpl = await import('./templates.js');
        for (const rule of [
            tmpl.CURSOR_RULE,
            tmpl.WINDSURF_RULE,
            tmpl.COPILOT_RULE,
            tmpl.CLINE_RULE,
            tmpl.AIDER_RULE,
            tmpl.OPENCODE_RULE,
        ]) {
            expect(rule).toContain(ENTRY);
            expect(rule).toContain('overrides the "In NORMAL, end with nothing" clause');
        }
    });

    it('agents WITH the prompt hook rely on it and get no override', async () => {
        const tmpl = await import('./templates.js');
        // The hook exists — asserted on the hook config, not assumed.
        expect(JSON.stringify(tmpl.GEMINI_HOOKS)).toContain('remote-hook gemini');
        expect(JSON.stringify(tmpl.CODEX_HOOKS)).toContain('remote-hook codex');
        expect(tmpl.PI_EXTENSION).toContain('remote-hook pi');
        expect(tmpl.GEMINI_RULE).not.toContain(ENTRY);
        expect(tmpl.CODEX_RULE).not.toContain(ENTRY);
        expect(tmpl.PI_RULE).not.toContain(ENTRY);
    });

    it('the preamble sits before the core so the override reads first', async () => {
        const tmpl = await import('./templates.js');
        const rule = tmpl.CURSOR_RULE;
        expect(rule.indexOf(ENTRY)).toBeLessThan(rule.indexOf('Sticky REMOTE mode'));
    });
});

// A prompt-submit hook announces the phone message that starts REMOTE, and the
// hook injects the REMOTE contract on that turn (remote-hook.ts). So the static
// rule file of those three agents is read on every turn of a session that is
// almost always NORMAL — it carries the NORMAL branch only, the way the plugin's
// SessionStart hook does for Claude Code, plus a stub saying what starts REMOTE.
describe('rules-sync: prompt-hook agents carry the NORMAL branch only', () => {
    const REMOTE_ONLY = ['When zeph_ask is MANDATORY', 'Sticky REMOTE mode', 'When to use AskUserQuestion vs zeph_ask'];
    const NORMAL = ['Handling the response', 'What starts REMOTE', 'Persistence'];

    it('pi / gemini / codex omit the REMOTE-scoped sections and keep the NORMAL ones', async () => {
        const tmpl = await import('./templates.js');
        for (const rule of [tmpl.PI_RULE, tmpl.GEMINI_RULE, tmpl.CODEX_RULE]) {
            for (const heading of REMOTE_ONLY) expect(rule).not.toContain(heading);
            for (const heading of NORMAL) expect(rule).toContain(heading);
            expect(rule).toContain('You owe no `zeph_ask`');
        }
    });

    it('the NORMAL branch is well under half the full core', async () => {
        const tmpl = await import('./templates.js');
        expect(tmpl.PI_RULE.length).toBeLessThan(ZEPH_CORE_HOOK_DRIVEN.length / 2 + 2000);
    });

    it('agents without the hook still carry the full core', async () => {
        const tmpl = await import('./templates.js');
        for (const rule of [tmpl.CURSOR_RULE, tmpl.OPENCODE_RULE, tmpl.CLINE_RULE]) {
            for (const heading of REMOTE_ONLY) expect(rule).toContain(heading);
        }
    });
});

// The core is sliced per audience, so a sentence that points at a section the
// slice excludes reads as a dangling reference: the CLI cores never carry the
// Push Signal / dial sections (`audiences: []` in the plugin manifest), yet the
// rule text used to name them anyway. Fixed upstream in plugin
// docs/CORE_RULES.md; this is the only automated gate that catches a
// regression, because the leak only shows up in the generated file.
describe('rules-sync: the core never points at sections it does not carry', () => {
    const DANGLING = ['Push Signal', 'zeph: high', '/zeph-'];

    for (const [name, core] of [
        ['hook-driven', ZEPH_CORE_HOOK_DRIVEN],
        ['rule-only', ZEPH_CORE_RULE_ONLY],
    ] as const) {
        it(`${name} core names no excluded section`, () => {
            for (const needle of DANGLING) {
                expect(core).not.toContain(needle);
            }
        });
    }

    // Every audience gets a subset of the source rules, so the assembled list
    // has to be renumbered to 1..N — a gap means a cross-reference can point at
    // a number the reader never received (plugin scripts/extract-core.js).
    for (const [name, core] of [
        ['hook-driven', ZEPH_CORE_HOOK_DRIVEN],
        ['rule-only', ZEPH_CORE_RULE_ONLY],
    ] as const) {
        it(`${name} core is numbered 1..N with no gaps`, () => {
            const numbers = [...core.matchAll(/^(\d+)\. /gm)].map((m) => Number(m[1]));
            expect(numbers.length).toBeGreaterThan(0);
            expect(numbers).toEqual(numbers.map((_, i) => i + 1));
        });
    }
});

// The extractor renumbers the core per audience, so a rule number is only ever
// true inside the core text it came from. Anything this repo writes AROUND the
// core — the per-agent preambles — must name the rule instead, or it points at
// a number the reader's own file gives to a different rule.
describe('rules-sync: cli-authored preamble text names rules, never numbers', () => {
    it('no preamble cites a rule by number', async () => {
        const tmpl = await import('./templates.js');
        const cores = [ZEPH_CORE_HOOK_DRIVEN, ZEPH_CORE_RULE_ONLY];
        for (const [name, rule] of Object.entries(tmpl).filter(([n]) => n.endsWith('_RULE'))) {
            let preamble = rule as string;
            for (const core of cores) preamble = preamble.replace(core, '');
            expect(preamble, `${name} preamble`).not.toMatch(/\b[Rr]ules?\s+\d+/);
        }
    });
});
