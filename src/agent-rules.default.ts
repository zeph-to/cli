/**
 * Bundled default detection rules — the fallback when no OTA manifest
 * has been fetched (or the fetched one fails validation, §S7).
 *
 * Rule content is authored HERE, from observation of each agent's UI.
 * Do not import or transcribe rules from third-party projects: the
 * bundled set is original work under this repo's license.
 *
 * Claude Code observations behind these rules (UI as of mid-2026):
 * - While running, the status line shows an "esc to interrupt" hint
 *   next to the spinner/progress text.
 * - Blocking dialogs (permission requests, plan approval, question
 *   forms) render a numbered/arrow-key option list with "esc" as the
 *   cancel affordance and Enter as the confirm affordance.
 * - At rest, the input box renders a `❯` prompt and the footer offers
 *   "? for shortcuts".
 * - The transcript viewer (ctrl+o) overlays the pane; the agent may
 *   still be working underneath, so it must not change the state.
 *
 * codex/gemini start with no rules: they report `unknown` until a
 * vetted rule set ships via OTA. Honest ignorance beats guessed state.
 */
import { ENGINE_VERSION, type DetectionManifest } from './agent-state.js';

export const DEFAULT_MANIFEST: DetectionManifest = {
    engineVersion: ENGINE_VERSION,
    version: '2026.07.04.2',
    agents: {
        claude: [
            {
                // Transcript / verbose-output overlay: freeze state.
                id: 'claude-transcript-overlay',
                state: 'unknown',
                priority: 1000,
                skipStateUpdate: true,
                any: [
                    { contains: ['showing detailed transcript'] },
                    { contains: ['ctrl+o to toggle'] },
                ],
            },
            {
                // Blocking dialog: an option list waiting on the user.
                // "esc" alone is ambiguous (working shows "esc to
                // interrupt"), so require a selection affordance too.
                id: 'claude-blocked-dialog',
                state: 'blocked',
                priority: 900,
                contains: ['esc'],
                any: [
                    { contains: ['do you want'] },
                    { contains: ['enter to select'] },
                    { contains: ['enter to confirm'] },
                    { contains: ['to navigate'] },
                ],
                not: [{ contains: ['esc to interrupt'] }],
            },
            {
                id: 'claude-working-interrupt-hint',
                state: 'working',
                priority: 800,
                contains: ['esc to interrupt'],
            },
            {
                // Newer CC skins drop the "esc to interrupt" hint; the
                // live token counter on the spinner line
                // ("✶ Churning… (1m 2s · ↓ 1.2k tokens)") only renders
                // while the agent is actually running.
                id: 'claude-working-token-counter',
                state: 'working',
                priority: 790,
                regex: ['[↓↑]\\s?[\\d.,]+k? tokens'],
            },
            {
                // Elapsed-time spinner suffix ("(12s · ..." / "(1m 2s ·")
                // — second fallback for skins that hide the token counter
                // early in a turn.
                id: 'claude-working-elapsed-spinner',
                state: 'working',
                priority: 780,
                regex: ['…\\s*\\((?:\\d+m )?\\d+s ·'],
            },
            {
                // Idle prompt: `❯` at line start in the tail, with no
                // dialog affordances around it.
                id: 'claude-idle-prompt',
                state: 'idle',
                priority: 600,
                regex: ['^\\s*❯'],
                not: [
                    { contains: ['do you want'] },
                    { contains: ['enter to select'] },
                ],
            },
            {
                // Fallback idle signal when the prompt glyph is themed
                // away: the shortcuts footer only renders at rest.
                id: 'claude-idle-shortcuts-footer',
                state: 'idle',
                priority: 500,
                contains: ['? for shortcuts'],
            },
        ],
        codex: [],
        gemini: [],
    },
};
