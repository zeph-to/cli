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
 * never false-match. Parity with the writer (listener.ts writeRemoteMarker)
 * is by construction — both sides share gate.ts remoteDigest/remoteMarkerPath.
 *
 * The marker is one-shot, but REMOTE is not: entry records the mode (gate.ts
 * touchRemoteActive) so it outlives the entry turn and survives compaction.
 * A prompt that reaches this hook without a marker was typed at the terminal —
 * the only way text becomes a prompt without one is the user's own keyboard,
 * since a phone answer to a zeph_ask comes back as a tool_result and never
 * reaches a prompt hook. The user is back, so the mode ends here (gate.ts
 * clearRemoteActive) and the hook says so once.
 *
 * No marker and no live state → null (silent no-op); this hook only ever adds
 * context and must never block a prompt.
 */
import { readFileSync, unlinkSync } from 'fs';
import {
  clearRemoteActive,
  isMuted,
  isRemoteActive,
  projectHash,
  remoteDigest,
  remoteMarkerPath,
  touchRemoteActive,
} from './gate.js';

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

This user message arrived from the user's phone via Zeph agent chat (verified by the listener — exact text match). The user is driving this session remotely and is NOT at the terminal. Enter sticky REMOTE mode now (CORE_RULES Rule 9): end EVERY response with \`zeph_ask\` (buttons + free-text) until the user exits — an exit signal (done/stop/exit), or a prompt they type at the terminal, which this hook will tell you about. Plain-text questions are invisible to them.`;

const ONE_WAY_CONTEXT = `# System note (Zeph remote-origin detect)

This user message arrived from the user's phone via Zeph agent chat (verified by the listener — exact text match), but ZEPH_HOOK_ID is not set, so two-way tools (zeph_ask/zeph_prompt/zeph_input) are unavailable. Make your final message self-contained — the completion push is the user's only feedback channel. If you have not already mentioned it this session, tell the user once that running \`npx @zeph-to/cli setup\` upgrades this into a two-way remote session (buttons + text replies from the phone).`;

/**
 * The first prompt a remote session's user types at the terminal. Emitted
 * once — the state is cleared with it, so every later terminal turn is a
 * silent no-op. Kept in step with the wording in
 * plugin/hooks/zeph-remote.sh.
 */
const EXIT_CONTEXT = `# System note (Zeph)

The user typed this prompt at the terminal, so this session has LEFT sticky REMOTE mode — answer normally (CORE_RULES Rule 4) and do not end this response with \`zeph_ask\` just to keep the loop alive. Rule 3 still holds: if you actually ask the user something, ask it with \`zeph_ask\`. Re-entry is automatic the moment they send another message from their phone.`;

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
  // `cwd` keys every state file, so without it there is nothing to look up.
  if (!cwd) return null;

  // Mute outranks everything (Rule 12) — stay silent and leave both the marker
  // and the state untouched (the next inject overwrites the marker anyway).
  if (isMuted(cwd)) return null;

  const emit = (additionalContext: string): string =>
    JSON.stringify({
      hookSpecificOutput: { hookEventName: HOOK_EVENT_NAME[agent], additionalContext },
    });

  // Exactly one additionalContext per invocation, and the verdict decides
  // which: 'phone' enters, 'keyboard' leaves, 'unclear' says nothing and
  // leaves the mode as it was.
  const origin = remoteOrigin(prompt, cwd, now);

  if (origin === 'phone') {
    if (!env.ZEPH_HOOK_ID) return emit(ONE_WAY_CONTEXT);
    // Only a two-way session has a mode to stay in — without zeph_ask there is
    // nothing for a later turn to be reminded of, so no state is recorded.
    touchRemoteActive(cwd, now);
    return emit(TWO_WAY_CONTEXT);
  }

  if (origin === 'keyboard' && env.ZEPH_HOOK_ID && isRemoteActive(cwd, now)) {
    clearRemoteActive(cwd);
    return emit(EXIT_CONTEXT);
  }
  return null;
};

/**
 * Where this prompt came from. Three verdicts, because "not a phone message"
 * and "typed at the terminal" are not the same claim and only the second may
 * end REMOTE:
 *
 * - `phone` — verified injection; the marker is consumed.
 * - `keyboard` — no marker this prompt could ever have matched, so the text
 *   came from the user. An empty prompt lands here too when nothing is
 *   pending: the listener never injects empty text.
 * - `unclear` — a fresh marker is sitting here unmatched, so a phone message
 *   is in flight (queued behind a long turn, or a digest the two sides compute
 *   differently). Reading that as "the user is back" would drop them out of
 *   REMOTE while they are still holding the phone, with no answerable push
 *   left — the quiet failure Rule 4 calls worse than light spam.
 *
 * A stale marker is deleted on sight and reads as `keyboard`; junk in the file
 * can never match anything, so it says nothing about who typed and reads the
 * same way. The bash twin returns these as rc 0/1/2 (zeph-remote.sh
 * remote_origin_match).
 */
type RemoteOrigin = 'phone' | 'keyboard' | 'unclear';

const remoteOrigin = (prompt: string, cwd: string, now: () => number): RemoteOrigin => {
  const hash = projectHash(cwd);
  if (!hash) return 'keyboard';
  const marker = remoteMarkerPath(hash);

  let content: string;
  try {
    content = readFileSync(marker, 'utf-8');
  } catch {
    return 'keyboard';
  }

  if (!prompt) return 'unclear';

  // Marker format: "<epochSec> <sha256hex>\n" (listener.ts writeRemoteMarker).
  const record = content.match(/^(\d+) ([0-9a-f]{64})\n?$/);
  if (!record) return 'keyboard';

  if (Math.floor(now() / 1000) - Number(record[1]) > FRESH_WINDOW_SEC) {
    // Stale markers are dead weight (can never flag) — delete on sight.
    try {
      unlinkSync(marker);
    } catch {
      /* best-effort housekeeping */
    }
    return 'keyboard';
  }

  if (remoteDigest(prompt) !== record[2]) return 'unclear';

  // Matched — consume the marker so an identical later prompt (e.g. typed
  // at the terminal) can't re-flag. Housekeeping is not the verdict: the
  // match is valid whether or not the delete lands.
  try {
    unlinkSync(marker);
  } catch {
    /* emit anyway — the match itself is valid */
  }
  return 'phone';
};
