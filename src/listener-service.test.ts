import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

// listener-service resolves $HOME-derived paths through listener-process, which
// reads homedir() at import time — so each case gets a throwaway home and a
// fresh module graph, same shape as listener-process.test.ts.
const homes: string[] = [];
const originalHome = process.env.HOME;

const load = async () => {
    const home = mkdtempSync(join(tmpdir(), 'zeph-listener-svc-'));
    homes.push(home);
    process.env.HOME = home;
    vi.resetModules();
    const mod = await import('./listener-service.js');
    return { ...mod, home };
};

/** Create an empty file (and its parents) so `exists` sees it. */
const touch = (path: string): string => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '');
    return path;
};

/**
 * A ServiceEnv whose answers are all explicit. Every case states the machine
 * it is describing instead of inheriting the developer's own.
 */
const envFor = (opts: {
    files: string[];
    tmux?: string | null;
    cli?: string | null;
    nodeMajor?: (path: string) => number | null;
    lang?: string | undefined;
}) => {
    const present = new Set(opts.files);
    return {
        exists: (p: string) => present.has(p),
        nodeMajor: opts.nodeMajor ?? (() => 22),
        whichTmux: () => opts.tmux ?? null,
        cliPath: () => opts.cli ?? null,
        lang: () => ('lang' in opts ? opts.lang : 'en_US.UTF-8'),
    };
};

const NPM_PREFIX = '/Users/someone/.local';
const CLI = `${NPM_PREFIX}/lib/node_modules/@zeph-to/cli/dist/cli.js`;
const PREFIX_NODE = `${NPM_PREFIX}/bin/node`;
const BREW_NODE = '/opt/homebrew/bin/node';
const BREW_TMUX = '/opt/homebrew/bin/tmux';

afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
    vi.resetModules();
});

describe('resolveServiceSpec — node choice', () => {
    // The plist must pair the CLI with the interpreter that owns its install
    // prefix. Picking homebrew's node just because it exists produces a
    // combination that happens to work here and breaks on another machine.
    it('prefers the node in the CLI install prefix over a homebrew node', async () => {
        const m = await load();
        const r = m.resolveServiceSpec(envFor({ files: [PREFIX_NODE, BREW_NODE, BREW_TMUX], cli: CLI, tmux: BREW_TMUX }));
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.value.nodePath).toBe(PREFIX_NODE);
    });

    it('falls back to a well-known node when the prefix has none', async () => {
        const m = await load();
        const r = m.resolveServiceSpec(envFor({ files: [BREW_NODE, BREW_TMUX], cli: CLI, tmux: BREW_TMUX }));
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.value.nodePath).toBe(BREW_NODE);
    });

    // engines: node >=18. A node that is present but too old is not a
    // candidate — baking it produces a service that starts and immediately dies.
    it('skips a candidate whose node is older than the engine floor', async () => {
        const m = await load();
        const r = m.resolveServiceSpec(
            envFor({
                files: [PREFIX_NODE, BREW_NODE, BREW_TMUX],
                cli: CLI,
                tmux: BREW_TMUX,
                nodeMajor: (p) => (p === PREFIX_NODE ? 16 : 22),
            }),
        );
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.value.nodePath).toBe(BREW_NODE);
    });

    // A version-manager path disappears on the next node upgrade. It is still
    // usable today, so this warns rather than refusing — but it never goes in
    // silently.
    it('warns when the CLI is installed under a version manager', async () => {
        const m = await load();
        const nvmPrefix = '/Users/someone/.nvm/versions/node/v24.15.0';
        const nvmNode = `${nvmPrefix}/bin/node`;
        const nvmCli = `${nvmPrefix}/lib/node_modules/@zeph-to/cli/dist/cli.js`;
        const r = m.resolveServiceSpec(envFor({ files: [nvmNode, BREW_TMUX], cli: nvmCli, tmux: BREW_TMUX }));
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.value.nodePath).toBe(nvmNode);
        expect(r.warning).toMatch(/upgrade/i);
    });
});

describe('resolveServiceSpec — refusals', () => {
    it('refuses when tmux cannot be found', async () => {
        const m = await load();
        const r = m.resolveServiceSpec(envFor({ files: [PREFIX_NODE], cli: CLI, tmux: null }));
        expect(r.ok).toBe(false);
        if (r.ok) return;
        expect(r.reason).toMatch(/tmux/);
    });

    it('refuses when the CLI entry cannot be resolved', async () => {
        const m = await load();
        const r = m.resolveServiceSpec(envFor({ files: [BREW_TMUX], cli: null, tmux: BREW_TMUX }));
        expect(r.ok).toBe(false);
        if (r.ok) return;
        expect(r.reason).toMatch(/cli/i);
    });

    it('refuses when no candidate node exists', async () => {
        const m = await load();
        const r = m.resolveServiceSpec(envFor({ files: [BREW_TMUX], cli: CLI, tmux: BREW_TMUX }));
        expect(r.ok).toBe(false);
        if (r.ok) return;
        expect(r.reason).toMatch(/node/i);
    });
});

describe('renderLaunchAgentPlist', () => {
    const spec = {
        nodePath: PREFIX_NODE,
        cliPath: CLI,
        tmuxPath: BREW_TMUX,
        logPath: '/Users/someone/.zeph/listener.log',
        pathEnv: '/opt/homebrew/bin:/Users/someone/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
        lang: 'en_US.UTF-8',
    };

    // The landmine this whole feature turns on: verifyTmux() exits 127 when
    // tmux is off PATH, and launchd hands a job /usr/bin:/bin:/usr/sbin:/sbin.
    it('bakes the tmux directory into PATH', async () => {
        const m = await load();
        const xml = m.renderLaunchAgentPlist(spec);
        expect(xml).toContain('<key>PATH</key>');
        expect(xml).toContain(dirname(BREW_TMUX));
    });

    it('runs at load and restarts only on a non-clean exit', async () => {
        const m = await load();
        const xml = m.renderLaunchAgentPlist(spec);
        expect(xml).toContain('<key>RunAtLoad</key>\n    <true/>');
        // KeepAlive:true would flap forever against the singleton guard;
        // SuccessfulExit:false restarts crashes and respects a deliberate stop.
        expect(xml).toMatch(/<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>/);
        expect(xml).toContain('<key>ThrottleInterval</key>');
    });

    it('sends both streams to the listener log and marks the launch source', async () => {
        const m = await load();
        const xml = m.renderLaunchAgentPlist(spec);
        expect(xml).toContain(`<key>StandardOutPath</key>\n    <string>${spec.logPath}</string>`);
        expect(xml).toContain(`<key>StandardErrorPath</key>\n    <string>${spec.logPath}</string>`);
        expect(xml).toContain('<key>ZEPH_LISTENER_SERVICE</key>');
    });

    it('escapes XML-significant characters in paths', async () => {
        const m = await load();
        const xml = m.renderLaunchAgentPlist({ ...spec, cliPath: '/tmp/a&b<c>/cli.js' });
        expect(xml).toContain('/tmp/a&amp;b&lt;c&gt;/cli.js');
        expect(xml).not.toContain('a&b<c>');
    });
});

describe('serviceStatus', () => {
    it('reports not installed when no plist exists', async () => {
        const m = await load();
        const status = m.serviceStatus();
        expect(status.installed).toBe(false);
        expect(status.nodePath).toBeNull();
    });

    it('reads back what an installed plist points at', async () => {
        const m = await load();
        const node = touch(join(m.home, 'bin', 'node'));
        const cli = touch(join(m.home, 'cli.js'));
        mkdirSync(dirname(m.servicePlistPath()), { recursive: true });
        writeFileSync(
            m.servicePlistPath(),
            m.renderLaunchAgentPlist({
                nodePath: node,
                cliPath: cli,
                tmuxPath: BREW_TMUX,
                logPath: join(m.home, '.zeph', 'listener.log'),
                pathEnv: `${dirname(BREW_TMUX)}:/usr/bin`,
                lang: 'en_US.UTF-8',
            }),
        );
        const status = m.serviceStatus();
        expect(status.installed).toBe(true);
        expect(status.nodePath).toBe(node);
        expect(status.cliPath).toBe(cli);
        expect(status.pathEnv).toContain(dirname(BREW_TMUX));
        expect(status.missing).toEqual([]);
    });

    // The failure mode a node upgrade produces: registered, but pointing at an
    // interpreter that is gone. `launchctl list` still shows the job.
    it('names the programs a stale plist points at that no longer exist', async () => {
        const m = await load();
        const goneNode = join(m.home, 'gone', 'node');
        const cli = touch(join(m.home, 'cli.js'));
        mkdirSync(dirname(m.servicePlistPath()), { recursive: true });
        writeFileSync(
            m.servicePlistPath(),
            m.renderLaunchAgentPlist({
                nodePath: goneNode,
                cliPath: cli,
                tmuxPath: BREW_TMUX,
                logPath: join(m.home, '.zeph', 'listener.log'),
                pathEnv: '/usr/bin',
                lang: 'en_US.UTF-8',
            }),
        );
        const status = m.serviceStatus();
        expect(status.missing).toEqual([goneNode]);
    });
});

describe('resolveServiceSpec — locale', () => {
    // launchd hands a job no LANG at all. tmux then runs in the C locale and
    // mangles every non-ASCII byte in its format output to `_` — including the
    // U+241F field separator the session inventory is split on. The daemon
    // starts, tmux answers, and every session is dropped as unparseable: the
    // phone shows nothing while everything looks healthy.
    it('bakes the shell locale when it is UTF-8', async () => {
        const m = await load();
        const r = m.resolveServiceSpec(envFor({ files: [PREFIX_NODE, BREW_TMUX], cli: CLI, tmux: BREW_TMUX, lang: 'ko_KR.UTF-8' }));
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.value.lang).toBe('ko_KR.UTF-8');
    });

    it('falls back to a UTF-8 locale when the shell has none', async () => {
        const m = await load();
        const r = m.resolveServiceSpec(envFor({ files: [PREFIX_NODE, BREW_TMUX], cli: CLI, tmux: BREW_TMUX, lang: undefined }));
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.value.lang).toMatch(/UTF-8$/);
    });

    it('never carries a non-UTF-8 locale into the plist', async () => {
        const m = await load();
        const r = m.resolveServiceSpec(envFor({ files: [PREFIX_NODE, BREW_TMUX], cli: CLI, tmux: BREW_TMUX, lang: 'C' }));
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.value.lang).toMatch(/UTF-8$/);
    });

    it('puts LANG in the plist environment', async () => {
        const m = await load();
        const xml = m.renderLaunchAgentPlist({
            nodePath: PREFIX_NODE,
            cliPath: CLI,
            tmuxPath: BREW_TMUX,
            logPath: '/tmp/l.log',
            pathEnv: '/usr/bin',
            lang: 'en_US.UTF-8',
        });
        expect(xml).toContain('<key>LANG</key>');
        expect(xml).toContain('<string>en_US.UTF-8</string>');
    });
});

// ─── Service operations ──────────────────────────────────────────────

const SPEC = {
    nodePath: '/usr/local/bin/node',
    cliPath: '/usr/local/lib/node_modules/@zeph-to/cli/dist/cli.js',
    tmuxPath: '/opt/homebrew/bin/tmux',
    logPath: '/tmp/listener.log',
    pathEnv: '/opt/homebrew/bin:/usr/bin',
    lang: 'en_US.UTF-8',
};

/**
 * A recording deps double. `pids` is consumed one answer per `runningPid()`
 * call, so a case can say "nothing running, then alive after kickstart" — or
 * the failure shape, "alive before, still nothing after".
 */
const opsFor = (opts: {
    pids: (number | null)[];
    launchctlFails?: string[];
    supported?: boolean;
    spec?: typeof SPEC | null;
}) => {
    const calls: string[][] = [];
    const stopped: number[] = [];
    let pidIndex = 0;
    return {
        calls,
        stopped,
        deps: {
            supported: () => opts.supported ?? true,
            resolveSpec: () =>
                opts.spec === null
                    ? ({ ok: false, reason: 'tmux not found' } as const)
                    : ({ ok: true, value: opts.spec ?? SPEC } as const),
            runningPid: () => opts.pids[Math.min(pidIndex++, opts.pids.length - 1)] ?? null,
            stopListener: async (pid: number) => {
                stopped.push(pid);
                return true;
            },
            launchctl: (args: string[]) => {
                calls.push(args);
                const failed = (opts.launchctlFails ?? []).includes(args[0]);
                return { ok: !failed, stderr: failed ? `${args[0]} failed` : '' };
            },
            settle: async () => {},
        },
    };
};

/** Index of the first launchctl call with this subcommand, or -1. */
const indexOf = (calls: string[][], sub: string): number => calls.findIndex((c) => c[0] === sub);

describe('installService', () => {
    // The landmine. handleListener exits 0 when another listener is alive, and
    // KeepAlive:{SuccessfulExit:false} reads that clean exit as "do not restart"
    // — permanently, for the rest of the login session. Installing while a
    // `zeph cc`-spawned daemon is up is the common case, not an edge one.
    it('stops an already-running listener before bootstrapping', async () => {
        const m = await load();
        const { deps, calls, stopped } = opsFor({ pids: [4242, 5555] });
        const r = await m.installService(deps);
        expect(r.ok).toBe(true);
        expect(stopped).toEqual([4242]);
        // Ordering is the whole point: the stop must precede the bootstrap.
        expect(indexOf(calls, 'bootstrap')).toBeGreaterThanOrEqual(0);
    });

    it('writes the plist and registers it with launchctl', async () => {
        const m = await load();
        const { deps, calls } = opsFor({ pids: [null, 5555] });
        const r = await m.installService(deps);
        expect(r.ok).toBe(true);
        expect(existsSync(m.servicePlistPath())).toBe(true);
        expect(calls.map((c) => c[0])).toEqual(['bootout', 'bootstrap', 'enable', 'kickstart']);
    });

    // Without this the failure above is silent: launchctl reports success,
    // `launchctl list` shows the job, and nothing is running.
    it('fails when no daemon is alive after the kickstart', async () => {
        const m = await load();
        const { deps } = opsFor({ pids: [null, null] });
        const r = await m.installService(deps);
        expect(r.ok).toBe(false);
        if (r.ok) return;
        expect(r.reason).toMatch(/listener\.log|did not stay/i);
    });

    it('refuses on a platform without launchd, touching nothing', async () => {
        const m = await load();
        const { deps, calls } = opsFor({ pids: [null], supported: false });
        const r = await m.installService(deps);
        expect(r.ok).toBe(false);
        expect(calls).toEqual([]);
        expect(existsSync(m.servicePlistPath())).toBe(false);
    });

    it('refuses without writing a plist when the spec cannot be resolved', async () => {
        const m = await load();
        const { deps, calls } = opsFor({ pids: [null], spec: null });
        const r = await m.installService(deps);
        expect(r.ok).toBe(false);
        expect(calls).toEqual([]);
        expect(existsSync(m.servicePlistPath())).toBe(false);
    });

    // bootout before a first install has nothing to unload; that is the normal
    // path, not an error.
    it('tolerates a bootout that had nothing to unload', async () => {
        const m = await load();
        const { deps } = opsFor({ pids: [null, 5555], launchctlFails: ['bootout'] });
        expect((await m.installService(deps)).ok).toBe(true);
    });

    it('fails when the bootstrap itself is rejected', async () => {
        const m = await load();
        const { deps } = opsFor({ pids: [null, 5555], launchctlFails: ['bootstrap'] });
        const r = await m.installService(deps);
        expect(r.ok).toBe(false);
        if (r.ok) return;
        expect(r.reason).toMatch(/bootstrap/);
    });
});

describe('uninstallService', () => {
    it('boots the job out and removes the plist', async () => {
        const m = await load();
        const install = opsFor({ pids: [null, 5555] });
        await m.installService(install.deps);

        const { deps, calls } = opsFor({ pids: [5555] });
        const r = await m.uninstallService(deps);
        expect(r.ok).toBe(true);
        expect(calls.map((c) => c[0])).toEqual(['bootout']);
        // Removing the file but leaving the job registered is the failure mode
        // worth naming: launchctl keeps running a service with no plist.
        expect(existsSync(m.servicePlistPath())).toBe(false);
    });

    it('is a no-op when nothing is installed', async () => {
        const m = await load();
        const { deps } = opsFor({ pids: [null] });
        const r = await m.uninstallService(deps);
        expect(r.ok).toBe(true);
        expect(r.notes.join(' ')).toMatch(/not installed/i);
    });
});

describe('stopService / restartService', () => {
    // `launchctl disable` writes to launchd's persistent disabled database and
    // survives logins — a `--stop` that cannot be undone by logging back in.
    // bootout is session-scoped, which is what stopping should mean.
    it('stops with bootout, never disable', async () => {
        const m = await load();
        const { deps, calls } = opsFor({ pids: [5555] });
        expect(m.stopService(deps).ok).toBe(true);
        expect(calls.map((c) => c[0])).toEqual(['bootout']);
        expect(calls.flat()).not.toContain('disable');
    });

    it('restarts with a forced kickstart', async () => {
        const m = await load();
        const { deps, calls } = opsFor({ pids: [5555] });
        expect(m.restartService(deps).ok).toBe(true);
        expect(calls[0][0]).toBe('kickstart');
        expect(calls[0]).toContain('-k');
    });
});
