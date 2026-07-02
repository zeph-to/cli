import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    decidePush, GATE_DEFAULTS, isMuted, normalizeMarker, normalizePushMode,
    projectHash, readPushMode,
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
});

// ── Per-project state files (hash parity with the bash hooks) ────

let TMP: string;

beforeEach(() => {
    TMP = mkdtempSync(join(tmpdir(), 'zeph-gate-test-'));
});

afterEach(() => {
    const hash = projectHash(TMP);
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

    it('isMuted reflects /tmp/zeph-muted-<hash>', () => {
        expect(isMuted(TMP)).toBe(false);
        writeFileSync(`/tmp/zeph-muted-${projectHash(TMP)}`, '');
        expect(isMuted(TMP)).toBe(true);
    });

    it('readPushMode reads the dial file, tolerating whitespace', () => {
        expect(readPushMode(TMP)).toBe('normal');
        writeFileSync(`/tmp/zeph-pushmode-${projectHash(TMP)}`, 'quiet\n');
        expect(readPushMode(TMP)).toBe('quiet');
        writeFileSync(`/tmp/zeph-pushmode-${projectHash(TMP)}`, ' loud ');
        expect(readPushMode(TMP)).toBe('loud');
        writeFileSync(`/tmp/zeph-pushmode-${projectHash(TMP)}`, 'banana');
        expect(readPushMode(TMP)).toBe('normal');
    });
});
