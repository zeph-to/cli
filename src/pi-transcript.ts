/**
 * pi's transcript format, projected into the events the timeline draws.
 *
 * The second projector, and the one that proves the seam: `turn-watch` reads
 * this file's output through `TranscriptProjector` without knowing pi exists.
 * Everything here is pi's vocabulary and belongs to pi alone — a third agent
 * means a third file, not another branch in this one.
 *
 * Shape measured 2026-09-14 against `~/.pi/agent/sessions/**\/*.jsonl`
 * (40 sessions, 494 lines in the deepest), and the writer that produces it:
 * `@earendil-works/pi-coding-agent/dist/core/session-manager.js`, at its
 * `CURRENT_SESSION_VERSION = 3`.
 *
 * Nothing here refuses to read another version, and that is deliberate: an
 * unknown entry type falls out of the checks below and the timeline is thinner
 * by one row. A projector that stopped on a version bump would take the rows it
 * still understood down with it.
 */

import {
    clamp,
    finiteNumber,
    MAX_EVENT_TEXT_CHARS,
    resultLinesOf,
    targetFrom,
    type ProjectorOptions,
    type TranscriptProjector,
    type TurnEvent,
} from './transcript-tail.js';

/**
 * Which tool argument reads as "what this call is about", first match wins.
 *
 * pi's own list, deliberately not Claude's: pi has no `description` argument,
 * so the sentence-a-human-wrote field Claude's list leads with does not exist
 * here. `path` leads instead because it covers read/write/edit/grep, the calls
 * where the target is the whole point of the row. `name` beats `task` because a
 * `subagent` call carries both and its `task` is a briefing — measured at 300+
 * characters with embedded newlines, which renders as a wall, not a label.
 *
 * `command` is absent for the reason it is absent from Claude's list — a
 * command line is the argument most likely to carry a secret. `bashProgram`
 * below is what stands in for it.
 */
const PI_TARGET_KEYS = ['path', 'pattern', 'query', 'name', 'question', 'task', 'file_path'] as const;

/**
 * The program a shell call runs, and nothing else.
 *
 * Measured over 40 sessions: 1187 of ~1800 tool calls are `bash`/`guarded_bash`,
 * whose only argument is `command`. Dropping it wholesale — the rule Claude's
 * projector follows — would leave two thirds of a pi timeline as rows that say
 * "bash" and nothing more, which is a list of nothing. Carrying `command` whole
 * would put the field most likely to hold a token, an `Authorization` header or
 * a signed URL onto the wire.
 *
 * So only a bare program name leaves: `git`, `npm`, `curl`. Arguments never do,
 * which is where every one of those secrets lives.
 *
 * Three kinds of token are stepped over on the way to it, because stopping at
 * any of them produces a row that says nothing:
 *
 *  - `VAR=value` assignments, skipped rather than shown — the value is the
 *    secret-shaped half.
 *  - Flags. A leading `-l` is never the program.
 *  - A prefix builtin and everything up to the next `&&`, `||` or `;`. Measured
 *    over every pi session on this machine, `cd` is the first token of 786 of
 *    ~1400 shell calls — `cd <dir> && <the actual work>`. Reporting "cd" for
 *    the majority of a timeline's rows is the same as reporting nothing.
 */
const SHELL_PREFIX_BUILTINS = new Set(['cd', 'set', 'export', 'source', 'exec', 'time', 'env', '.']);

/** `&&`, `||`, `;`, `|` — split on them rather than scanning for them, because
 *  they are written glued to their neighbours as often as spaced (`cd /x&&ls`). */
const SHELL_SEPARATOR = /&&|\|\||[;|]/;

/** The program a single command segment runs, or undefined when it names none. */
const programOfSegment = (segment: string): string | undefined => {
    for (const token of segment.trim().split(/\s+/)) {
        if (!token) continue;
        // `FOO=bar cmd …` — the value is the secret-shaped half, so step over
        // the assignment entirely rather than reporting either half of it.
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) continue;
        // A flag where the program should be means this segment names no
        // program. Skipping it would promote the following argument — a path,
        // a URL — into the program slot, which is how `-l /some/path` would
        // otherwise be reported as `/some/path`.
        if (token.startsWith('-')) return undefined;
        return token;
    }
    return undefined;
};

const bashProgram = (input: unknown): string | undefined => {
    if (!input || typeof input !== 'object') return undefined;
    const command = (input as Record<string, unknown>).command;
    if (typeof command !== 'string') return undefined;

    // Split naively: a `|` or `;` inside quotes splits too, so a segment can
    // begin mid-string and name no program. That is safe — the worst outcome is
    // a missing label, never a wrong one that leaks an argument. The cap is a
    // separate concern: a pathological `cd a && cd b && …` chain costs a fixed
    // number of steps, not one per token of whatever the agent wrote.
    const segments = command.split(SHELL_SEPARATOR, 64);
    for (const segment of segments) {
        const program = programOfSegment(segment);
        if (program === undefined) continue;
        // `cd`, `set`, `env` … — real, but only ever a preamble to the work.
        if (SHELL_PREFIX_BUILTINS.has(program)) continue;
        return clamp(program);
    }
    return undefined;
};

/**
 * Wrappers pi uses when it injects context into the `user` role.
 *
 * pi stamps no provenance on an entry — measured across every session on this
 * machine, a harness injection and a typed message carry byte-identical keys
 * (`id,message,parentId,timestamp,type`), so the `origin.kind`/`promptSource`
 * check Claude's projector makes has no counterpart here. The opening wrapper is
 * the only signal there is.
 *
 * What they hold is why this matters: `<file name="/Users/…/artifacts/…">` and
 * `<skill name="02-implement" location="/Users/…/SKILL.md">` carry a whole file
 * or skill body plus absolute local paths, and without this they reach the phone
 * as the user's own words.
 *
 * Measured over the 131 user-role messages in `~/.pi/agent/sessions` on this
 * machine: 29 entries open with `<file`, 17 with `<skill`, and nothing else
 * opens with a tag at all. The list is exactly what was observed, so a wrapper
 * pi adds later needs adding here — and only after it is seen, because the cost
 * of a wrong guess runs the other way: `<pm>` reads like one of these and is
 * not, it is the plan template's package-manager placeholder appearing in prose
 * a person wrote, and filtering on it would delete their message.
 *
 * These entries are dropped whole rather than stripped, unlike Claude's
 * `<system-reminder>` blocks, because there is no human half to keep — the
 * injection IS the entry.
 */
const PI_INJECTED_PROMPT = /^\s*<(file|skill)[\s>]/;

/** Text out of pi's content blocks — every role builds its prose the same way. */
const textOf = (content: unknown): string => {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    let text = '';
    for (const block of content) {
        if (!block || typeof block !== 'object') continue;
        const item = block as Record<string, unknown>;
        if (item.type === 'text' && typeof item.text === 'string') text += item.text;
    }
    return text;
};

/**
 * One line, always.
 *
 * pi's `subagent` calls carry a `task` briefing that runs to hundreds of
 * characters with newlines in it — measured at 2 of 1825 tool calls, which is
 * rare but renders as a wall of text where a label belongs. Collapsed here
 * rather than inside the shared `targetFrom`, because that helper feeds Claude's
 * projector too and the Spec requires a Claude timeline to stay byte-identical.
 */
const oneLine = (target: string | undefined): string | undefined => target?.replace(/\s+/g, ' ');

/**
 * pi writes one line per message, not one per content block, so a message's
 * `msg` event needs no merging across lines — the one place this projector is
 * simpler than Claude's.
 */
export const projectPiEntries: TranscriptProjector = (lines, opts: ProjectorOptions = {}): TurnEvent[] => {
    const events: TurnEvent[] = [];

    for (const raw of lines) {
        let entry: Record<string, unknown>;
        try {
            const parsed: unknown = JSON.parse(raw);
            if (!parsed || typeof parsed !== 'object') continue;
            entry = parsed as Record<string, unknown>;
        } catch {
            continue;
        }

        // `session`, `model_change`, `thinking_level_change`, `compaction`,
        // `custom`, `custom_message` — pi's bookkeeping. None of it is
        // something the agent did, and an entry type added in a later version
        // lands here too rather than breaking the watch.
        if (entry.type !== 'message') continue;

        const message = entry.message;
        if (!message || typeof message !== 'object') continue;
        const msg = message as Record<string, unknown>;
        const at = typeof entry.timestamp === 'string' ? entry.timestamp : undefined;
        const stamp = at ? { at } : {};

        if (msg.role === 'user') {
            // What the person typed. Carried for the same reason Claude's
            // prompts are: without it the timeline records no question — but
            // only once the harness's own injections have been ruled out, since
            // pi files those under this role too.
            const text = textOf(msg.content).trim();
            if (text && !PI_INJECTED_PROMPT.test(text)) {
                events.push({ kind: 'prompt', text: clamp(text, MAX_EVENT_TEXT_CHARS), ...stamp });
            }
            continue;
        }

        if (msg.role === 'toolResult') {
            if (typeof msg.toolCallId !== 'string') continue;
            const resultLines = resultLinesOf(msg.content);
            events.push({
                kind: 'tool_result',
                id: msg.toolCallId,
                ok: msg.isError !== true,
                ...(resultLines ? { lines: resultLines } : {}),
                ...stamp,
            });
            continue;
        }

        if (msg.role !== 'assistant') continue;

        const content = Array.isArray(msg.content) ? msg.content : [];
        const usage = msg.usage;
        if (usage && typeof usage === 'object' && typeof entry.id === 'string') {
            const u = usage as Record<string, unknown>;
            const thinking = content.filter(
                (block) => block && typeof block === 'object' && (block as Record<string, unknown>).type === 'thinking',
            ).length;
            events.push({
                kind: 'msg',
                mid: clamp(entry.id),
                ...(typeof msg.model === 'string' ? { model: clamp(msg.model) } : {}),
                out: finiteNumber(u.output),
                ctx: finiteNumber(u.input) + finiteNumber(u.cacheRead) + finiteNumber(u.cacheWrite),
                ...(thinking ? { thinking } : {}),
                ...stamp,
            });
        }

        for (const block of content) {
            if (!block || typeof block !== 'object') continue;
            const item = block as Record<string, unknown>;

            if (item.type === 'toolCall' && typeof item.id === 'string' && typeof item.name === 'string') {
                const target = oneLine(targetFrom(item.arguments, PI_TARGET_KEYS)) ?? bashProgram(item.arguments);
                events.push({
                    kind: 'tool',
                    id: item.id,
                    name: clamp(item.name),
                    ...(target ? { target } : {}),
                    ...stamp,
                });
                continue;
            }

            if (item.type === 'text' && typeof item.text === 'string' && item.text.trim()) {
                events.push({ kind: 'text', text: clamp(item.text, MAX_EVENT_TEXT_CHARS), ...stamp });
            }
            // `thinking` falls through on purpose, exactly as it does for Claude:
            // the timeline shows what the agent did, not what it considered.
            // Only the count leaves, on `msg` above.
        }
    }

    if (!opts.sinceLastPrompt) return events;

    const lastPrompt = events.map((e) => e.kind).lastIndexOf('prompt');
    return lastPrompt === -1 ? events : events.slice(lastPrompt);
};
