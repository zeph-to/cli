/**
 * Presence — is the user away from the terminal?
 *
 * The TS twin of `plugin/hooks/gate.sh` zeph_is_away (zeph-to/plugin): the
 * Claude Stop hook asks there, every `notify --auto` hook asks here, and both
 * must answer alike. The quiet dial silences routine pushes because the user is
 * watching the pane; an away user is not, so the answer becomes decidePush's
 * `away`. Keep the probe order and fallbacks in sync with the bash side — the
 * cases in presence.test.ts mirror its `away:` block in test-zeph-stop.sh.
 *
 * Threshold: ZEPH_AWAY_SEC seconds (default 300, `0` disables, anything that is
 * not a whole number of at most 9 digits falls back to the default). Probes,
 * first answer wins:
 *   1. inside tmux and no client attached to the server at all → away. Any
 *      attached client means someone is at a tmux terminal, so switching the
 *      one client between sessions must not read as leaving.
 *   2. not over SSH and ioreg reports HIDIdleTime (macOS) → that decides, and
 *      nothing below runs: tmux activity only sees keys typed into tmux, so a
 *      user reading a browser would look idle to it.
 *   3. inside tmux → the newest client_activity (SSH and non-macOS hosts).
 * Anything else is present: an unreadable signal must never add a push.
 */
import { spawnSync } from 'child_process';
import type { GateMarker, GatePushMode } from './gate.js';

const AWAY_SEC_DEFAULT = 300;
const PROBE_TIMEOUT_MS = 2000;

export interface PresenceDeps {
  env: NodeJS.ProcessEnv;
  /** stdout of a probe command, or null when it fails, is missing, or times out. */
  run: (cmd: string, args: string[]) => string | null;
  now: () => number;
}

const runProbe = (cmd: string, args: string[]): string | null => {
  const r = spawnSync(cmd, args, {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: PROBE_TIMEOUT_MS,
  });
  return r.status === 0 ? (r.stdout ?? '') : null;
};

const defaultDeps = (): PresenceDeps => ({ env: process.env, run: runProbe, now: Date.now });

const awayThresholdSec = (raw: string | undefined): number =>
  raw !== undefined && /^\d{1,9}$/.test(raw) ? Number(raw) : AWAY_SEC_DEFAULT;

const hidIdleSec = (ioregOut: string | null): number | null => {
  const match = ioregOut?.match(/"HIDIdleTime" = (\d+)/);
  return match ? Math.floor(Number(match[1]) / 1e9) : null;
};

const newestActivitySec = (clientsOut: string): number | null => {
  const stamps = clientsOut.split('\n').filter((l) => /^\d+$/.test(l)).map(Number);
  return stamps.length > 0 ? Math.max(...stamps) : null;
};

export const isAway = (deps: PresenceDeps = defaultDeps()): boolean => {
  const threshold = awayThresholdSec(deps.env.ZEPH_AWAY_SEC);
  if (threshold === 0) return false;

  // null = not in tmux, or no server answered; '' = a server with no clients.
  const clients = deps.env.TMUX ? deps.run('tmux', ['list-clients', '-F', '#{client_activity}']) : null;
  if (clients !== null && clients.trim() === '') return true;

  if (!deps.env.SSH_CONNECTION) {
    // -r -k -d 1: just the IOHIDSystem node (~4 KB), not its ~380 KB subtree.
    const idle = hidIdleSec(deps.run('ioreg', ['-r', '-k', 'HIDIdleTime', '-d', '1', '-c', 'IOHIDSystem']));
    if (idle !== null) return idle >= threshold;
  }

  if (clients === null) return false;
  const newest = newestActivitySec(clients);
  if (newest === null) return false;
  return Math.floor(deps.now() / 1000) - newest >= threshold;
};

/**
 * Presence for decidePush, probed only where it can change the verdict: quiet
 * with no `high` marker is the one path that is otherwise silent.
 */
export const awayForGate = (
  pushMode: GatePushMode,
  marker: GateMarker,
  probe: () => boolean = isAway,
): boolean => pushMode === 'quiet' && marker !== 'high' && probe();
