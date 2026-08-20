import { describe, expect, it } from 'vitest';
import { serviceHealthChecks, type ServiceStatus } from './listener-service.js';

/**
 * What `zeph verify` can tell the user about the login-time service.
 *
 * Every row here exists because of a failure that is otherwise invisible: the
 * job stays in `launchctl list` while pointing at an interpreter a node
 * upgrade deleted, or while carrying a PATH without tmux — which makes the
 * daemon exit 127 at every login and look, from the outside, like a service
 * that is installed and fine.
 */
const statusFor = (over: Partial<ServiceStatus> = {}): ServiceStatus => ({
    supported: true,
    installed: true,
    label: 'to.zeph.listener',
    plistPath: '/Users/someone/Library/LaunchAgents/to.zeph.listener.plist',
    nodePath: '/usr/local/bin/node',
    cliPath: '/usr/local/lib/node_modules/@zeph-to/cli/dist/cli.js',
    pathEnv: '/opt/homebrew/bin:/usr/bin:/bin',
    missing: [],
    ...over,
});

const healthyProbe = { tmuxOnPath: () => true, loaded: () => true };

const states = (rows: ReadonlyArray<{ state: string }>): string[] => rows.map((r) => r.state);

describe('serviceHealthChecks', () => {
    it('passes every row on a healthy install', () => {
        const rows = serviceHealthChecks(statusFor(), healthyProbe);
        expect(rows.length).toBeGreaterThan(0);
        expect(states(rows)).not.toContain('fail');
        expect(states(rows)).not.toContain('warn');
    });

    // Not installed is a warning, not a failure — the service is optional and
    // `zeph cc` still autostarts the daemon.
    it('warns rather than fails when no service is installed', () => {
        const rows = serviceHealthChecks(statusFor({ installed: false }), healthyProbe);
        expect(states(rows)).toContain('warn');
        expect(states(rows)).not.toContain('fail');
    });

    it('says nothing to check on a platform without launchd', () => {
        expect(serviceHealthChecks(statusFor({ supported: false }), healthyProbe)).toEqual([]);
    });

    // The node-upgrade failure mode.
    it('fails and names the program a stale plist points at', () => {
        const rows = serviceHealthChecks(statusFor({ missing: ['/usr/local/bin/node'] }), healthyProbe);
        const failed = rows.filter((r) => r.state === 'fail');
        expect(failed).toHaveLength(1);
        expect(failed[0].label).toContain('/usr/local/bin/node');
    });

    // The exit-127 landmine: verifyTmux kills the daemon immediately when tmux
    // is not on the PATH the plist baked in.
    it('fails when the baked PATH cannot reach tmux', () => {
        const rows = serviceHealthChecks(statusFor(), { ...healthyProbe, tmuxOnPath: () => false });
        expect(rows.some((r) => r.state === 'fail' && /tmux/.test(r.label))).toBe(true);
    });

    // Registered but not loaded: what `--stop` leaves behind until the next
    // login, and also what a permanently-given-up KeepAlive looks like.
    it('warns when the plist exists but launchd is not running the job', () => {
        const rows = serviceHealthChecks(statusFor(), { ...healthyProbe, loaded: () => false });
        expect(rows.some((r) => r.state === 'warn' && /launchd|loaded|running/i.test(r.label))).toBe(true);
    });
});
