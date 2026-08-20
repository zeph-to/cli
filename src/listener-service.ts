import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { LISTENER_LOG_FILE, resolveCliPath, runningListenerPid, stopListener } from './listener-process.js';

/**
 * The listener as an OS service: a launchd LaunchAgent that starts it at user
 * login so the phone's picker is populated without anyone opening a terminal.
 *
 * Until this existed, the only thing that ever started the daemon was
 * `zeph cc` (wrapper.ts → spawnListenerDetached). After a reboot that means an
 * empty picker until the user happens to launch an agent — the machine is
 * online, the past sessions are on disk, and the app says "no agents".
 *
 * Two constraints shape this file:
 *
 * 1. **Node builtins only.** wrapper.ts reads `serviceInstalled()` on the
 *    `zeph cc` hot path, and the same rule that keeps listener.ts out of
 *    wrapper.ts (ws + the crypto stack on every agent launch) applies here.
 *    listener-process.ts is the one import, and it is builtins-only too.
 *
 * 2. **Everything the job needs is resolved at install time and baked into
 *    the plist.** launchd hands a job `/usr/bin:/bin:/usr/sbin:/sbin` and
 *    nothing else — no shell profile, no homebrew prefix. `verifyTmux()`
 *    (listener.ts) exits 127 when tmux is not on PATH, so a plist without a
 *    baked PATH produces a service that dies at every login and is restarted
 *    forever by KeepAlive. The interpreter is baked for the same reason.
 */

/** Reverse-DNS launchd label. Lives on the user's machine once installed —
 *  renaming it orphans every plist already out there. */
export const SERVICE_LABEL = 'to.zeph.listener';

/** `package.json` engines floor. A node below this starts and dies. */
const MIN_NODE_MAJOR = 18;

/** What launchd itself puts on PATH. Ours is prepended, never replaces this. */
const LAUNCHD_BASE_PATH = ['/usr/bin', '/bin', '/usr/sbin', '/sbin'];

/** Interpreters to try when the CLI's own install prefix has none. */
const NODE_FALLBACKS = ['/opt/homebrew/bin/node', '/usr/local/bin/node'];

/** tmux locations to try when the shell can't answer `command -v`. */
const TMUX_FALLBACKS = ['/opt/homebrew/bin/tmux', '/usr/local/bin/tmux', '/usr/bin/tmux'];

/** Version-manager roots. A node under one of these is gone after the next
 *  upgrade, which silently breaks the service months later. */
const VERSION_MANAGER_DIRS = ['/.nvm/', '/.fnm/', '/.volta/', '/.nodenv/', '/.asdf/', '/.n/'];

export interface ServiceSpec {
    readonly nodePath: string;
    readonly cliPath: string;
    readonly tmuxPath: string;
    readonly logPath: string;
    /** PATH baked into the job: tmux dir, node dir, then launchd's own. */
    readonly pathEnv: string;
}

export type SpecResolution =
    | { readonly ok: true; readonly value: ServiceSpec; readonly warning?: string }
    | { readonly ok: false; readonly reason: string };

/** The machine facts spec resolution needs, injectable so tests describe a
 *  machine instead of inheriting the developer's own. */
export interface ServiceEnv {
    readonly exists: (path: string) => boolean;
    /** Major version of the node at `path`, or null when it won't run. */
    readonly nodeMajor: (path: string) => number | null;
    /** Absolute tmux path from the invoking shell's PATH, or null. */
    readonly whichTmux: () => string | null;
    readonly cliPath: () => string | null;
}

export interface ServiceStatus {
    readonly supported: boolean;
    readonly installed: boolean;
    readonly label: string;
    readonly plistPath: string;
    /** Read back from the installed plist — null when nothing is installed. */
    readonly nodePath: string | null;
    readonly cliPath: string | null;
    readonly pathEnv: string | null;
    /** Programs the plist names that are no longer on disk. The shape a node
     *  upgrade leaves behind: registered, listed by launchctl, unable to run. */
    readonly missing: readonly string[];
}

/** launchd only exists on macOS. Every other platform is an explicit refusal,
 *  never a quiet success. */
export const serviceSupported = (): boolean => process.platform === 'darwin';

export const servicePlistPath = (): string =>
    join(homedir(), 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`);

export const serviceInstalled = (): boolean => existsSync(servicePlistPath());

/** launchd domain target for this user's GUI session. */
export const serviceTarget = (): string => `gui/${process.getuid?.() ?? 0}/${SERVICE_LABEL}`;

export const serviceDomain = (): string => `gui/${process.getuid?.() ?? 0}`;

const nodeMajorOf = (path: string): number | null => {
    try {
        const out = execFileSync(path, ['-v'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
        const major = Number(out.trim().replace(/^v/, '').split('.')[0]);
        return Number.isFinite(major) ? major : null;
    } catch {
        return null;
    }
};

const whichTmuxFromShell = (): string | null => {
    try {
        // `/bin/sh -c` on purpose: `which` in an interactive zsh resolves the
        // user's tmux *alias*, which is not a path we can hand to launchd.
        const out = execFileSync('/bin/sh', ['-c', 'command -v tmux'], {
            encoding: 'utf-8',
            stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
        return out.startsWith('/') ? out : null;
    } catch {
        return null;
    }
};

export const defaultServiceEnv: ServiceEnv = {
    exists: existsSync,
    nodeMajor: nodeMajorOf,
    whichTmux: whichTmuxFromShell,
    cliPath: resolveCliPath,
};

/**
 * The interpreter that owns the CLI's install prefix.
 *
 * A global install lives at `<prefix>/lib/node_modules/@zeph-to/cli/dist/cli.js`
 * and its node is `<prefix>/bin/node`. Preferring it keeps the plist internally
 * consistent; picking whichever node happens to exist can pair a homebrew
 * interpreter with a `~/.local` install — a combination that works on the
 * machine that wrote it and breaks on the next one.
 */
const prefixNodeFor = (cliPath: string): string | null => {
    const marker = '/lib/node_modules/';
    const at = cliPath.indexOf(marker);
    if (at < 0) return null;
    return join(cliPath.slice(0, at), 'bin', 'node');
};

const isVersionManaged = (nodePath: string): boolean =>
    VERSION_MANAGER_DIRS.some((dir) => nodePath.includes(dir));

const dedupe = (values: string[]): string[] => [...new Set(values)];

/**
 * Decide what to bake into the plist, or say why we can't. Nothing is written
 * and nothing is registered — a caller that gets `ok: false` has touched
 * nothing on the machine.
 */
export const resolveServiceSpec = (env: ServiceEnv = defaultServiceEnv): SpecResolution => {
    const cliPath = env.cliPath();
    if (!cliPath) {
        return { ok: false, reason: 'could not resolve the zeph CLI entry (dist/cli.js) to run' };
    }

    const tmuxPath = env.whichTmux() ?? TMUX_FALLBACKS.find(env.exists) ?? null;
    if (!tmuxPath) {
        return { ok: false, reason: 'tmux not found — install tmux first (the listener drives tmux panes)' };
    }

    const prefixNode = prefixNodeFor(cliPath);
    const candidates = dedupe([...(prefixNode ? [prefixNode] : []), ...NODE_FALLBACKS, process.execPath]);
    const nodePath = candidates.find((c) => env.exists(c) && (env.nodeMajor(c) ?? 0) >= MIN_NODE_MAJOR);
    if (!nodePath) {
        return { ok: false, reason: `no node >= ${MIN_NODE_MAJOR} found to run the listener with` };
    }

    const pathEnv = dedupe([dirname(tmuxPath), dirname(nodePath), ...LAUNCHD_BASE_PATH]).join(':');
    const spec: ServiceSpec = { nodePath, cliPath, tmuxPath, logPath: LISTENER_LOG_FILE, pathEnv };

    if (isVersionManaged(nodePath)) {
        return {
            ok: true,
            value: spec,
            warning:
                `${nodePath} belongs to a node version manager — the service will stop working ` +
                `after a node upgrade. Re-run \`zeph listener --install-service\` if that happens ` +
                `(\`zeph verify\` reports it).`,
        };
    }
    return { ok: true, value: spec };
};

const escapeXml = (value: string): string =>
    value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export const renderLaunchAgentPlist = (spec: ServiceSpec): string => {
    const s = (value: string): string => `<string>${escapeXml(value)}</string>`;
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    ${s(SERVICE_LABEL)}
    <key>ProgramArguments</key>
    <array>
        ${s(spec.nodePath)}
        ${s(spec.cliPath)}
        <string>listener</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>
    <key>ThrottleInterval</key>
    <integer>30</integer>
    <key>StandardOutPath</key>
    ${s(spec.logPath)}
    <key>StandardErrorPath</key>
    ${s(spec.logPath)}
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        ${s(spec.pathEnv)}
        <key>ZEPH_LISTENER_SERVICE</key>
        <string>1</string>
    </dict>
</dict>
</plist>
`;
};

const unescapeXml = (value: string): string =>
    value.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/** ProgramArguments strings, in order, from an installed plist. */
const readProgramArguments = (xml: string): string[] => {
    const block = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(xml);
    if (!block) return [];
    return [...block[1].matchAll(/<string>([\s\S]*?)<\/string>/g)].map((m) => unescapeXml(m[1]));
};

const readPathEnv = (xml: string): string | null => {
    const found = /<key>PATH<\/key>\s*<string>([\s\S]*?)<\/string>/.exec(xml);
    return found ? unescapeXml(found[1]) : null;
};

const NOT_INSTALLED = {
    installed: false,
    nodePath: null,
    cliPath: null,
    pathEnv: null,
    missing: [] as readonly string[],
} as const;

/**
 * What is registered on this machine and whether it can still run. The single
 * source `verify`, `--service-status` and the `zeph cc` branch all read, so
 * they can never disagree about whether a service is installed.
 */
export const serviceStatus = (): ServiceStatus => {
    const plistPath = servicePlistPath();
    const base = { supported: serviceSupported(), label: SERVICE_LABEL, plistPath };
    if (!existsSync(plistPath)) return { ...base, ...NOT_INSTALLED };

    let xml = '';
    try {
        xml = readFileSync(plistPath, 'utf-8');
    } catch {
        return { ...base, ...NOT_INSTALLED, installed: true };
    }
    const [nodePath = null, cliPath = null] = readProgramArguments(xml);
    const missing = [nodePath, cliPath].filter((p): p is string => !!p && !existsSync(p));
    return { ...base, installed: true, nodePath, cliPath, pathEnv: readPathEnv(xml), missing };
};

// ─── Service operations ──────────────────────────────────────────────

/**
 * Side effects the service operations need, injectable so tests can drive the
 * launchd sequence without a launchd.
 */
export interface ServiceOpDeps {
    readonly supported: () => boolean;
    readonly resolveSpec: () => SpecResolution;
    /** PID of a listener running right now, or null. */
    readonly runningPid: () => number | null;
    readonly stopListener: (pid: number) => Promise<boolean>;
    readonly launchctl: (args: string[]) => { ok: boolean; stderr: string };
    readonly settle: (ms: number) => Promise<void>;
}

export type ServiceOpResult =
    | { readonly ok: true; readonly notes: readonly string[] }
    | { readonly ok: false; readonly reason: string; readonly notes: readonly string[] };

/** How long to give launchd to get the daemon up before calling the install
 *  a failure. Generous: the daemon writes its pid file as its first act. */
const POST_INSTALL_SETTLE_MS = 3_000;

const runLaunchctl = (args: string[]): { ok: boolean; stderr: string } => {
    try {
        execFileSync('launchctl', args, { stdio: ['ignore', 'ignore', 'pipe'] });
        return { ok: true, stderr: '' };
    } catch (err) {
        const stderr = (err as { stderr?: Buffer }).stderr?.toString().trim() ?? '';
        return { ok: false, stderr };
    }
};

export const defaultServiceOpDeps: ServiceOpDeps = {
    supported: serviceSupported,
    resolveSpec: () => resolveServiceSpec(),
    runningPid: runningListenerPid,
    stopListener,
    launchctl: runLaunchctl,
    settle: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

const UNSUPPORTED =
    'the login-time service needs launchd — only macOS is supported today ' +
    '(run `zeph listener` yourself, or keep using `zeph cc` to autostart it)';

/**
 * Register the LaunchAgent and get the daemon running under it.
 *
 * The order is load-bearing, not incidental:
 *
 * - **Any listener already running is stopped first.** `handleListener` exits
 *   **0** when it finds another listener alive, and it only does so quietly
 *   under ZEPH_LISTENER_AUTOSTART, which a launchd job does not have. So a
 *   kickstart into a live `zeph cc` daemon produces a clean exit, and
 *   `KeepAlive:{SuccessfulExit:false}` reads a clean exit as "stay down" —
 *   for the whole login session. `launchctl list` shows the job; nothing runs.
 * - **Nothing is written until the spec resolves.** A refusal leaves the
 *   machine exactly as it was.
 * - **The daemon is confirmed alive afterwards.** Without that check the
 *   failure above ships silently.
 */
export const installService = async (deps: ServiceOpDeps = defaultServiceOpDeps): Promise<ServiceOpResult> => {
    const notes: string[] = [];
    if (!deps.supported()) return { ok: false, reason: UNSUPPORTED, notes };

    const spec = deps.resolveSpec();
    if (!spec.ok) return { ok: false, reason: spec.reason, notes };
    if (spec.warning) notes.push(spec.warning);

    const running = deps.runningPid();
    if (running !== null) {
        await deps.stopListener(running);
        notes.push(`stopped the listener already running (pid ${running}) so launchd can own it`);
    }

    // Nothing to unload before a first install — that failure is the normal path.
    deps.launchctl(['bootout', serviceTarget()]);

    const plistPath = servicePlistPath();
    mkdirSync(dirname(plistPath), { recursive: true });
    writeFileSync(plistPath, renderLaunchAgentPlist(spec.value));
    notes.push(`wrote ${plistPath}`);

    const bootstrap = deps.launchctl(['bootstrap', serviceDomain(), plistPath]);
    if (!bootstrap.ok) {
        return { ok: false, reason: `launchctl bootstrap failed: ${bootstrap.stderr || 'no detail'}`, notes };
    }
    // Best-effort: a job disabled by an earlier `launchctl disable` (ours never
    // calls it, but a user's hand might have) would otherwise refuse to start.
    deps.launchctl(['enable', serviceTarget()]);

    const kickstart = deps.launchctl(['kickstart', '-k', serviceTarget()]);
    if (!kickstart.ok) {
        return { ok: false, reason: `launchctl kickstart failed: ${kickstart.stderr || 'no detail'}`, notes };
    }

    await deps.settle(POST_INSTALL_SETTLE_MS);
    if (deps.runningPid() === null) {
        return {
            ok: false,
            reason: `the service was registered but the listener did not stay up — see ${LISTENER_LOG_FILE}`,
            notes,
        };
    }
    return { ok: true, notes };
};

/** Unregister the job and remove the plist. Doing only one of the two leaves
 *  either a running service with no plist or a plist launchd ignores. */
export const uninstallService = async (deps: ServiceOpDeps = defaultServiceOpDeps): Promise<ServiceOpResult> => {
    const notes: string[] = [];
    const plistPath = servicePlistPath();
    if (!existsSync(plistPath)) return { ok: true, notes: ['service not installed — nothing to remove'] };

    deps.launchctl(['bootout', serviceTarget()]);
    notes.push(`unloaded ${SERVICE_LABEL}`);
    rmSync(plistPath, { force: true });
    notes.push(`removed ${plistPath}`);
    return { ok: true, notes };
};

/**
 * Stop the service until the next login.
 *
 * `bootout` and not `disable`: disable writes to launchd's persistent disabled
 * database, survives logins, and leaves no obvious way back — a `--stop` that
 * quietly becomes permanent. Session-scoped is what stopping should mean.
 */
export const stopService = (deps: ServiceOpDeps = defaultServiceOpDeps): ServiceOpResult => {
    const result = deps.launchctl(['bootout', serviceTarget()]);
    if (!result.ok) return { ok: false, reason: `launchctl bootout failed: ${result.stderr || 'no detail'}`, notes: [] };
    return { ok: true, notes: [`unloaded ${SERVICE_LABEL} — it comes back at the next login`] };
};

/** Restart the service in place. `-k` kills the running instance first, so this
 *  is also how a version-drifted daemon is replaced. */
export const restartService = (deps: ServiceOpDeps = defaultServiceOpDeps): ServiceOpResult => {
    const result = deps.launchctl(['kickstart', '-k', serviceTarget()]);
    if (!result.ok) {
        return { ok: false, reason: `launchctl kickstart failed: ${result.stderr || 'no detail'}`, notes: [] };
    }
    return { ok: true, notes: [`restarted ${SERVICE_LABEL}`] };
};

// ─── Health ──────────────────────────────────────────────────────────

export interface ServiceHealthRow {
    readonly label: string;
    readonly state: 'pass' | 'warn' | 'fail';
}

/** The two live facts a health check can't read off the plist. */
export interface ServiceProbe {
    /** Can a process started with this PATH find tmux? */
    readonly tmuxOnPath: (pathEnv: string) => boolean;
    /** Is launchd actually running the job right now? */
    readonly loaded: () => boolean;
}

const pathHasTmux = (pathEnv: string): boolean =>
    pathEnv.split(':').filter(Boolean).some((dir) => existsSync(join(dir, 'tmux')));

const jobIsLoaded = (): boolean => runLaunchctl(['print', serviceTarget()]).ok;

export const defaultServiceProbe: ServiceProbe = { tmuxOnPath: pathHasTmux, loaded: jobIsLoaded };

/**
 * Why this exists: every way the service breaks leaves it looking installed.
 * `launchctl list` shows the job whether or not its interpreter still exists,
 * and a PATH without tmux makes the daemon exit 127 at every login while the
 * registration sits there unchanged. None of that is visible without asking.
 */
export const serviceHealthChecks = (
    status: ServiceStatus,
    probe: ServiceProbe = defaultServiceProbe,
): ServiceHealthRow[] => {
    if (!status.supported) return [];
    if (!status.installed) {
        return [
            {
                label: 'no login-time service — after a reboot the phone sees nothing until you run `zeph cc` '
                    + '(add it: zeph listener --install-service)',
                state: 'warn',
            },
        ];
    }

    const rows: ServiceHealthRow[] = [{ label: `${status.label} registered`, state: 'pass' }];

    if (status.missing.length > 0) {
        rows.push({
            label: `service points at ${status.missing.join(', ')} — gone. Re-run: zeph listener --install-service`,
            state: 'fail',
        });
    } else {
        rows.push({ label: 'service programs still exist', state: 'pass' });
    }

    // launchd hands the job its own bare PATH, so tmux has to come from what
    // the plist baked in. Without it verifyTmux() exits 127 at every login.
    if (status.pathEnv && probe.tmuxOnPath(status.pathEnv)) {
        rows.push({ label: 'tmux reachable from the service PATH', state: 'pass' });
    } else {
        rows.push({
            label: 'tmux NOT on the service PATH — the daemon exits 127 at login. '
                + 'Re-run: zeph listener --install-service',
            state: 'fail',
        });
    }

    rows.push(
        probe.loaded()
            ? { label: 'launchd is running the job', state: 'pass' }
            : { label: 'registered but launchd is not running it — it returns at the next login', state: 'warn' },
    );

    return rows;
};
