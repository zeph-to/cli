/**
 * Hook-driven agents and the quiet default.
 *
 * Every agent below installs the same completion command (NOTIFY_CMD). Those
 * hooks supply no turn counts and no Push Signal marker, so under the quiet
 * default the gate could never let them push — Zeph would install cleanly and
 * then do nothing, forever, with no error anywhere. `--pushmode-default normal`
 * keeps them on the normal heuristic until the user sets a dial of their own.
 *
 * The flag name comes from gate.ts so the writer here and the reader in cli.ts
 * cannot drift; a typo in either would be exactly the silent regression this
 * file exists to prevent.
 */
import { describe, expect, it } from 'vitest';
import { PUSHMODE_DEFAULT_FLAG } from './gate.js';
import { REMOTE_HOOK_AGENTS } from './remote-hook.js';
import * as templates from './templates.js';

// Derived from the module, not hand-listed: a sixth agent added to
// templates.ts joins this table by itself. A hand-written table would only
// ever constrain itself, which is no guard at all.
const HOOK_CONFIGS = Object.entries(templates).filter(([name]) => name.endsWith('_HOOKS'));

/** Every string leaf in a hook config, whether it ships as JSON text or object. */
const stringsOf = (value: unknown): string[] => {
    if (typeof value === 'string') return [value];
    if (Array.isArray(value)) return value.flatMap(stringsOf);
    if (value && typeof value === 'object') return Object.values(value).flatMap(stringsOf);
    return [];
};

const commandsOf = (config: unknown): string[] =>
    stringsOf(typeof config === 'string' ? JSON.parse(config) : config);

describe('templates.ts: completion hooks survive the quiet default', () => {
    it('every agent that installs hooks is covered here', () => {
        // Five today (Cursor, Windsurf, Gemini, Codex, Copilot). The assertion
        // is a floor, not a pin — a new agent must not shrink the table.
        expect(HOOK_CONFIGS.length).toBeGreaterThanOrEqual(5);
    });

    for (const [name, config] of HOOK_CONFIGS) {
        it(`${name} names a push-mode default on every gated notify`, () => {
            // Per-command, not per-config: a config that grew a second notify
            // command with the flag on only one of them would still be broken.
            const notifyCommands = commandsOf(config).filter((c) => c.includes('--auto'));
            expect(notifyCommands.length).toBeGreaterThan(0);
            for (const command of notifyCommands) {
                expect(command).toContain(`--${PUSHMODE_DEFAULT_FLAG} normal`);
            }
        });
    }
});

// Drop-in TS source artifacts (pi extension, opencode plugin) embed the same
// NOTIFY_CMD but are not JSON — same quiet-default guard, at the string level.
// Derived from the module like HOOK_CONFIGS: a new drop-in joins by itself.
const ARTIFACT_SOURCES = Object.entries(templates)
    .filter(([name]) => /_(EXTENSION|PLUGIN)$/.test(name)) as [string, string][];

describe('templates.ts: drop-in artifacts survive the quiet default', () => {
    it('every drop-in artifact is covered here', () => {
        // Two today (pi extension, opencode plugin) — a floor, not a pin.
        expect(ARTIFACT_SOURCES.length).toBeGreaterThanOrEqual(2);
    });

    for (const [name, source] of ARTIFACT_SOURCES) {
        it(`${name} embeds the gated notify with a push-mode default`, () => {
            expect(source).toContain('command -v zeph');
            expect(source).toContain(`--${PUSHMODE_DEFAULT_FLAG} normal`);
        });
    }
});

// "No-hook REMOTE entry preamble ⟺ agent lacks a prompt hook" spans two files
// (rules here, registry in remote-hook.ts) — this is the only thing tying them.
// An agent that gains a prompt hook but keeps the preamble would end every
// NORMAL turn with zeph_ask, duplicating what its hook already does.
describe('templates.ts: rules agree with the remote-hook registry', () => {
    const RULES = Object.entries(templates).filter(([name]) => name.endsWith('_RULE')) as [string, string][];
    const NO_HOOK_MARKER = 'Entering REMOTE without a prompt hook';

    it('collects every rule', () => {
        expect(RULES.length).toBeGreaterThanOrEqual(9);
    });

    for (const [name, rule] of RULES) {
        const id = name.replace(/_RULE$/, '').toLowerCase();
        const hasPromptHook = (REMOTE_HOOK_AGENTS as readonly string[]).includes(id);
        it(`${name} ${hasPromptHook ? 'omits' : 'carries'} the no-hook REMOTE entry preamble`, () => {
            if (hasPromptHook) expect(rule).not.toContain(NO_HOOK_MARKER);
            else expect(rule).toContain(NO_HOOK_MARKER);
        });
    }
});
