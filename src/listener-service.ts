import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { LISTENER_LOG_FILE, resolveCliPath } from './listener-process.js';

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
