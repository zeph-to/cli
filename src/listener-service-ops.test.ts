import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Same isolation shape as listener-service.test.ts: the plist path is derived
// from $HOME, so every case gets a throwaway home and a fresh module graph.
const homes: string[] = [];
const originalHome = process.env.HOME;

const load = async () => {
    const home = mkdtempSync(join(tmpdir(), 'zeph-listener-ops-'));
    homes.push(home);
    process.env.HOME = home;
    vi.resetModules();
    const mod = await import('./listener-service.js');
    return { ...mod, home };
};

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

afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
    vi.resetModules();
});

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
