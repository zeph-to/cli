/**
 * Claude Code subagents — the ones that never get a tmux pane.
 *
 * `listener.ts` finds a subagent by looking for an extra pane of a session
 * (pi splits one off per subagent). Claude Code's `Agent` tool runs its
 * subagents in-process instead: no pane, no process of their own, nothing the
 * pane sweep can see. What they do leave is a transcript, beside the parent's:
 *
 *   ~/.claude/projects/<project>/<sessionId>.jsonl          ← parent
 *   ~/.claude/projects/<project>/<sessionId>/subagents/
 *       agent-<agentId>.jsonl                               ← one per subagent
 *
 * So this module is the pane sweep's counterpart for a source that is a
 * directory of files rather than a list of panes. It returns the same thing the
 * sweep returns — rows the phone can show — and nothing about what a row means
 * changes: `<parent>.<n>` is still a view-only wire name, still never a tmux
 * target (see `subagentParentOf` in the app's shared package).
 *
 * Everything here is Claude Code's private layout, measured on 2.1.268, not a
 * published contract. The one state that proves it moved — the parent says it
 * launched a subagent, the directory is not there — is logged once, because
 * the alternative failure is this feature vanishing in silence.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { initialTailState, readTranscriptDelta, type TailState } from './transcript-tail.js';

/** How recently a subagent transcript must have grown to count as working. */
export const SUBAGENT_WORKING_MS = 15_000;

/**
 * How long a quiet subagent stays on the roster.
 *
 * A finished subagent leaves its file behind forever — a session directory
 * holds a dozen of them within a day (measured) — so "the file exists" cannot
 * be what puts a chip on the phone. Recent activity is.
 */
export const SUBAGENT_LIVE_MS = 5 * 60_000;

/** Rows one session may contribute. The switcher is a strip of chips, not a list. */
export const MAX_SUBAGENT_ROWS = 5;

const AGENT_FILE = /^agent-(.+)\.jsonl$/;

export interface SubagentRow {
    /** Wire name: `<parent>.<n>`, the shape the server reads as view-only. */
    readonly name: string;
    readonly agentId: string;
    readonly label: string;
    readonly transcriptPath: string;
    readonly lastActivityAt: string;
    readonly working: boolean;
}

/**
 * What must survive between sweeps, per parent session.
 *
 * `order` is the reason this is not a pure function: a subagent's number is
 * whatever it got the first time it was seen. Numbering by anything read off
 * the filesystem — mtime, readdir order — renumbers live chips underneath the
 * viewer as other subagents come and go.
 */
export interface SubagentScanState {
    readonly order: Map<string, number>;
    readonly labels: Map<string, string>;
    tail: TailState | null;
    nextNumber: number;
    launchSeen: boolean;
    driftLogged: boolean;
}

export const initialSubagentScanState = (): SubagentScanState => ({
    order: new Map(),
    labels: new Map(),
    tail: initialTailState(),
    nextNumber: 1,
    launchSeen: false,
    driftLogged: false,
});

/** Where Claude Code keeps this session's subagent transcripts. */
export const subagentDirFor = (parentTranscriptPath: string): string =>
    join(dirname(parentTranscriptPath), basename(parentTranscriptPath, '.jsonl'), 'subagents');

/**
 * Watch the parent for the one thing the transcript directory cannot say: that
 * a subagent was launched at all. That is what separates "this session never
 * spawned" from "Claude Code stopped writing where we look" (see the drift log
 * below).
 *
 * An `Agent` tool call is the signal — both spawn kinds make one, while the
 * launch record (`toolUseResult.agentId`) is written only for the async ones.
 * It is not every spawn: measured 2026-09-13 over every session on this
 * machine, 33 of the 137 sessions that have subagent transcripts never called
 * `Agent` in the parent (a skill or a teammate spawned them). Those sessions
 * keep working; they just cannot report layout drift, which is a diagnostic.
 *
 * Incremental on purpose — a parent transcript reaches megabytes, and this runs
 * every sweep. `readTranscriptDelta` returns null when the file has not moved,
 * which is the normal case and costs nothing.
 */
const isAgentToolUse = (line: string): boolean => {
    // Cheap reject first: parsing every line of a megabyte transcript to find
    // one tool call would undo what the incremental read is for. The substring
    // alone is not the answer — a transcript that merely QUOTES this code (a
    // review of this file, say) contains it as prose.
    if (!line.includes('"name":"Agent"')) return false;
    let entry: { message?: { content?: unknown } };
    try {
        entry = JSON.parse(line);
    } catch {
        return false;
    }
    const content = entry.message?.content;
    return Array.isArray(content)
        && content.some((block) => block?.type === 'tool_use' && block?.name === 'Agent');
};

const absorbParentDelta = (parentTranscriptPath: string, state: SubagentScanState): void => {
    if (state.launchSeen) return;
    const read = readTranscriptDelta(parentTranscriptPath, state.tail);
    if (!read) return;
    state.tail = read.state;
    state.launchSeen = read.lines.some(isAgentToolUse);
};

/**
 * The subagent's own label, from the sidecar Claude Code writes beside its
 * transcript (`agent-<id>.meta.json`).
 *
 * Measured 2026-09-13 over every session on this machine — 823 subagent
 * transcripts, 823 sidecars, `agentType` on all of them and `description` on
 * 817 — while the parent's launch record covers only the async spawns (53%).
 * So the sidecar is the source, and the parent is read for nothing but the
 * fact that a spawn happened.
 */
const readSidecarLabel = (transcriptPath: string): string | null => {
    let meta: { description?: unknown; agentType?: unknown };
    try {
        meta = JSON.parse(readFileSync(`${transcriptPath.slice(0, -'.jsonl'.length)}.meta.json`, 'utf-8'));
    } catch {
        return null;
    }
    for (const value of [meta.description, meta.agentType]) {
        if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return null;
};

/**
 * The label for one subagent, cached once found. A positional fallback is NOT
 * cached: the sidecar is written beside the transcript, so a scan that caught a
 * subagent in its first moments can still learn its name on the next sweep.
 */
const rememberLabel = (state: SubagentScanState, agentId: string, transcriptPath: string, number: number): string => {
    const label = readSidecarLabel(transcriptPath);
    if (!label) return `Agent ${number}`;
    state.labels.set(agentId, label);
    return label;
};

interface AgentFile {
    readonly agentId: string;
    readonly path: string;
    readonly mtimeMs: number;
}

/** `null` ONLY when the directory is not there — an unreadable one is reported
 *  as its own failure rather than as the layout having moved. */
const readAgentFiles = (dir: string, log?: (message: string) => void): AgentFile[] | null => {
    let names: string[];
    try {
        names = readdirSync(dir);
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
        log?.(`! ${dir}: unreadable (${(err as Error).message}) — subagents of this session stay hidden`);
        return [];
    }
    const files: AgentFile[] = [];
    for (const name of names) {
        const agentId = AGENT_FILE.exec(name)?.[1];
        if (!agentId) continue;
        const path = join(dir, name);
        try {
            files.push({ agentId, path, mtimeMs: statSync(path).mtimeMs });
        } catch {
            // Vanished between readdir and stat: a subagent file is never
            // rewritten, so this is a deletion, not a race worth reporting.
        }
    }
    return files;
};

/**
 * The live subagents of one Claude Code session, in chip order (by number).
 *
 * `state` is mutated — it belongs to the caller and lives as long as the
 * session does, which is what keeps a chip's number and label stable across
 * sweeps.
 */
export const scanSubagents = (
    parentName: string,
    parentTranscriptPath: string,
    state: SubagentScanState,
    opts: { now?: number; log?: (message: string) => void; reserved?: ReadonlySet<number> } = {},
): SubagentRow[] => {
    const now = opts.now ?? Date.now();
    absorbParentDelta(parentTranscriptPath, state);

    const dir = subagentDirFor(parentTranscriptPath);
    const files = readAgentFiles(dir, opts.log);
    if (!files) {
        // No directory. Only surprising once the parent has said it launched
        // something — before that, this is every session that never spawned.
        if (state.launchSeen && !state.driftLogged) {
            state.driftLogged = true;
            opts.log?.(`! ${parentName}: launched a subagent but ${dir} does not exist — Claude Code layout changed?`);
        }
        return [];
    }

    const live = files
        .filter((file) => now - file.mtimeMs <= SUBAGENT_LIVE_MS)
        .sort((a, b) => b.mtimeMs - a.mtimeMs)
        .slice(0, MAX_SUBAGENT_ROWS);

    // Numbered in activity order, then handed back in number order: the cut
    // above keeps the subagents worth showing, and this keeps the chips from
    // swapping places under the viewer every time one of them writes a line.
    const rows = live.map((file) => {
        // A pane subagent of the same session owns its pane id as a number
        // (`zeph-x.48`), and two rows with one name is a switcher showing the
        // wrong transcript. Checked on every sweep, not only when the number is
        // first handed out: pane ids keep being created, so a number that was
        // free can stop being free — and a chip that renumbers beats two chips
        // that are the same session name.
        let number = state.order.get(file.agentId);
        if (number === undefined || opts.reserved?.has(number)) {
            while (opts.reserved?.has(state.nextNumber)) state.nextNumber++;
            number = state.nextNumber++;
            state.order.set(file.agentId, number);
        }
        return {
            number,
            name: `${parentName}.${number}`,
            agentId: file.agentId,
            label: state.labels.get(file.agentId) ?? rememberLabel(state, file.agentId, file.path, number),
            transcriptPath: file.path,
            lastActivityAt: new Date(file.mtimeMs).toISOString(),
            working: now - file.mtimeMs <= SUBAGENT_WORKING_MS,
        };
    });
    return rows.sort((a, b) => a.number - b.number).map(({ number: _number, ...row }) => row);
};
