/**
 * What a session WAS, kept so it can be started again.
 *
 * tmux is the only record of a live session, and it forgets one the moment it
 * ends — which is exactly when the phone wants it back. So the listener writes
 * down what it saw while the session was alive: where it ran and which agent it
 * ran, keyed by the tmux name the phone already addresses it by.
 *
 * This file is the whitelist that makes remote resume safe. A resume request
 * carries a session NAME and nothing else; the directory and the binary come
 * from here, from what this machine observed itself. Nothing a phone (or a
 * relay posing as one) sends can point the daemon at another directory or
 * another program.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
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

/** Sessions this machine has seen, newest first, expired ones dropped. */
export const knownSessions = (now: number = Date.now()): KnownSession[] =>
    readAll()
        .filter((e) => now - Date.parse(e.lastSeenAt) < KNOWN_SESSION_TTL_MS)
        .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));

/** One remembered session, or null when this machine never saw that name. */
export const recallSession = (name: string, now: number = Date.now()): KnownSession | null =>
    knownSessions(now).find((e) => e.name === name) ?? null;

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
    const byName = new Map(knownSessions(now).map((e) => [e.name, e]));
    for (const s of usable) {
        byName.set(s.name, {
            name: s.name,
            cwd: s.cwd as string,
            agentKind: s.agentKind,
            ...(s.project ? { project: s.project } : {}),
            ...(s.label ? { label: s.label } : {}),
            lastSeenAt: seenAt,
        });
    }
    const entries = [...byName.values()]
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
export const forgetSession = (name: string): boolean => {
    const entries = readAll();
    const kept = entries.filter((e) => e.name !== name);
    if (kept.length === entries.length) return false;
    writeAll(kept);
    return true;
};

/** Whether the registry knows this name — the resume whitelist check. */
export const isKnownSession = (name: string, now: number = Date.now()): boolean =>
    recallSession(name, now) !== null;

/** Test seam: the file this module reads and writes. */
export const knownSessionsPath = registryPath;

/** True when the recorded directory still exists to start an agent in. */
export const sessionDirectoryExists = (entry: KnownSession): boolean => existsSync(entry.cwd);
