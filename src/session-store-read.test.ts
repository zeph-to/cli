import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The unit tests for these resolvers inject rows, which proves the join and the
 * unit conversions but never the SQL string or the schema it runs against — the
 * two things that break when an agent migrates its store. These cases build a
 * real SQLite file with the real `CREATE TABLE` (copied from the shipped stores)
 * and let the resolver find its own way to it, so a renamed column or a moved
 * file fails here instead of silently returning no name in production.
 *
 * They also close the observation gap those agents leave on this machine: every
 * measured Hermes row has a NULL title and the Codex thread table is empty, so
 * nothing live can demonstrate a name actually arriving.
 */
const sqlite = (db: string, sql: string) => {
    const r = spawnSync('sqlite3', [db, sql], { encoding: 'utf-8' });
    if (r.status !== 0) throw new Error(`sqlite3 setup failed: ${r.stderr}`);
};

const HERMES_SCHEMA = `CREATE TABLE sessions (
    id TEXT PRIMARY KEY, source TEXT NOT NULL, display_name TEXT,
    started_at REAL NOT NULL, ended_at REAL, cwd TEXT, title TEXT
);`;

const CODEX_SCHEMA = `CREATE TABLE threads (
    id TEXT PRIMARY KEY, cwd TEXT NOT NULL, title TEXT NOT NULL,
    created_at INTEGER NOT NULL, archived INTEGER NOT NULL DEFAULT 0,
    created_at_ms INTEGER, name TEXT
);`;

let TMP: string;
const originalHome = process.env.HOME;

beforeEach(() => {
    TMP = mkdtempSync(join(tmpdir(), 'zeph-store-read-'));
    process.env.HOME = TMP;
    // The store paths are computed at module load — re-import per test.
    vi.resetModules();
});

afterEach(() => {
    rmSync(TMP, { recursive: true, force: true });
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
});

/** This process's own start time, so a row can be stamped to match it. */
const ownProcStart = async (): Promise<number> => {
    const { psStartTimes } = await import('./remote-agents.js');
    const started = psStartTimes().get(process.pid);
    if (started === undefined) throw new Error('ps did not report a start time for this process');
    return started;
};

describe('Hermes store, read for real', () => {
    it('finds the title of the row stamped when this process started', async () => {
        const started = await ownProcStart();
        const db = join(TMP, '.hermes', 'state.db');
        mkdirSync(join(TMP, '.hermes'), { recursive: true });
        sqlite(db, HERMES_SCHEMA);
        // started_at in SECONDS, as Hermes writes it.
        sqlite(db, `INSERT INTO sessions (id, source, started_at, cwd, title) VALUES
            ('20260814_115454_01b750', 'cli', ${started / 1_000}, '${TMP}', 'Fix listener race'),
            ('20260814_112441_5d0c6f', 'cli', ${started / 1_000 - 3_600}, '${TMP}', 'An hour earlier');`);

        const { detectHermesSessionName } = await import('./remote-agents.js');
        expect(detectHermesSessionName(TMP, process.pid)).toBe('Fix listener race');
    });

    it('returns null when the store has no row for this directory', async () => {
        const started = await ownProcStart();
        const db = join(TMP, '.hermes', 'state.db');
        mkdirSync(join(TMP, '.hermes'), { recursive: true });
        sqlite(db, HERMES_SCHEMA);
        sqlite(db, `INSERT INTO sessions (id, source, started_at, cwd, title)
            VALUES ('x', 'cli', ${started / 1_000}, '/somewhere/else', 'Other');`);

        const { detectHermesSessionName } = await import('./remote-agents.js');
        expect(detectHermesSessionName(TMP, process.pid)).toBeNull();
    });

    it('returns null when the store does not exist', async () => {
        const { detectHermesSessionName } = await import('./remote-agents.js');
        expect(detectHermesSessionName(TMP, process.pid)).toBeNull();
    });
});

describe('Codex store, read for real', () => {
    it('finds the newest schema version and reads the thread name from it', async () => {
        const started = await ownProcStart();
        mkdirSync(join(TMP, '.codex'), { recursive: true });
        // An older version file that must be ignored, and the current one.
        const stale = join(TMP, '.codex', 'state_5.sqlite');
        sqlite(stale, CODEX_SCHEMA);
        sqlite(stale, `INSERT INTO threads (id, cwd, title, created_at, created_at_ms, name)
            VALUES ('old', '${TMP}', 'From the old schema', 0, ${started}, 'stale db');`);
        const current = join(TMP, '.codex', 'state_10.sqlite');
        sqlite(current, CODEX_SCHEMA);
        sqlite(current, `INSERT INTO threads (id, cwd, title, created_at, created_at_ms, name)
            VALUES ('new', '${TMP}', 'Investigate flaky deploy', 0, ${started}, 'deploy audit');`);

        const { detectCodexSessionName } = await import('./remote-agents.js');
        expect(detectCodexSessionName(TMP, process.pid)).toBe('deploy audit');
    });

    it('reads the generated title when the thread was never named', async () => {
        const started = await ownProcStart();
        mkdirSync(join(TMP, '.codex'), { recursive: true });
        const db = join(TMP, '.codex', 'state_5.sqlite');
        sqlite(db, CODEX_SCHEMA);
        // created_at_ms NULL, as rows written before that column exist — the
        // seconds column has to carry the match.
        sqlite(db, `INSERT INTO threads (id, cwd, title, created_at, created_at_ms)
            VALUES ('t', '${TMP}', 'Investigate flaky deploy', ${Math.floor(started / 1_000)}, NULL);`);

        const { detectCodexSessionName } = await import('./remote-agents.js');
        expect(detectCodexSessionName(TMP, process.pid)).toBe('Investigate flaky deploy');
    });

    it('returns null when codex was never installed here', async () => {
        const { detectCodexSessionName } = await import('./remote-agents.js');
        expect(detectCodexSessionName(TMP, process.pid)).toBeNull();
    });
});
