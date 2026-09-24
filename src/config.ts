import { execFileSync } from 'child_process';
import { readFileSync, writeFileSync, mkdirSync, chmodSync } from 'fs';
import { homedir } from 'os';
import { basename, dirname, isAbsolute, join } from 'path';

export const CONFIG_DIR = join(homedir(), '.zeph');
export const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

export interface ZephConfig {
  apiKey?: string;
  hookId?: string;
  baseUrl?: string;
  wsUrl?: string;
  deviceId?: string;
  /** `false` stops the listener holding the Mac awake on AC (`caffeinate -s`). README § Listener Options. */
  keepAwake?: boolean;
}

export const resolvedEnv = (key: string, env: NodeJS.ProcessEnv = process.env): string | undefined => {
  const val = env[key];
  return val && !val.startsWith('${') ? val : undefined;
};

/**
 * The two-way hook id: `ZEPH_HOOK_ID` when it carries a real value, else
 * `hookId` from ~/.zeph/config.json — what `zeph setup` writes. The plugin's
 * gate.sh `zeph_hook_id` and the MCP server resolve it in the same order.
 */
export const resolveHookId = (env: NodeJS.ProcessEnv = process.env): string | undefined =>
  resolvedEnv('ZEPH_HOOK_ID', env) || loadConfig().hookId;

/** tmux session options the listener reads before falling back to parsing the name (listener `parseSessionName`). */
export const SESSION_PROJECT_OPTION = '@zeph_project';
export const SESSION_LABEL_OPTION = '@zeph_session_label';

/** The repo a directory belongs to: `key` names the main checkout, `linked` says the directory is in a linked worktree. */
export interface Checkout {
  key: string;
  linked: boolean;
}

/** `git rev-parse` for `checkoutOf`, swappable in tests. */
const revParse = (dir: string): string => execFileSync(
  'git',
  ['-C', dir, 'rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir', '--git-dir'],
  { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 },
);

/**
 * Which checkout `dir` is in, from one `git rev-parse`; null outside git.
 *
 * Inside a linked worktree `--show-toplevel` is the worktree itself, so its
 * name is not the repo's. The common dir is `<main checkout>/.git` from every
 * worktree, and differs from the git dir only in a linked one. A common dir not
 * named `.git` (bare-repo layout, submodule, `--separate-git-dir`) has no
 * checkout to be named for, so the toplevel's own name stands and nothing is
 * called linked — those worktrees keep reading as their own projects.
 *
 * Anything but three absolute paths is "outside git": a git too old for
 * `--path-format` echoes it back as an unknown flag and exits 0, which would
 * otherwise shift every answer by one and name the repo `--path-format=absolute`.
 *
 * The timeout is for the listener's sweep worker, which calls this for every
 * new pane cwd: a repo on a hung network mount must cost one sweep a moment,
 * not stop inventory. A timeout reads as "outside git" — nothing is regrouped.
 */
export const checkoutOf = (dir: string, run: (dir: string) => string = revParse): Checkout | null => {
  let lines: string[];
  try {
    lines = run(dir).trim().split('\n');
  } catch {
    return null;
  }
  if (lines.length !== 3 || !lines.every(isAbsolute)) return null;
  const [top, common, gitDir] = lines;
  if (basename(common) !== '.git') return { key: basename(top), linked: false };
  const key = basename(dirname(common));
  return key ? { key, linked: common !== gitDir } : null;
};

/**
 * The project and label a `zeph-<tail>` session groups under, when its name
 * does not say so — null when it does (the whole tail is the project).
 *
 * The one rule behind both the wrapper's session options and the listener's
 * correction of sessions started without them, so the two never disagree.
 * A tail starting `<repo>-` splits there, unless the rest is the wrapper's
 * `-2`/`-3` family counter. Any session in a linked worktree belongs to its
 * repo, whatever the worktree is called.
 */
export const groupOf = (tail: string, checkout: Checkout | null): { project: string; label: string } | null => {
  if (!checkout) return null;
  const { key, linked } = checkout;
  const rest = tail.startsWith(`${key}-`) ? tail.slice(key.length + 1) : '';
  if (rest && !/^\d+$/.test(rest)) return { project: key, label: rest };
  return linked ? { project: key, label: tail } : null;
};

// Per-agent project-dir env vars, in precedence order. Deliberately NOT part
// of the remote-agent registry: Cursor/Windsurf carry project-dir envs but
// are not remote-controllable via tmux — the two tables have different
// membership.
export const PROJECT_DIR_ENV_VARS = ['CLAUDE_PROJECT_DIR', 'CURSOR_PROJECT_DIR', 'WINDSURF_PROJECT_DIR'] as const;

/** First set project-dir env (unresolved `${VAR}` placeholders ignored), else cwd. */
export const detectProjectDir = (): string => {
  for (const key of PROJECT_DIR_ENV_VARS) {
    const val = resolvedEnv(key);
    if (val) return val;
  }
  return process.cwd();
};

let warnedAboutBrokenConfig = false;

/**
 * An absent config is normal — plenty of commands run on `--key` alone, so it
 * stays silent. A config that exists but does not parse is not normal, and used
 * to be indistinguishable from absent: every value silently became undefined,
 * so `zeph` behaved as if the file had never been written. That is precisely
 * how "it isn't reading my config" looks from the outside, with nothing
 * anywhere to say otherwise. Say it, on stderr, and carry on with defaults.
 */
export const loadConfig = (): ZephConfig => {
  let raw: string;
  try {
    raw = readFileSync(CONFIG_FILE, 'utf-8');
  } catch {
    return {};
  }
  try {
    return JSON.parse(raw) as ZephConfig;
  } catch (err) {
    // Once per process: a single command can call loadConfig several times
    // (handleVerify and resolveHookId both do), and repeating the same two
    // lines four times reads like four separate problems.
    if (!warnedAboutBrokenConfig) {
      warnedAboutBrokenConfig = true;
      const reason = err instanceof Error ? err.message : String(err);
      console.error(`zeph: ${CONFIG_FILE} is not valid JSON, so it is being ignored (${reason}).`);
      console.error('zeph: fix the file, or re-run `zeph install` to write a fresh one.');
    }
    return {};
  }
};

export const saveConfig = (config: ZephConfig): void => {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  // `mode` only applies on creation — tighten pre-existing installs too,
  // since this file holds the API key.
  chmodSync(CONFIG_FILE, 0o600);
};

export const VERSION = (() => {
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'));
    return pkg.version as string;
  } catch {
    return '0.0.0';
  }
})();
