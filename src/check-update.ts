import { VERSION } from './config.js';

// Compares installed versions against the npm registry. Pure read-only —
// never installs anything; just tells the user if a newer release exists.

const PACKAGES = ['@zeph-to/hook-sdk', '@zeph-to/mcp-server'] as const;

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

export const handleCheckUpdate = async (args: Record<string, string | boolean>): Promise<number> => {
    const isJson = args.json === true;

    // The hook-sdk's own installed version is known from package.json.
    // mcp-server's installed version isn't reliably knowable from here
    // (it's a separate package, often run via npx), so we only report its
    // latest — the user compares against whatever they have.
    const results: Array<{ pkg: string; current: string | null; latest: string | null; outdated: boolean }> = [];

    for (const pkg of PACKAGES) {
        const latest = await fetchLatest(pkg);
        const current = pkg === '@zeph-to/hook-sdk' ? VERSION : null;
        const outdated = !!(latest && current && isNewer(latest, current));
        results.push({ pkg, current, latest, outdated });
    }

    if (isJson) {
        console.log(JSON.stringify({ results }, null, 2));
        return results.some((r) => r.outdated) ? 0 : 0;
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
        console.log('\n  Update with: npx @zeph-to/hook-sdk install\n');
    } else {
        console.log('');
    }
    return 0;
};
