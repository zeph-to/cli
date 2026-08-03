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
