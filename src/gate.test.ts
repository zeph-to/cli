import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    autoPushMode, decidePush, GATE_DEFAULTS, isMuted, isRemoteActive, normalizeMarker,
    normalizePushMode, projectHash, PUSHMODE_DEFAULT, PUSHMODE_DEFAULT_FLAG, readPushMode,
    REMOTE_TTL_SEC, remoteStatePath, stateDir, touchRemoteActive,
} from './gate.js';

// ── Cross-repo parity vectors ────────────────────────────────────
//
// src/fixtures/gate-vectors.json is vendored from zeph-to/plugin (the
// canonical copy lives at plugin/tests/fixtures/gate-vectors.json and is
// also run against the bash gate in plugin/hooks/gate.sh). Any semantic
// divergence between the two implementations fails one side's CI.

interface Vector {
    name: string;
    input: {
        toolCount: number;
        nonReadonlyCount: number;
        alreadyAsked: boolean;
        marker: string;
        pushMode: string;
    };
    expect: { push: boolean; priority: 'high' | 'normal' };
}

const VECTORS: Vector[] = JSON.parse(
    readFileSync(join(__dirname, 'fixtures', 'gate-vectors.json'), 'utf-8'),
);

describe('gate.ts: decidePush parity with plugin/hooks/gate.sh', () => {
    it('has a non-trivial vector set', () => {
        expect(VECTORS.length).toBeGreaterThanOrEqual(20);
    });

    for (const v of VECTORS) {
        it(v.name, () => {
            const verdict = decidePush({
                toolCount: v.input.toolCount,
                nonReadonlyCount: v.input.nonReadonlyCount,
                alreadyAsked: v.input.alreadyAsked,
                marker: normalizeMarker(v.input.marker),
                pushMode: normalizePushMode(v.input.pushMode),
            });
            expect(verdict).toEqual(v.expect);
        });
    }
});

describe('gate.ts: normalizers', () => {
    it('normalizeMarker maps unknown/undefined to none', () => {
        expect(normalizeMarker(undefined)).toBe('none');
        expect(normalizeMarker('urgent')).toBe('none');
        expect(normalizeMarker('high')).toBe('high');
    });

    it('normalizePushMode maps unknown/undefined to normal', () => {
        expect(normalizePushMode(undefined)).toBe('normal');
        expect(normalizePushMode('banana')).toBe('normal');
        expect(normalizePushMode('quiet')).toBe('quiet');
        expect(normalizePushMode('loud')).toBe('loud');
    });

    it('GATE_DEFAULTS assume real work (push in normal mode)', () => {
        expect(decidePush({ ...GATE_DEFAULTS, marker: 'none', pushMode: 'normal' }))
            .toEqual({ push: true, priority: 'normal' });
    });

    // Why --pushmode-default exists: a hook that supplies no turn facts also
    // supplies no marker, and quiet only lets a `high` marker through. So for
    // those agents quiet is not a lower volume, it is permanent silence.
    it('GATE_DEFAULTS can never push in quiet mode', () => {
        expect(decidePush({ ...GATE_DEFAULTS, marker: 'none', pushMode: 'quiet' }))
            .toEqual({ push: false, priority: 'normal' });
    });
});

// ── Per-project state files (hash parity with the bash hooks) ────

let TMP: string;
let savedXdgStateHome: string | undefined;

beforeEach(() => {
    TMP = mkdtempSync(join(tmpdir(), 'zeph-gate-test-'));
    // Isolate state reads/writes from the machine's real ~/.local/state.
    savedXdgStateHome = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = join(TMP, 'state');
    mkdirSync(stateDir(), { recursive: true });
});

afterEach(() => {
    const hash = projectHash(TMP);
    if (savedXdgStateHome === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = savedXdgStateHome;
    rmSync(TMP, { recursive: true, force: true });
    if (hash) {
        rmSync(`/tmp/zeph-muted-${hash}`, { force: true });
        rmSync(`/tmp/zeph-pushmode-${hash}`, { force: true });
    }
});

describe('gate.ts: project state helpers', () => {
    it('projectHash matches the bash hooks\' cksum keying', () => {
        const expected = execFileSync('cksum', { input: TMP, encoding: 'utf-8' }).split(' ')[0];
        expect(projectHash(TMP)).toBe(expected);
    });

    it('isMuted reflects <stateDir>/muted-<hash>', () => {
        const dir = join(TMP, 'state', 'zeph');
        expect(isMuted(TMP)).toBe(false);
        writeFileSync(join(dir, `muted-${projectHash(TMP)}`), '');
        expect(isMuted(TMP)).toBe(true);
    });

    it('isMuted honors a user-owned legacy /tmp mute file', () => {
        expect(isMuted(TMP)).toBe(false);
        writeFileSync(`/tmp/zeph-muted-${projectHash(TMP)}`, '');
        expect(isMuted(TMP)).toBe(true);
    });

    // ── The default: no dial file ────────────────────────────────
    //
    // This is the twin of plugin/hooks/gate.sh's missing-5th-argument default
    // (tested in plugin/tests/test-gate-vectors.sh). The shared vectors never
    // reach it — every vector passes pushMode explicitly — so each side has to
    // pin it locally or the two can drift without either CI noticing.

    it('PUSHMODE_DEFAULT is quiet', () => {
        expect(PUSHMODE_DEFAULT).toBe('quiet');
    });

    it('readPushMode falls back to quiet when no dial file exists', () => {
        expect(readPushMode(TMP)).toBe('quiet');
    });

    it('readPushMode takes a caller-supplied fallback for the no-dial case', () => {
        // What --pushmode-default gives the hook-driven agents whose hooks
        // cannot emit a marker.
        expect(readPushMode(TMP, 'normal')).toBe('normal');
    });

    it('a dial file always outranks the caller-supplied fallback', () => {
        const file = join(TMP, 'state', 'zeph', `pushmode-${projectHash(TMP)}`);
        writeFileSync(file, 'quiet');
        expect(readPushMode(TMP, 'loud')).toBe('quiet');
    });

    // The twin of plugin/tests/test-zeph-stop.sh "project hash unavailable".
    // Without `cksum` no state file can be keyed, so no dial can be found even
    // if one exists — a broken environment, not a user who left the dial alone.
    // This branch had no coverage on either side, which is how the two
    // implementations drifted apart on it in the first place.
    it('an unhashable project falls back to normal, not to the no-dial default', () => {
        const savedPath = process.env.PATH;
        process.env.PATH = '';
        try {
            expect(projectHash(TMP)).toBeNull();
            expect(readPushMode(TMP)).toBe('normal');
        } finally {
            process.env.PATH = savedPath;
        }
    });

    it('an empty dial file reads as normal, not as the no-dial default', () => {
        // A truncated or failed write is a corrupted dial, not an absent one.
        // Resolving it to quiet would hide the breakage as silence. The bash
        // twin substitutes `normal` in zeph-stop.sh for the same reason.
        const file = join(TMP, 'state', 'zeph', `pushmode-${projectHash(TMP)}`);
        writeFileSync(file, '   \n');
        expect(readPushMode(TMP, 'loud')).toBe('normal');
    });

    it('readPushMode reads the dial file, tolerating whitespace', () => {
        const file = join(TMP, 'state', 'zeph', `pushmode-${projectHash(TMP)}`);
        writeFileSync(file, 'quiet\n');
        expect(readPushMode(TMP)).toBe('quiet');
        writeFileSync(file, ' loud ');
        expect(readPushMode(TMP)).toBe('loud');
        writeFileSync(file, 'banana');
        expect(readPushMode(TMP)).toBe('normal');
    });

    // `loud`, not `quiet`: quiet is now what a missing dial resolves to, so a
    // quiet expectation here would pass even if the file were never read.
    it('readPushMode falls back to a user-owned legacy /tmp dial file', () => {
        writeFileSync(`/tmp/zeph-pushmode-${projectHash(TMP)}`, 'loud\n');
        expect(readPushMode(TMP)).toBe('loud');
    });

    it('readPushMode falls back to the global pushmode-default', () => {
        const dir = join(TMP, 'state', 'zeph');
        writeFileSync(join(dir, 'pushmode-default'), 'loud');
        expect(readPushMode(TMP)).toBe('loud');
        // A per-project dial always outranks the machine-wide default.
        writeFileSync(join(dir, `pushmode-${projectHash(TMP)}`), 'normal');
        expect(readPushMode(TMP)).toBe('normal');
    });

    // ── --pushmode-default (the flag the installed hooks carry) ──

    // Only what autoPushMode adds on top of readPushMode is asserted here —
    // the pass-through cases are already covered above, and duplicating them
    // would light up four failures for one cause.
    it('autoPushMode ignores a valueless or garbled flag', () => {
        // `--pushmode-default` with nothing after it parses to boolean true.
        expect(autoPushMode(TMP, true)).toBe('quiet');
        expect(autoPushMode(TMP, 'banana')).toBe('normal');
    });

    it("autoPushMode lets the user's dial beat the flag", () => {
        // The whole priority rule: the flag only names a default. A dial is an
        // expression of intent and always wins, or /zeph-quiet would be a lie
        // for every hook-driven agent.
        writeFileSync(join(TMP, 'state', 'zeph', `pushmode-${projectHash(TMP)}`), 'quiet');
        expect(autoPushMode(TMP, 'loud')).toBe('quiet');
    });

    it('isMuted has no global default — mute stays project-only', () => {
        writeFileSync(join(TMP, 'state', 'zeph', 'muted-default'), '');
        expect(isMuted(TMP)).toBe(false);
    });
});

// ── Sticky REMOTE state (twin of gate.sh zeph_remote_active/_touch) ──

describe('gate.ts: sticky REMOTE state', () => {
    const NOW = 1_800_000_000_000; // fixed clock; the epoch second is 1800000000
    const at = (ms: number) => () => ms;

    it('keys the state file exactly as the bash hook does', () => {
        touchRemoteActive(TMP, at(NOW));
        expect(remoteStatePath(projectHash(TMP)!))
            .toBe(join(TMP, 'state', 'zeph', `remote-active-${projectHash(TMP)}`));
        expect(readFileSync(remoteStatePath(projectHash(TMP)!), 'utf-8').trim())
            .toBe(String(Math.floor(NOW / 1000)));
    });

    it('is inactive with no state file, and does not create one', () => {
        expect(isRemoteActive(TMP, at(NOW))).toBe(false);
        expect(existsSync(remoteStatePath(projectHash(TMP)!))).toBe(false);
    });

    it('stays active right up to the TTL boundary', () => {
        touchRemoteActive(TMP, at(NOW));
        const lastFreshMs = NOW + REMOTE_TTL_SEC * 1000;
        expect(isRemoteActive(TMP, at(lastFreshMs))).toBe(true);
    });

    // The sweep is the only thing that ends a REMOTE session nobody exited:
    // there is no SessionEnd hook, so a crashed session's state would
    // otherwise make every later session in this project ask an absent phone.
    it('sweeps state one second past the TTL', () => {
        touchRemoteActive(TMP, at(NOW));
        const file = remoteStatePath(projectHash(TMP)!);
        expect(isRemoteActive(TMP, at(NOW + (REMOTE_TTL_SEC + 1) * 1000))).toBe(false);
        expect(existsSync(file)).toBe(false);
    });

    it('sweeps state it cannot parse', () => {
        const file = remoteStatePath(projectHash(TMP)!);
        writeFileSync(file, 'not-a-timestamp\n');
        expect(isRemoteActive(TMP, at(NOW))).toBe(false);
        expect(existsSync(file)).toBe(false);
    });

    // Parity regression against the bash twin's `case "$ts" in *[!0-9]*)`,
    // which rejects every one of these. Number() is looser: it reads '1e10' as
    // ten billion, so a file bash sweeps would have kept REMOTE alive here
    // until the year 2286.
    it.each(['1e10', '0x10', '+5', '1_000'])('sweeps non-digit state %j', (raw) => {
        const file = remoteStatePath(projectHash(TMP)!);
        writeFileSync(file, `${raw}\n`);
        expect(isRemoteActive(TMP, at(NOW))).toBe(false);
        expect(existsSync(file)).toBe(false);
    });

    it('refreshing pushes the expiry back', () => {
        touchRemoteActive(TMP, at(NOW));
        const later = NOW + REMOTE_TTL_SEC * 1000;
        touchRemoteActive(TMP, at(later));
        expect(isRemoteActive(TMP, at(later + REMOTE_TTL_SEC * 1000))).toBe(true);
    });
});
