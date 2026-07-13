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
import { existsSync, readFileSync, statSync } from 'fs';
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

/** Resolve a state file: current location first, then user-owned legacy /tmp. */
const findStateFile = (kind: 'muted' | 'pushmode', hash: string): string | null => {
  const current = join(stateDir(), `${kind}-${hash}`);
  if (existsSync(current)) return current;
  const legacy = `/tmp/zeph-${kind}-${hash}`;
  return ownedByCurrentUser(legacy) ? legacy : null;
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

/** True when the user ran /zeph-mute for this project. */
export const isMuted = (dir: string): boolean => {
  const hash = projectHash(dir);
  return hash !== null && findStateFile('muted', hash) !== null;
};

/** The user's session push-mode dial (/zeph-quiet | /zeph-loud), default normal. */
export const readPushMode = (dir: string): GatePushMode => {
  const hash = projectHash(dir);
  if (!hash) return 'normal';
  const file = findStateFile('pushmode', hash);
  if (!file) return 'normal';
  try {
    return normalizePushMode(readFileSync(file, 'utf-8').replace(/\s+/g, ''));
  } catch {
    return 'normal';
  }
};
