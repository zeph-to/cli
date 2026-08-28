/**
 * Push-gate decision — the portable half of the Zeph Stop-hook logic.
 *
 * `decidePush` is the TS twin of `plugin/hooks/gate.sh` (zeph-to/plugin).
 * Both implementations are locked to the same semantics by the shared
 * vector file `src/fixtures/gate-vectors.json` (vendored from the plugin
 * repo's canonical copy via `npm run sync:plugin`): the bash side and this
 * side run the exact same cases in their CIs, so a semantic change to one
 * that isn't mirrored in the other fails a build. Edit them together.
 *
 * Ordering is contractual (encoded as named vectors):
 *   1. alreadyAsked wins over EVERYTHING — even loud (dedup beats the dial).
 *   2. priority is high iff marker === 'high', decided BEFORE the mode
 *      switch, so quiet+high and loud+high both push at high priority.
 *   3. quiet → only a high marker pushes; loud → always push; normal →
 *      marker overrides the heuristic (skip → silent, push/high → push),
 *      no marker → push iff toolCount ≥ 2 AND nonReadonlyCount > 0
 *      (the B1 read-only floor).
 */
import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

export type GateMarker = 'skip' | 'push' | 'high' | 'none';
export type GatePushMode = 'quiet' | 'loud' | 'normal';

export interface GateInput {
  /** Total tool_use blocks this turn. */
  toolCount: number;
  /** Tools that are NOT read-only (Read/Grep/Glob). */
  nonReadonlyCount: number;
  /** A zeph_ask/zeph_prompt already notified this turn. */
  alreadyAsked: boolean;
  marker: GateMarker;
  pushMode: GatePushMode;
}

export interface GateVerdict {
  push: boolean;
  priority: 'high' | 'normal';
}

/**
 * "Assume real work" defaults for hooks that can't supply turn facts
 * (most non-Claude agents pass no counts): in normal mode the push still
 * fires — preserving the historical always-push behavior of the dumb
 * hooks — while quiet/loud now work everywhere.
 *
 * These defaults cannot rescue a quiet dial: quiet only lets a `high` marker
 * through, and a hook with no turn facts has no marker either. That is why
 * the installed templates pass `--pushmode-default normal` (see templates.ts)
 * — for them quiet is not a lower volume, it is permanent silence.
 */
export const GATE_DEFAULTS = {
  toolCount: 2,
  nonReadonlyCount: 1,
  alreadyAsked: false,
} as const;

export const normalizeMarker = (raw: string | undefined): GateMarker =>
  raw === 'skip' || raw === 'push' || raw === 'high' ? raw : 'none';

export const normalizePushMode = (raw: string | undefined): GatePushMode =>
  raw === 'quiet' || raw === 'loud' ? raw : 'normal';

export const decidePush = (input: GateInput): GateVerdict => {
  if (input.alreadyAsked) return { push: false, priority: 'normal' };

  const priority = input.marker === 'high' ? 'high' : 'normal';

  if (input.pushMode === 'quiet') return { push: input.marker === 'high', priority };
  if (input.pushMode === 'loud') return { push: true, priority };

  if (input.marker === 'skip') return { push: false, priority };
  if (input.marker === 'push' || input.marker === 'high') return { push: true, priority };
  return { push: input.toolCount >= 2 && input.nonReadonlyCount > 0, priority };
};

// ── Per-project gate state (mute + push-mode dial) ───────────────
//
// State lives under ${XDG_STATE_HOME:-~/.local/state}/zeph — a per-user
// directory. It used to live at predictable names in world-writable /tmp,
// where any local user could pre-create a victim's mute file (and sticky
// /tmp makes that file un-deletable by the victim). Legacy /tmp files are
// still honored during the migration window, but only when owned by the
// current user, which neutralizes planted files.
//
// The plugin's bash hooks key these files off `cksum` of the project dir;
// shelling out to the same `cksum` here (instead of a pure-TS CRC)
// guarantees hash parity with every already-written file.

export const stateDir = (): string =>
  join(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'zeph');

const ownedByCurrentUser = (path: string): boolean => {
  try {
    const st = statSync(path);
    return typeof process.getuid !== 'function' || st.uid === process.getuid();
  } catch {
    return false;
  }
};

/**
 * Resolve a state file: current location first, then user-owned legacy /tmp,
 * then — for `pushmode` only — the machine-wide default written by
 * `/zeph-quiet --global`. Mirrors plugin/hooks/gate.sh zeph_state_present,
 * including the deliberate absence of a global mute (see the comment there).
 */
const findStateFile = (kind: 'muted' | 'pushmode', hash: string): string | null => {
  const current = join(stateDir(), `${kind}-${hash}`);
  if (existsSync(current)) return current;
  const legacy = `/tmp/zeph-${kind}-${hash}`;
  if (ownedByCurrentUser(legacy)) return legacy;
  if (kind !== 'pushmode') return null;
  const globalDefault = join(stateDir(), 'pushmode-default');
  return existsSync(globalDefault) ? globalDefault : null;
};

export const projectHash = (dir: string): string | null => {
  try {
    const raw = execFileSync('cksum', { input: dir, encoding: 'utf-8' });
    return raw.split(' ')[0] || null;
  } catch {
    return null;
  }
};

// ── Remote-origin marker (ADR-0002) ──────────────────────────────
//
// The listener records every phone→pane text injection as a one-shot
// marker file; a prompt-submit hook (Claude Code plugin's zeph-remote.sh,
// or `zeph remote-hook` for Gemini/Codex) consumes it on an exact-text
// match and flags the prompt as remote-originated. Writer and TS reader
// share these two helpers so their bytes can never diverge; the bash
// reader is held to the same semantics by the plugin's test suite.

/** Marker path for a project hash: `<stateDir>/remote-<cksum(projectDir)>`. */
export const remoteMarkerPath = (hash: string): string => join(stateDir(), `remote-${hash}`);

/**
 * sha256 over the ASCII-only-trimmed text — recorded at inject time,
 * recomputed at prompt submit. Trim strips ONLY ' \t\r\n\f\v', NOT
 * String.trim(): trim() also eats Unicode whitespace (U+00A0 etc.) that
 * the bash reader keeps, and both sides must hash identical bytes.
 */
export const remoteDigest = (text: string): string =>
  createHash('sha256')
    .update(text.replace(/^[ \t\r\n\f\v]+|[ \t\r\n\f\v]+$/g, ''))
    .digest('hex');

// ── Sticky REMOTE state ──────────────────────────────────────────
//
// The marker above is a ONE-SHOT entry signal, consumed the moment a prompt
// matches it. REMOTE outlives that turn — the user can answer from the phone
// and then type at the terminal — so the mode itself lives in
// `remote-active-<hash>`, holding the epoch second it was last confirmed.
// Keeping it in a file is also what lets it survive context compaction.
// Bash twin: plugin/hooks/gate.sh zeph_remote_active / zeph_remote_touch.
//
// Deliberately not routed through findStateFile. That helper also honors a
// legacy /tmp copy so files written by older versions keep working; this kind
// has never had a /tmp writer, so the branch could only ever match something
// stale — and since the refresh always writes the XDG path, such a file would
// never expire.

/**
 * How long REMOTE stays live without a refresh. Generous on purpose: the state
 * is refreshed on every phone prompt and every answered `zeph_ask`, so it only
 * has to outlive a working session, never an idle user. It is the backstop and
 * not the usual exit — a terminal-typed prompt, a Done-like answer and the
 * model's `<!-- zeph: exit -->` all delete the file outright. What none of them
 * covers is a session that simply died: there is no SessionEnd hook, so without
 * a TTL a crash or Ctrl-C would latch REMOTE forever.
 */
export const REMOTE_TTL_SEC = 14400;

/** State path for a project hash: `<stateDir>/remote-active-<cksum(dir)>`. */
export const remoteStatePath = (hash: string): string =>
  join(stateDir(), `remote-active-${hash}`);

/**
 * True while REMOTE is live for this project. State that is expired or
 * unparseable is deleted on sight — the same housekeeping a stale entry
 * marker gets, since state that can never flag again is dead weight.
 */
export const isRemoteActive = (dir: string, now: () => number = Date.now): boolean => {
  const hash = projectHash(dir);
  if (!hash) return false;
  const file = remoteStatePath(hash);
  let raw: string;
  try {
    raw = readFileSync(file, 'utf-8').trim();
  } catch {
    return false;
  }
  // Digits only, matching the bash twin's `case "$ts" in *[!0-9]*)`. Number()
  // alone is looser than that test — it reads '1e10' as ten billion, so a file
  // bash would sweep would live on here as a far-future timestamp.
  const fresh = /^\d+$/.test(raw) && Math.floor(now() / 1000) - Number(raw) <= REMOTE_TTL_SEC;
  if (!fresh) {
    try {
      unlinkSync(file);
    } catch {
      /* best-effort housekeeping */
    }
  }
  return fresh;
};

/**
 * Enter REMOTE, or push its expiry back. Best-effort by contract: the prompt
 * hooks that call this must never fail a prompt over state IO.
 */
export const touchRemoteActive = (dir: string, now: () => number = Date.now): void => {
  const hash = projectHash(dir);
  if (!hash) return;
  try {
    mkdirSync(stateDir(), { recursive: true });
    writeFileSync(remoteStatePath(hash), `${Math.floor(now() / 1000)}\n`);
  } catch {
    /* a hook must never fail on state IO */
  }
};

/**
 * Leave REMOTE. Best-effort like its twin: an absent file is success, and the
 * caller is a hook with its own job to finish. Bash twin: gate.sh
 * zeph_remote_clear.
 */
export const clearRemoteActive = (dir: string): void => {
  const hash = projectHash(dir);
  if (!hash) return;
  try {
    unlinkSync(remoteStatePath(hash));
  } catch {
    /* already gone, or unwritable — the prompt still goes through */
  }
};

/** True when the user ran /zeph-mute for this project. */
export const isMuted = (dir: string): boolean => {
  const hash = projectHash(dir);
  return hash !== null && findStateFile('muted', hash) !== null;
};

/**
 * Push mode for an install that has never set a dial. The twin is
 * plugin/hooks/gate.sh's missing-5th-argument default; the shared vectors
 * never reach either one (every vector passes pushMode explicitly), so both
 * sides pin it in their own tests.
 */
export const PUSHMODE_DEFAULT: GatePushMode = 'quiet';

/**
 * `notify` flag naming the push mode to assume when the project has no dial.
 * Written by templates.ts into every hook-driven agent's completion hook and
 * read back in cli.ts — shared so the two can never drift apart.
 */
export const PUSHMODE_DEFAULT_FLAG = 'pushmode-default';

/**
 * `notify` flags carrying the turn's tool counts. Only the drop-in artifacts
 * (pi extension, opencode plugin) can supply them — they are the only installed
 * hooks that see per-tool events. Shared for the same reason as the flag above:
 * templates.ts writes them, cli.ts reads them, and a rename on one side alone
 * would send `gateCount` back to GATE_DEFAULTS with nothing to show for it.
 */
export const TOOL_COUNT_FLAG = 'tools';
export const NONREADONLY_COUNT_FLAG = 'nonreadonly';

/**
 * The user's session push-mode dial (/zeph-quiet | /zeph-loud | /zeph-normal).
 *
 * Three failure shapes, three answers — "no dial" is the only one that gets
 * the quiet default:
 *   - no dial file          → `fallback` (PUSHMODE_DEFAULT unless the caller
 *                             overrides it with --pushmode-default)
 *   - unusable dial file    → normal. A missing project hash, an unreadable
 *                             file, or a garbled/empty value is a broken
 *                             setting, and resolving breakage to silence
 *                             leaves the user with no symptom to debug. The
 *                             point of the new default is quiet, not hidden
 *                             errors.
 *   - readable dial file    → whatever it says.
 */
export const readPushMode = (
  dir: string,
  fallback: GatePushMode = PUSHMODE_DEFAULT,
): GatePushMode => {
  const hash = projectHash(dir);
  if (!hash) return 'normal';
  const file = findStateFile('pushmode', hash);
  if (!file) return fallback;
  try {
    return normalizePushMode(readFileSync(file, 'utf-8').replace(/\s+/g, ''));
  } catch {
    return 'normal';
  }
};

/**
 * Push mode for a `--auto` notify: the user's dial if they set one, otherwise
 * the mode named by `--pushmode-default`, otherwise the built-in quiet.
 *
 * The dial outranks the flag deliberately. The flag exists so an agent whose
 * hook cannot participate in the heuristic still pushes out of the box; if it
 * outranked the dial, `/zeph-quiet` would silently do nothing for that agent.
 *
 * A flag value that isn't one of the three modes resolves to `normal`, not to
 * the quiet default — same rule as a garbled dial file. A caller that passes
 * nonsense has a bug, and answering a bug with silence hides it.
 */
export const autoPushMode = (dir: string, flag: string | boolean | undefined): GatePushMode =>
  readPushMode(dir, typeof flag === 'string' ? normalizePushMode(flag) : PUSHMODE_DEFAULT);
