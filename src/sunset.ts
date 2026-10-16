/**
 * Sunset — the date Zeph's agent features end, and what every command does
 * about it.
 *
 * Three kinds of command:
 *   - `agent`  needs the agent side of the server (sessions, terminal, setup).
 *              Before the date it prints one notice and carries on; from the
 *              date on it prints the "ended" line and exits 0 without a request.
 *   - `hook`   an agent harness calls it on every turn or tool call (Stop hook,
 *              prompt-submit hook, approval gate). It never prints a notice,
 *              and from the date on it exits 0 silently so a dead hook can
 *              neither spam a session nor hold an approval.
 *   - `data`   pushes, files, clipboard, channels, config, and `uninstall`.
 *              Untouched: the push API stays, and uninstall must always work.
 *
 * Pure on purpose: the clock is an argument, so tests pick the day.
 */
import { findAgentBySubcommand } from './remote-agents.js';

/** First UTC calendar day on which agent features no longer work. */
export const SUNSET_DATE = '2026-11-01';

const UNINSTALL_HINT = 'Run `zeph uninstall` to remove hooks and the background service.';
export const SUNSET_NOTICE = `Zeph agent features end on ${SUNSET_DATE} (00:00 UTC). ${UNINSTALL_HINT}`;
export const SUNSET_ENDED = `Zeph agent features ended on ${SUNSET_DATE}. ${UNINSTALL_HINT}`;

/** True from the start of SUNSET_DATE (UTC) onward — the day itself counts as ended. */
export const isSunset = (now: Date): boolean => now.toISOString().slice(0, 10) >= SUNSET_DATE;

export type CommandKind = 'agent' | 'hook' | 'data';

type Args = Record<string, string | boolean>;

/** Commands that exist for the agent features, whatever their flags. */
const AGENT_COMMANDS: ReadonlySet<string> = new Set([
  'install', 'setup', 'verify', 'send', 'rename', 'forget', 'sh', 'listener',
]);
// `zeph mcp` is not here: it hosts @zeph-to/mcp-server, which answers every
// tool with its own retirement text from the date on. Exiting here instead
// would show the MCP server as failed in every registered harness.

/**
 * What `ask --accepts-exit` prints from the date on: not answered, and NORMAL,
 * so an agent left in sticky REMOTE stops asking a phone nobody can answer.
 */
export const RETIRED_ASK_STATE = JSON.stringify({ answered: false, timedOut: false, zephState: 'NORMAL' });

/** `zeph listener` flags that only tear down or inspect — they must keep working to clean up. */
const LISTENER_CLEANUP_FLAGS = ['stop', 'uninstall-service', 'service-status'] as const;

export const classifyCommand = (command: string, args: Args): CommandKind => {
  // Run by the harness on every prompt; stdout IS the hook response.
  if (command === 'remote-hook') return 'hook';
  // The Stop hook (`notify --auto`), a push bound to an agent session, and the
  // pi/opencode extensions' high push (`--hook`, templates.ts).
  if (command === 'notify') {
    return args.auto === true || args.hook === true || typeof args.session === 'string' ? 'hook' : 'data';
  }
  // An approval gate calls `ask` without --accepts-exit; the agent's own
  // zeph_ask stand-in (pi) is the one that sets it.
  if (command === 'ask') return args['accepts-exit'] === true ? 'agent' : 'hook';
  if (command === 'listener') {
    return LISTENER_CLEANUP_FLAGS.some((flag) => args[flag] === true) ? 'data' : 'agent';
  }
  if (AGENT_COMMANDS.has(command) || findAgentBySubcommand(command)) return 'agent';
  return 'data';
};

export interface SunsetIO {
  now: () => Date;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

const liveIO = (): SunsetIO => ({
  now: () => new Date(),
  stdout: (line) => console.log(line),
  stderr: (line) => console.error(line),
});

/**
 * Run before any command handler. Returns an exit code when the command is
 * fully handled here (the caller exits with it, having made no request), or
 * null when the command should run as normal.
 */
export const sunsetGate = (command: string, args: Args, io: SunsetIO = liveIO()): number | null => {
  const kind = classifyCommand(command, args);
  if (kind === 'data') return null;
  const ended = isSunset(io.now());
  if (kind === 'hook') return ended ? 0 : null;
  io.stderr(ended ? SUNSET_ENDED : SUNSET_NOTICE);
  if (!ended) return null;
  // `ask` keeps its contract: one JSON line, exit 1 for "not answered".
  if (command === 'ask') {
    io.stdout(RETIRED_ASK_STATE);
    return 1;
  }
  return 0;
};
