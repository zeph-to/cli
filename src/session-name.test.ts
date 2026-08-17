import { describe, expect, it } from 'vitest';
import { detectHermesSessionName, pickRowByProcStart } from './remote-agents.js';

/**
 * Hermes and Codex keep no pid in their session stores, so a pane is matched to
 * a row by when the process started. These cases pin the boundary and, more
 * importantly, pin which way it fails: a miss must produce null (the phone
 * keeps its computed label) and never a confident wrong name.
 */
describe('pickRowByProcStart', () => {
    // 2026-08-14 11:54:54 KST, the shape a Hermes session id encodes.
    const PROC = 1_786_676_108_000;
    const startTimes = new Map([[100, PROC]]);
    const pids = new Set([90, 95, 100]);
    const ts = (r: { at: number | null }) => r.at;

    const pick = <T>(rows: readonly T[], tsMsOf: (r: T) => number | null, tol = 10_000) =>
        pickRowByProcStart(rows, tsMsOf, startTimes, pids, tol);

    it('picks the row written when this pane\'s process started', () => {
        const rows = [{ at: PROC + 1_200, id: 'live' }, { at: PROC - 3_600_000, id: 'an hour ago' }];
        expect(pick(rows, ts)?.id).toBe('live');
    });

    it('accepts a row exactly at the tolerance and rejects one a millisecond past it', () => {
        expect(pick([{ at: PROC + 10_000, id: 'edge' }], ts)?.id).toBe('edge');
        expect(pick([{ at: PROC + 10_001, id: 'past' }], ts)).toBeNull();
    });

    it('takes the closest row when two land inside the window (the documented misjoin)', () => {
        const rows = [{ at: PROC + 9_000, id: 'far' }, { at: PROC + 400, id: 'near' }];
        expect(pick(rows, ts)?.id).toBe('near');
    });

    /**
     * A resumed session's row was created long before the process that resumed
     * it, so no start time can vouch for it. Null is the right answer: the label
     * falls back to `<project> · <Agent> #N`, which is stale-looking but true,
     * where a match would put someone else's name on this pane.
     */
    it('matches nothing for a resumed session, rather than guessing', () => {
        expect(pick([{ at: PROC - 86_400_000, id: 'yesterday' }], ts)).toBeNull();
    });

    it('returns null for an empty row set', () => {
        expect(pick([] as { at: number | null }[], ts)).toBeNull();
    });

    it('skips rows whose timestamp column was never filled in', () => {
        const rows = [{ at: null, id: 'no timestamp' }, { at: PROC, id: 'has one' }];
        expect(pick(rows, ts)?.id).toBe('has one');
        expect(pick([{ at: null, id: 'only null' }], ts)).toBeNull();
    });

    /**
     * A pane pid can be in the tree while `lstart` failed to parse for it, or
     * while the process has already exited. An absent start time must not become
     * a NaN comparison that quietly matches or quietly rejects everything.
     */
    it('returns null when no pid in the tree has a known start time', () => {
        expect(pickRowByProcStart([{ at: PROC }], ts, new Map(), pids, 10_000)).toBeNull();
        expect(pickRowByProcStart([{ at: PROC }], ts, startTimes, new Set([90]), 10_000)).toBeNull();
    });

    it('matches against any pid in the tree, not only the pane root', () => {
        // The agent is a grandchild of the pane: pane 90 → shell 95 → agent 100.
        const deep = new Map([[100, PROC]]);
        expect(pickRowByProcStart([{ at: PROC + 500, id: 'deep' }], ts, deep, pids, 10_000)?.id).toBe('deep');
    });
});

/**
 * Hermes names a session with an LLM-written title a few seconds after the first
 * response, stored in `~/.hermes/state.db`. Rows carry a cwd and a start time but
 * no pid, hence the process-start join above.
 */
describe('detectHermesSessionName', () => {
    // The real row shape, from `~/.hermes/state.db`: started_at is REAL seconds
    // with sub-millisecond precision, NOT milliseconds.
    const STARTED_SEC = 1_786_676_108.657_765_9;
    const PROC_MS = 1_786_676_108_000;
    const deps = (rows: unknown[]) => ({
        rows,
        startTimes: new Map([[100, PROC_MS]]),
        descendants: new Set([90, 95, 100]),
    });

    it('reads the auto-title of the session running in this pane', () => {
        const rows = [{ cwd: '/proj', title: 'Fix listener race', display_name: null, started_at: STARTED_SEC }];
        expect(detectHermesSessionName('/proj', 90, deps(rows))).toBe('Fix listener race');
    });

    /**
     * The one conversion that kills the feature in silence: `started_at` is in
     * seconds, so a row compared without scaling sits in 1970 and never lands
     * inside the tolerance. Nothing errors — names simply never appear.
     */
    it('scales the row\'s seconds to milliseconds before comparing', () => {
        // Same instant expressed as ms would be ~1.8e12; as seconds ~1.8e9. If
        // the implementation skipped the scale, this row would miss by 56 years.
        const rows = [{ cwd: '/proj', title: 'Scaled', display_name: null, started_at: STARTED_SEC }];
        expect(detectHermesSessionName('/proj', 90, deps(rows))).toBe('Scaled');
    });

    it('ignores rows from another directory', () => {
        const rows = [{ cwd: '/elsewhere', title: 'Not this one', display_name: null, started_at: STARTED_SEC }];
        expect(detectHermesSessionName('/proj', 90, deps(rows))).toBeNull();
    });

    it('falls back to display_name, then to nothing', () => {
        const withDisplay = [{ cwd: '/proj', title: null, display_name: 'Named by hand', started_at: STARTED_SEC }];
        expect(detectHermesSessionName('/proj', 90, deps(withDisplay))).toBe('Named by hand');
        const untitled = [{ cwd: '/proj', title: null, display_name: null, started_at: STARTED_SEC }];
        expect(detectHermesSessionName('/proj', 90, deps(untitled))).toBeNull();
    });

    // Titles are written asynchronously and can land as an empty string when the
    // auxiliary model call fails; that must read as "no name", not as a name.
    it('treats a blank title as no name', () => {
        const rows = [{ cwd: '/proj', title: '   ', display_name: null, started_at: STARTED_SEC }];
        expect(detectHermesSessionName('/proj', 90, deps(rows))).toBeNull();
    });

    // No `sqlite3` on PATH, a locked db, a schema that moved — all arrive here as
    // a null read, and all cost the name only.
    it('returns null when the store cannot be read at all', () => {
        expect(detectHermesSessionName('/proj', 90, { ...deps([]), rows: null })).toBeNull();
    });

    it('returns null without a pane pid — there is no other way to identify the row', () => {
        const rows = [{ cwd: '/proj', title: 'Fix listener race', display_name: null, started_at: STARTED_SEC }];
        expect(detectHermesSessionName('/proj', undefined, deps(rows))).toBeNull();
    });
});
