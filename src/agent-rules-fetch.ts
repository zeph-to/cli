/**
 * OTA delivery for agent detection rules (SPEC-AGENT-AWARENESS §S7).
 *
 * Agent UIs change on their release cadence, not ours: when Claude
 * Code reshapes its status line, detection must be fixable by shipping
 * DATA, not a new daemon. The listener therefore resolves its manifest
 * as: valid remote fetch → valid disk cache → bundled defaults. Every
 * tier fails closed to the next — a dead endpoint, corrupt cache, or
 * hostile payload can never leave the listener without rules, and
 * `disabledRuleIds` in a fetched manifest acts as a same-day
 * kill-switch for a misfiring rule (no release, no restart).
 *
 * Version precedence: a fetched/cached manifest only activates when
 * its version is >= the bundled one. npm publishes land in minutes
 * while the server manifest ships with a full deploy, so a fresh cli
 * routinely carries NEWER rules than the endpoint — without the gate,
 * the older remote manifest would shadow every bundled rule fix until
 * the server caught up. Server-side rollback still works: the server
 * bumps the version even when reverting rule content.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { CONFIG_DIR, loadConfig, resolvedEnv } from './config.js';
import {
    clearRegexCache, ENGINE_VERSION,
    type DetectionManifest, type DetectionRule,
} from './agent-state.js';
import { DEFAULT_MANIFEST } from './agent-rules.default.js';

export const RULES_CACHE_FILE = join(CONFIG_DIR, 'agent-rules.json');
export const RULES_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;
// Fallback only — the manifest path normally derives from the resolved
// API base so the stage prefix (prod /v1, dev /d1) follows the user's
// config instead of being hardcoded here.
const DEFAULT_API_BASE = 'https://api.zeph.to/v1';
// Matches the server-side serving cap; anything bigger is not a manifest.
const MAX_MANIFEST_BYTES = 256 * 1024;
const FETCH_TIMEOUT_MS = 10_000;

const VALID_STATES: ReadonlySet<string> = new Set(['working', 'blocked', 'idle', 'unknown']);

/** Cache-file shape: manifest plus fetch bookkeeping (ETag revalidation). */
interface RulesCache {
    etag?: string;
    fetchedAt?: string;
    manifest: DetectionManifest;
}

const isStringArray = (v: unknown): v is string[] =>
    Array.isArray(v) && v.every((s) => typeof s === 'string');

const isCondition = (v: unknown): boolean => {
    if (typeof v !== 'object' || v === null) return false;
    const c = v as Record<string, unknown>;
    if (c.contains !== undefined && !isStringArray(c.contains)) return false;
    if (c.regex !== undefined && !isStringArray(c.regex)) return false;
    return true;
};

const isRule = (v: unknown): v is DetectionRule => {
    if (typeof v !== 'object' || v === null) return false;
    const r = v as Record<string, unknown>;
    if (typeof r.id !== 'string' || r.id.length === 0) return false;
    if (typeof r.state !== 'string' || !VALID_STATES.has(r.state)) return false;
    // Safe integers, not merely finite. These numbers arrive from the server
    // and decide behavior: a fractional priority orders rules by values no
    // author can reason about, 1e21 outranks every rule ever written including
    // the kill-switch, and a fractional tailLines slices a capture at a
    // fraction of a line.
    if (!Number.isSafeInteger(r.priority)) return false;
    if (r.region !== undefined && r.region !== 'tail' && r.region !== 'whole') return false;
    if (r.tailLines !== undefined && (!Number.isSafeInteger(r.tailLines) || (r.tailLines as number) < 1 || (r.tailLines as number) > 200)) return false;
    if (r.contains !== undefined && !isStringArray(r.contains)) return false;
    if (r.regex !== undefined && !isStringArray(r.regex)) return false;
    if (r.any !== undefined && (!Array.isArray(r.any) || !r.any.every(isCondition))) return false;
    if (r.not !== undefined && (!Array.isArray(r.not) || !r.not.every(isCondition))) return false;
    if (r.skipStateUpdate !== undefined && typeof r.skipStateUpdate !== 'boolean') return false;
    return true;
};

/**
 * Structural validation of an untrusted manifest. Engine-version gate
 * included: a manifest authored for a future engine is rejected whole —
 * partial interpretation of unknown semantics is worse than falling
 * back to bundled rules.
 */
export const validateManifest = (value: unknown): DetectionManifest | null => {
    if (typeof value !== 'object' || value === null) return null;
    const m = value as Record<string, unknown>;
    if (m.engineVersion !== ENGINE_VERSION) return null;
    if (typeof m.version !== 'string' || m.version.length === 0) return null;
    if (m.disabledRuleIds !== undefined && !isStringArray(m.disabledRuleIds)) return null;
    if (typeof m.agents !== 'object' || m.agents === null) return null;
    for (const rules of Object.values(m.agents as Record<string, unknown>)) {
        if (!Array.isArray(rules) || !rules.every(isRule)) return null;
    }
    return value as DetectionManifest;
};

/**
 * Segment-wise numeric compare of dotted date versions
 * ("2026.07.04.3"). Plain string compare fails on ".10" vs ".9";
 * non-numeric segments compare as equal so a malformed version can
 * never crash the refresh path.
 */
export const compareManifestVersions = (a: string, b: string): number => {
    const as = a.split('.').map(Number);
    const bs = b.split('.').map(Number);
    const len = Math.max(as.length, bs.length);
    for (let i = 0; i < len; i++) {
        const d = (as[i] ?? 0) - (bs[i] ?? 0);
        if (Number.isNaN(d)) continue;
        if (d !== 0) return d < 0 ? -1 : 1;
    }
    return 0;
};

// ── Active manifest ──────────────────────────────────────────────

export type ManifestSource = 'remote' | 'cache' | 'bundled';

let activeManifest: DetectionManifest = DEFAULT_MANIFEST;
let activeSource: ManifestSource = 'bundled';

export const getActiveManifest = (): DetectionManifest => activeManifest;
export const getActiveManifestSource = (): ManifestSource => activeSource;

const activateManifest = (manifest: DetectionManifest, source: ManifestSource): void => {
    activeManifest = manifest;
    activeSource = source;
    // Old manifest's compiled patterns must not pin memory forever.
    clearRegexCache();
};

/** Test hook. */
export const resetActiveManifest = (): void => {
    activateManifest(DEFAULT_MANIFEST, 'bundled');
};

/**
 * Startup path (synchronous): promote the disk cache if it validates,
 * else stay on bundled. Never throws — detection must work offline.
 */
export const loadManifestFromCache = (): ManifestSource => {
    try {
        const cache = JSON.parse(readFileSync(RULES_CACHE_FILE, 'utf-8')) as RulesCache;
        const manifest = validateManifest(cache.manifest);
        if (manifest && compareManifestVersions(manifest.version, DEFAULT_MANIFEST.version) >= 0) {
            activateManifest(manifest, 'cache');
        }
    } catch {
        // Missing/corrupt cache — bundled rules carry the session.
    }
    return activeSource;
};

const readCachedEtag = (): string | undefined => {
    try {
        const cache = JSON.parse(readFileSync(RULES_CACHE_FILE, 'utf-8')) as RulesCache;
        return typeof cache.etag === 'string' ? cache.etag : undefined;
    } catch {
        return undefined;
    }
};

export const rulesUrl = (): string => {
    const override = resolvedEnv('ZEPH_AGENT_RULES_URL');
    if (override) return override;
    const base = resolvedEnv('ZEPH_BASE_URL') ?? loadConfig().baseUrl ?? DEFAULT_API_BASE;
    return `${base.replace(/\/$/, '')}/agent-detection/manifest`;
};

export interface RefreshResult {
    source: ManifestSource;
    /** 'updated' | 'not-modified' | 'stale-ignored' | 'invalid' | 'error' — for verbose logs. */
    outcome: string;
    version?: string;
}

/**
 * One refresh attempt: conditional GET, validate, persist, activate.
 * All failure modes degrade to the current active manifest.
 */
export const refreshManifest = async (fetchImpl: typeof fetch = fetch): Promise<RefreshResult> => {
    try {
        const etag = readCachedEtag();
        const res = await fetchImpl(rulesUrl(), {
            headers: etag ? { 'If-None-Match': etag } : {},
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        if (res.status === 304) {
            return { source: activeSource, outcome: 'not-modified', version: activeManifest.version };
        }
        if (!res.ok) {
            return { source: activeSource, outcome: 'error' };
        }
        const body = await res.text();
        if (Buffer.byteLength(body, 'utf-8') > MAX_MANIFEST_BYTES) {
            return { source: activeSource, outcome: 'invalid' };
        }
        const manifest = validateManifest(JSON.parse(body));
        if (!manifest) {
            return { source: activeSource, outcome: 'invalid' };
        }
        const cache: RulesCache = {
            etag: res.headers.get('etag') ?? undefined,
            fetchedAt: new Date().toISOString(),
            manifest,
        };
        try {
            mkdirSync(CONFIG_DIR, { recursive: true });
            writeFileSync(RULES_CACHE_FILE, JSON.stringify(cache, null, 2) + '\n');
        } catch {
            // Cache write failure is non-fatal: the manifest still
            // activates for this process lifetime.
        }
        if (compareManifestVersions(manifest.version, DEFAULT_MANIFEST.version) < 0) {
            // Endpoint hasn't caught up to this build's bundled rules.
            // Cache is still written above (the ETag stops refetch churn)
            // but startup applies the same gate, so bundled stays active.
            return { source: activeSource, outcome: 'stale-ignored', version: manifest.version };
        }
        activateManifest(manifest, 'remote');
        return { source: 'remote', outcome: 'updated', version: manifest.version };
    } catch {
        return { source: activeSource, outcome: 'error' };
    }
};
