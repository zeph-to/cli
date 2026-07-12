/**
 * `zeph remote-hook <agent>` — prompt-submit hook handler for agents whose
 * hooks the cli installs directly: Gemini CLI (BeforeAgent) and Codex CLI
 * (UserPromptSubmit). TS twin of the Claude Code plugin's
 * hooks/zeph-remote.sh (ADR-0002).
 *
 * The listener records every phone→pane text injection as a one-shot
 * marker (`remote-<hash>` in the zeph state dir) holding the epoch second
 * and sha256 of the injected text. When the submitted prompt matches that
 * record — same project (cksum of the cwd), fresh (≤15 min), and
 * byte-identical trimmed text — the hook emits additionalContext telling
 * the model the user is driving the session from their phone, which enters
 * sticky REMOTE mode (Rule 9).
 *
 * Detection is exact: a terminal keystroke racing a phone message can
 * never false-match. No match → null (silent no-op); this hook only ever
 * adds context and must never block a prompt. Parity with the writer
 * (listener.ts writeRemoteMarker) is by construction — both sides share
 * gate.ts remoteDigest/remoteMarkerPath.
 */
import { readFileSync, unlinkSync } from 'fs';
import { isMuted, projectHash, remoteDigest, remoteMarkerPath } from './gate.js';

/** Agents whose prompt-submit hooks this command serves. Claude Code is
 *  NOT here — its hook ships with the plugin (hooks/zeph-remote.sh). */
export const REMOTE_HOOK_AGENTS = ['gemini', 'codex'] as const;
export type RemoteHookAgent = (typeof REMOTE_HOOK_AGENTS)[number];

/** Per-agent hookEventName echoed back in hookSpecificOutput — each CLI
 *  validates it against the event that invoked the hook. */
const HOOK_EVENT_NAME: Record<RemoteHookAgent, string> = {
  gemini: 'BeforeAgent',
  codex: 'UserPromptSubmit',
};

/**
 * Freshness window (seconds), same as the bash reader: deliberately
 * generous — false positives are already impossible without an exact hash
 * match; its only job is to stop the SAME text typed at the terminal much
 * later from re-flagging. It must survive the real gap between injection
 * and prompt submit (a message sent mid-turn queues until the turn ends).
 */
const FRESH_WINDOW_SEC = 900;

const TWO_WAY_CONTEXT = `# System note (Zeph remote-origin detect)

This user message arrived from the user's phone via Zeph agent chat (verified by the listener — exact text match). The user is driving this session remotely and is NOT at the terminal. Enter sticky REMOTE mode now (CORE_RULES Rule 9): end EVERY response with \`zeph_ask\` (buttons + free-text) until the user sends an exit signal (done/stop/exit). Plain-text questions are invisible to them.`;

const ONE_WAY_CONTEXT = `# System note (Zeph remote-origin detect)

This user message arrived from the user's phone via Zeph agent chat (verified by the listener — exact text match), but ZEPH_HOOK_ID is not set, so two-way tools (zeph_ask/zeph_prompt/zeph_input) are unavailable. Make your final message self-contained — the completion push is the user's only feedback channel. If you have not already mentioned it this session, tell the user once that running \`npx @zeph-to/cli setup\` upgrades this into a two-way remote session (buttons + text replies from the phone).`;

export const isRemoteHookAgent = (raw: string): raw is RemoteHookAgent =>
  (REMOTE_HOOK_AGENTS as readonly string[]).includes(raw);

/**
 * Core of the hook: match the stdin payload against the marker and return
 * the JSON to print, or null for a silent no-op. Never throws.
 */
export const runRemoteHook = (
  agent: RemoteHookAgent,
  stdin: string,
  env: NodeJS.ProcessEnv = process.env,
  now: () => number = Date.now,
): string | null => {
  let prompt: string;
  let cwd: string;
  try {
    const input = JSON.parse(stdin) as { prompt?: unknown; cwd?: unknown };
    prompt = typeof input.prompt === 'string' ? input.prompt : '';
    cwd = typeof input.cwd === 'string' ? input.cwd : '';
  } catch {
    return null;
  }
  if (!prompt || !cwd) return null;

  // Mute outranks everything (Rule 12) — stay silent and leave the marker
  // unconsumed (the next inject overwrites it anyway).
  if (isMuted(cwd)) return null;

  const hash = projectHash(cwd);
  if (!hash) return null;
  const marker = remoteMarkerPath(hash);

  let content: string;
  try {
    content = readFileSync(marker, 'utf-8');
  } catch {
    return null;
  }

  // Marker format: "<epochSec> <sha256hex>\n" (listener.ts writeRemoteMarker).
  const record = content.match(/^(\d+) ([0-9a-f]{64})\n?$/);
  if (!record) return null;

  if (Math.floor(now() / 1000) - Number(record[1]) > FRESH_WINDOW_SEC) {
    // Stale markers are dead weight (can never flag) — delete on sight.
    try {
      unlinkSync(marker);
    } catch {
      /* best-effort housekeeping */
    }
    return null;
  }

  if (remoteDigest(prompt) !== record[2]) return null;

  // Matched — consume the marker so an identical later prompt (e.g. typed
  // at the terminal) can't re-flag.
  try {
    unlinkSync(marker);
  } catch {
    /* emit anyway — the match itself is valid */
  }

  const ctx = env.ZEPH_HOOK_ID ? TWO_WAY_CONTEXT : ONE_WAY_CONTEXT;
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: HOOK_EVENT_NAME[agent],
      additionalContext: ctx,
    },
  });
};
