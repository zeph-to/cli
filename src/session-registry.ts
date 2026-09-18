/**
 * What a session WAS, kept so it can be started again.
 *
 * tmux is the only record of a live session, and it forgets one the moment it
 * ends — which is exactly when the phone wants it back. So the listener writes
 * down what it saw while the session was alive: where it ran and which agent it
 * ran, keyed by the tmux name the phone already addresses it by **and** the
 * agent that ran under it — tmux hands the same name out again, and one row per
 * name meant the next occupant erased the last one's record (`runKey`).
 *
 * This file is the whitelist that makes remote resume safe. A resume request
 * carries a session NAME and nothing else; the directory and the binary come
 * from here, from what this machine observed itself. Nothing a phone (or a
 * relay posing as one) sends can point the daemon at another directory or
 * another program.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { removeTurnRing } from './turn-ring.js';
import { stateDir } from './gate.js';

export interface KnownSession {
    /** tmux session name — the key the phone addresses. */
    name: string;
    /** Pane cwd while it was alive. Where a resume starts the agent again. */
    cwd: string;
    /** RemoteAgent `kind` (claude/codex/…), resolved to a binary at resume time. */
    agentKind: string;
    project?: string;
    label?: string;
    /** Last time this machine saw the session running. */
    lastSeenAt: string;
}

/**
 * Ceiling on remembered sessions. tmux names come from a small reused pool
 * (`zeph-<project>`, `-2`, …), so this holds far more distinct projects than it
 * looks; the cap only stops the file from growing without bound on a machine
 * that has run agents for years.
 */
export const MAX_KNOWN_SESSIONS = 100;
/** Forgotten after this long unseen — a directory from months ago is more
 *  likely to have moved than to be what the user meant. */
export const KNOWN_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const registryPath = (): string => join(stateDir(), 'known-sessions.json');

const readAll = (): KnownSession[] => {
    try {
        const raw = readFileSync(registryPath(), 'utf-8');
        const parsed: unknown = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        // Written by this process, but a half-written or hand-edited file must
        // not take the listener down — keep the rows that still make sense.
        return parsed.filter(
            (e): e is KnownSession =>
                !!e &&
                typeof e === 'object' &&
                typeof (e as KnownSession).name === 'string' &&
                typeof (e as KnownSession).cwd === 'string' &&
                typeof (e as KnownSession).agentKind === 'string' &&
                typeof (e as KnownSession).lastSeenAt === 'string',
        );
    } catch {
        return [];
    }
};

const writeAll = (entries: KnownSession[]): void => {
    const path = registryPath();
    try {
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        // 0600: it names the user's project directories, which is not something
        // every account on the machine needs to read.
        writeFileSync(path, JSON.stringify(entries, null, 2), { mode: 0o600 });
    } catch {
        // A registry that cannot be written costs the resume affordance, not
        // the daemon — every other path keeps working.
    }
};

/**
 * What makes two sightings the same remembered run: the tmux name AND the
 * agent that was running under it.
 *
 * Keyed by name alone, a `zeph cc` in a project erased whatever pi had done in
 * the same slot — the ended run left no row to resume and no row to read, and
 * the past list silently answered with the newest occupant instead. tmux hands
 * a name back out; the record of what ran under it is not the name's to lose.
 *
 * NUL rather than a printable separator: a project directory can be called
 * almost anything, and a name holding the separator must not be able to forge
 * another run's key.
 */
export const runKey = (name: string, agentKind: string): string => `${name}\u0000${agentKind}`;

/** Sessions this machine has seen, newest first, expired ones dropped. */
export const knownSessions = (now: number = Date.now()): KnownSession[] =>
    readAll()
        .filter((e) => now - Date.parse(e.lastSeenAt) < KNOWN_SESSION_TTL_MS)
        .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));

/** One remembered session, or null when this machine never saw that name.
 *  The newest run under that name — which is the one a bare resume means. */
export const recallSession = (name: string, now: number = Date.now()): KnownSession | null =>
    knownSessions(now).find((e) => e.name === name) ?? null;

/**
 * One specific run: the newest under this name that ran THIS agent.
 *
 * A tmux name is a slot several agents pass through, so "resume zeph-web" is
 * ambiguous the moment the slot has held both pi and claude. The phone knows
 * which row was tapped and says so; this is how that answer is honoured.
 * Null when this machine never saw that agent under that name — the caller
 * decides whether to fall back to the newest run or refuse.
 */
export const recallRun = (
    name: string,
    agentKind: string,
    now: number = Date.now(),
): KnownSession | null =>
    knownSessions(now).find((e) => e.name === name && e.agentKind === agentKind) ?? null;

/**
 * Write down the sessions running right now, replacing what was known about
 * each. Called from the inventory sweep, so the record follows a session that
 * moves directory or changes agent rather than pinning its first sighting.
 *
 * A session with no readable cwd is skipped rather than remembered without
 * one: an entry that cannot say where to start the agent is not a resume
 * target, only a row that would fail when tapped.
 */
export const rememberSessions = (
    live: Array<{
        name: string;
        cwd: string | null;
        agentKind: string;
        project?: string | null;
        label?: string | null;
    }>,
    now: number = Date.now(),
): void => {
    const usable = live.filter((s) => !!s.name && !!s.cwd);
    if (usable.length === 0) return;
    const seenAt = new Date(now).toISOString();
    const byRun = new Map(knownSessions(now).map((e) => [runKey(e.name, e.agentKind), e]));
    for (const s of usable) {
        byRun.set(runKey(s.name, s.agentKind), {
            name: s.name,
            cwd: s.cwd as string,
            agentKind: s.agentKind,
            ...(s.project ? { project: s.project } : {}),
            ...(s.label ? { label: s.label } : {}),
            lastSeenAt: seenAt,
        });
    }
    const entries = [...byRun.values()]
        .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt))
        .slice(0, MAX_KNOWN_SESSIONS);
    writeAll(entries);
};

/**
 * Forget one session, by name. Returns false when this machine never knew it.
 *
 * This is what deleting a past session means on the machine that ran it: the
 * entry leaves the file, so the phone stops being offered the session AND —
 * since this file is the resume whitelist — stops being able to start it.
 * That is the intended pair, not a side effect.
 *
 * It stays forgotten: `rememberSessions` only writes down sessions that are
 * running, so nothing re-adds an entry for a session that has ended. Running
 * that name again is what brings it back, which is also the only way back.
 */
export type ForgetOutcome =
    /** This machine never had a record under that name. */
    | 'unknown'
    /** Registry entry and chat scrollback both gone. */
    | 'forgotten'
    /** Registry entry gone, but the scrollback file would not delete. */
    | 'scrollback_kept';

export const forgetSession = (name: string, agentKind?: string): ForgetOutcome => {
    const entries = readAll();
    // With a kind, only that run goes — the phone deletes the row it is looking
    // at, and a name that held both pi and claude shows two rows. Without one
    // (an older phone, which sends no kind), the name goes entirely: that is
    // what the request meant when a name could only mean one run.
    const kept = entries.filter((e) => e.name !== name || (agentKind ? e.agentKind !== agentKind : false));
    if (kept.length === entries.length) return 'unknown';
    // The chat's scrollback for that session goes with it. Forgetting a session
    // everywhere except the one file that holds a week of its prompts and tool
    // targets is not forgetting it — and a failure to delete that file has to
    // reach the person who asked, not stay in a swallowed catch.
    //
    // Except while another run still answers to the name: the scrollback is per
    // NAME, so deleting the pi row would take the claude row's history with it.
    // The record is gone either way; the file waits for the last run to go.
    const nameStillHeld = kept.some((e) => e.name === name);
    writeAll(kept);
    if (nameStillHeld) return 'forgotten';
    return removeTurnRing(name) ? 'forgotten' : 'scrollback_kept';
};

/**
 * What the caller was able to find out about a name. `unknown` is not a
 * synonym for ended: it is the terminal failing to answer at all — no tmux to
 * run, or no server behind the socket it resolved — and a sweep that deletes on
 * `ended` must not delete on that. Deciding this is the caller's job; this
 * module owns the file, not the terminal.
 */
export type SessionLiveness = 'running' | 'ended' | 'unknown';

/** What one sweep did. `scrollbackKept` is a subset of `forgotten`: the row is
 *  gone either way, and these are the ones whose chat history stayed behind. */
export type EndedSweep = {
    forgotten: string[];
    scrollbackKept: string[];
    kept: string[];
    unreachable: string[];
};

/**
 * Forget every remembered name that no longer runs, and report each side.
 *
 * The unit is the NAME, not the run: `forgetSession(name)` takes every run of
 * the name, and a name tmux still holds is one the next inventory sweep writes
 * straight back — so a name with a live run is left alone, its ended runs
 * included. Each name is judged, deleted and reported once, however many runs
 * sit under it.
 */
export const forgetEnded = (
    liveness: (name: string) => SessionLiveness,
    now: number = Date.now(),
): EndedSweep => {
    const names = [...new Set(knownSessions(now).map((e) => e.name))];
    const sweep: EndedSweep = { forgotten: [], scrollbackKept: [], kept: [], unreachable: [] };
    for (const name of names) {
        const state = liveness(name);
        if (state === 'running') sweep.kept.push(name);
        else if (state === 'unknown') sweep.unreachable.push(name);
        else sweep.forgotten.push(name);
    }
    if (sweep.forgotten.length === 0) return sweep;

    // One read and one write for the whole sweep. Calling `forgetSession` per
    // name would rewrite the file once per name — N chances for the daemon's
    // inventory sweep to write in between and put a deleted row back.
    const doomed = new Set(sweep.forgotten);
    writeAll(readAll().filter((e) => !doomed.has(e.name)));
    // Every run of these names has gone, so — unlike `forgetSession`, which
    // spares a ring another run still answers to — each ring goes with them.
    for (const name of sweep.forgotten) {
        if (!removeTurnRing(name)) sweep.scrollbackKept.push(name);
    }
    return sweep;
};

/** Whether the registry knows this name — the resume whitelist check. */
export const isKnownSession = (name: string, now: number = Date.now()): boolean =>
    recallSession(name, now) !== null;

/** Test seam: the file this module reads and writes. */
export const knownSessionsPath = registryPath;

/** True when the recorded directory still exists to start an agent in. */
export const sessionDirectoryExists = (entry: KnownSession): boolean => existsSync(entry.cwd);
