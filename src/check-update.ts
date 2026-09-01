import { readFileSync } from 'fs';
import { VERSION } from './config.js';

// Compares installed versions against the npm registry. Pure read-only —
// never installs anything; just tells the user if a newer release exists.

const PACKAGES = ['@zeph-to/cli', '@zeph-to/mcp-server'] as const;

/** Fetch the `latest` dist-tag version for a package from the npm registry. */
const fetchLatest = async (pkg: string): Promise<string | null> => {
    try {
        const res = await fetch(`https://registry.npmjs.org/${pkg}/latest`, {
            headers: { Accept: 'application/json' },
            signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) return null;
        const json = await res.json() as { version?: string };
        return json.version ?? null;
    } catch {
        return null;
    }
};

/** Semver-ish compare: returns true when `latest` is strictly newer than `current`. */
export const isNewer = (latest: string, current: string): boolean => {
    const norm = (v: string) => v.replace(/^v/, '').split('-')[0].split('.').map((n) => parseInt(n, 10) || 0);
    const [a, b] = [norm(latest), norm(current)];
    for (let i = 0; i < 3; i++) {
        if ((a[i] ?? 0) > (b[i] ?? 0)) return true;
        if ((a[i] ?? 0) < (b[i] ?? 0)) return false;
    }
    return false;
};

/**
 * The mcp-server version this CLI will actually run. It ships as a dependency
 * (see mcp.ts), so it is pinned at install time — no longer "whatever npx
 * fetched last". Returns null on a broken install rather than throwing; the
 * report degrades to "latest is vX" the way it always did for this package.
 */
export const installedMcpServerVersion = (): string | null => {
    try {
        const pkg = JSON.parse(
            readFileSync(require.resolve('@zeph-to/mcp-server/package.json'), 'utf-8'),
        ) as { version?: string };
        return pkg.version ?? null;
    } catch {
        return null;
    }
};

export const handleCheckUpdate = async (args: Record<string, string | boolean>): Promise<number> => {
    const isJson = args.json === true;

    // Both installed versions are knowable: the CLI's from its own
    // package.json, and mcp-server's because `zeph mcp` runs it in-process,
    // which makes it a dependency rather than an npx download of unknown age.
    // Two unrelated registry round-trips — awaiting them one after the other
    // doubled the command's wall time for nothing.
    const latestVersions = await Promise.all(PACKAGES.map(fetchLatest));

    const results = PACKAGES.map((pkg, i) => {
        const latest = latestVersions[i];
        const current = pkg === '@zeph-to/cli' ? VERSION : installedMcpServerVersion();
        return { pkg, current, latest, outdated: !!(latest && current && isNewer(latest, current)) };
    });

    if (isJson) {
        console.log(JSON.stringify({ results }, null, 2));
        return 0;
    }

    console.log('\n  Zeph — update check\n');
    let anyOutdated = false;
    for (const r of results) {
        if (!r.latest) {
            console.log(`    ?  ${r.pkg}: could not reach npm registry`);
            continue;
        }
        if (r.current === null) {
            console.log(`    •  ${r.pkg}: latest is v${r.latest}`);
        } else if (r.outdated) {
            anyOutdated = true;
            console.log(`    ⬆  ${r.pkg}: v${r.current} → v${r.latest} (update available)`);
        } else {
            console.log(`    ✓  ${r.pkg}: v${r.current} (up to date)`);
        }
    }

    if (anyOutdated) {
        console.log('\n  Update with: npx @zeph-to/cli install\n');
    } else {
        console.log('');
    }
    return 0;
};
