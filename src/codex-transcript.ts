/**
 * Codex's rollout format, projected into the events the timeline draws.
 *
 * The third projector. Like pi's, everything here is Codex's vocabulary and
 * belongs to Codex alone — `turn-watch` reaches it through `TranscriptProjector`
 * and knows nothing about any of it.
 *
 * Shape measured 2026-09-14 against `~/.codex/sessions/2026/09/14/rollout-…jsonl`
 * (77 lines, codex-cli 0.154.0, `gpt-5.6-luna`), cross-checked against the
 * strings in the writer itself (`~/.codex/packages/standalone/current/bin/codex`)
 * for the entry types that session happens not to contain.
 *
 * Every line is `{ timestamp, ordinal, type, payload }`. Two lanes describe the
 * same turn, and this projector reads exactly one of them:
 *
 *  - `response_item` — what goes to the model: `message`, `reasoning`,
 *    `custom_tool_call`, `function_call` and their `_output` twins.
 *  - `event_msg` — what the UI is told: `item_completed` wrapping a typed
 *    `item`, plus `token_count` and the task markers.
 *
 * `event_msg` wins, for three reasons measured in that session:
 *
 *  1. Its `UserMessage` items are the person's messages *only*. The
 *     `response_item` lane files Codex's own injections under `role: 'user'`
 *     too — the first user-role entry there is `# AGENTS.md instructions …`
 *     followed by `<environment_context>` — and stamps no provenance on them.
 *     Four user-role `response_item`s, three `UserMessage` items, and the one
 *     left out is the injection. Codex has already made this call; pi's
 *     projector had to guess at it with a wrapper regex because pi has no
 *     equivalent lane.
 *  2. `CommandExecution` carries `parsed_cmd`, Codex's own reading of what a
 *     shell line does (`{ type: 'read', name: 'SKILL.md', path: '…' }`), plus
 *     `exit_code`. The `response_item` twin carries a JavaScript program —
 *     `const r = await tools.exec_command({cmd:"…"})` — whose command string
 *     would have to be parsed back out of source text to label a row.
 *  3. One lane cannot double-count. Reading both would put every tool call on
 *     the timeline twice, and the two lanes share no id to merge on.
 *
 * The cost is latency, and it is real: an `item_completed` is written when the
 * work finishes, so a two-minute build shows up two minutes in rather than at
 * its start. The `response_item` lane is written at call time but cannot say
 * whether the call succeeded — the honest row late beats the ambiguous row
 * early, and a timeline that showed a call and never its outcome is the worse
 * of the two failures.
 *
 * An item type this file does not name draws no row at all. Codex ships types no
 * session on this machine has produced (`FileChange`, `McpToolCall`, `WebSearch`
 * among the writer's strings) and will ship more; each needs a sample read before
 * it can be projected, and until then a thinner timeline is the honest one.
 */

import {
    clamp,
    finiteNumber,
    MAX_EVENT_TEXT_CHARS,
    oneLine,
    resultLinesOf,
    targetFrom,
    type ProjectorOptions,
    type TranscriptProjector,
    type TurnEvent,
} from './transcript-tail.js';

/** The item types this projector knows. Anything else draws no row — see the file header. */
const CODEX_USER_MESSAGE = 'UserMessage';
const CODEX_AGENT_MESSAGE = 'AgentMessage';
const CODEX_REASONING = 'Reasoning';
const CODEX_COMMAND = 'CommandExecution';
const CODEX_EXTENSION = 'Extension';

/**
 * Which `parsed_cmd` field reads as "what this call is about", first match wins.
 *
 * Codex's own names, and a short list because `parsed_cmd` is already the
 * vendor's summary rather than raw argv: a `read` entry carries `name` (the
 * basename) and `path`, a search carries `query`. `cmd` — the reconstructed
 * command line, and the field most likely to hold a token or a signed URL — is
 * absent for the same reason `command` is absent from Claude's list.
 */
const CODEX_PARSED_KEYS = ['name', 'query', 'path'] as const;

/**
 * Codex nests JSON inside JSON: an item's `content` arrives as a string holding
 * an encoded array. Null on anything that is not JSON, which the callers read as
 * "nothing to take from here".
 */
const safeParse = (raw: string): unknown => {
    try {
        return JSON.parse(raw);
    } catch {
        return null;
    }
};

/** Prose out of a Codex content array. */
const textOf = (content: unknown): string => {
    const items = typeof content === 'string' ? safeParse(content) : content;
    if (!Array.isArray(items)) return '';
    let text = '';
    for (const block of items) {
        if (!block || typeof block !== 'object') continue;
        const item = block as Record<string, unknown>;
        // `UserMessage` blocks are typed `text`, `AgentMessage` blocks `Text` —
        // measured, not assumed. The type IS checked, because the writer's
        // content kinds include `SkillMention`, `Image` and `Audio`, and one of
        // those carrying an incidental `text` field would otherwise be glued
        // into the middle of what reads as the person's own sentence.
        if (typeof item.type !== 'string' || item.type.toLowerCase() !== 'text') continue;
        if (typeof item.text === 'string') text += item.text;
    }
    return text;
};

/**
 * Whether a completed command actually succeeded.
 *
 * `exit_code` decides when there is one, and the absence of one is NOT success:
 * an interrupted or aborted command completes as an item without ever having
 * exited, and coercing that to 0 draws a green row for work that never
 * finished. `status` is what Codex itself reports then — measured as
 * `'completed'` on every item in the sampled session, alongside `failed` and
 * `aborted` in the writer's own strings.
 */
const succeeded = (item: Record<string, unknown>): boolean =>
    typeof item.exit_code === 'number' ? item.exit_code === 0 : item.status === 'completed';

const record = (value: unknown): Record<string, unknown> | null =>
    value && typeof value === 'object' ? (value as Record<string, unknown>) : null;

/**
 * The usage numbers on a `token_count` event.
 *
 * `last_token_usage` is this turn's, `total_token_usage` the session's running
 * sum — the running one would make every row report the whole session.
 *
 * One event per usage tick, NOT one per assistant message: the sampled session
 * holds 7 `token_count` events against 5 `AgentMessage` items across 3 turns.
 * `mid` therefore means "one usage tick" here where it means "one API message"
 * for Claude. The viewer only dedupes on it, so the finer grain costs nothing —
 * but it is not a message id and nothing downstream may read it as one.
 *
 * Codex reports `input_tokens` as the full prompt with `cached_input_tokens`
 * already inside it (measured: 16054 input of which 11904 cached, totalling 16067 with
 * 13 output), so unlike Claude's three separate counters it is already the
 * context number and must not be added to.
 */
const usageEvent = (
    payload: Record<string, unknown>,
    ordinal: unknown,
    index: number,
    model: string | undefined,
    at: string | undefined,
): Extract<TurnEvent, { kind: 'msg' }> | null => {
    const info = record(payload.info);
    const last = info && record(info.last_token_usage);
    if (!last) return null;
    // Codex stamps no id on a usage event, so the line's own ordinal is the id:
    // unique within a rollout and monotonic, which is all `mid` is for. A Codex
    // release that renamed the field would otherwise drop every usage row,
    // blanking the phone's token readout with no other symptom — so the line's
    // timestamp and position stand in. The timestamp carries the weight: an
    // index alone repeats across ticks (every tick has a `lines[0]`), and the
    // viewer dedupes by `mid`, so two ticks' numbers would collapse into one.
    const mid = typeof ordinal === 'number' ? String(ordinal) : `line-${at ?? 'unstamped'}-${index}`;
    const reasoning = finiteNumber(last.reasoning_output_tokens);
    return {
        kind: 'msg',
        mid,
        ...(model ? { model: clamp(model) } : {}),
        out: finiteNumber(last.output_tokens),
        ctx: finiteNumber(last.input_tokens),
        // Codex reports reasoning as tokens, not blocks. A non-zero count is
        // still "it thought here", which is the only thing this field draws.
        ...(reasoning ? { thinking: reasoning } : {}),
        ...(at ? { at } : {}),
    };
};

/**
 * Codex writes one line per completed item, so no event needs merging across
 * lines — the same place this projector is simpler than Claude's.
 */
export const projectCodexEntries: TranscriptProjector = (lines, opts: ProjectorOptions = {}): TurnEvent[] => {
    const events: TurnEvent[] = [];
    // The model is stamped on `turn_context`, once per turn, ahead of the usage
    // events it applies to. Carried forward rather than looked up, because a
    // tail that begins mid-session may never see one.
    let model: string | undefined;

    for (let index = 0; index < lines.length; index++) {
        const entry = record(safeParse(lines[index]));
        if (!entry) continue;

        const at = typeof entry.timestamp === 'string' ? entry.timestamp : undefined;
        const stamp = at ? { at } : {};

        if (entry.type === 'turn_context') {
            const payload = record(entry.payload);
            if (payload && typeof payload.model === 'string') model = payload.model;
            continue;
        }

        // `session_meta` is the cwd header the resolver reads, `world_state` and
        // `token_usage_record` are bookkeeping, and `response_item` is the lane
        // this projector deliberately does not read.
        if (entry.type !== 'event_msg') continue;

        const payload = record(entry.payload);
        if (!payload) continue;

        if (payload.type === 'token_count') {
            const usage = usageEvent(payload, entry.ordinal, index, model, at);
            if (usage) events.push(usage);
            continue;
        }

        if (payload.type !== 'item_completed') continue;
        const item = record(payload.item);
        if (!item || typeof item.type !== 'string' || typeof item.id !== 'string') continue;

        if (item.type === CODEX_USER_MESSAGE) {
            const text = textOf(item.content).trim();
            if (text) events.push({ kind: 'prompt', text: clamp(text, MAX_EVENT_TEXT_CHARS), ...stamp });
            continue;
        }

        if (item.type === CODEX_AGENT_MESSAGE) {
            const text = textOf(item.content).trim();
            if (text) events.push({ kind: 'text', text: clamp(text, MAX_EVENT_TEXT_CHARS), ...stamp });
            continue;
        }

        // Reasoning is what the agent considered, not what it did — dropped
        // here exactly as thinking blocks are for Claude and pi. Its size still
        // reaches the timeline, as the `thinking` field on the usage event.
        if (item.type === CODEX_REASONING) continue;

        if (item.type === CODEX_COMMAND) {
            const parsed = Array.isArray(item.parsed_cmd) ? record(item.parsed_cmd[0]) : null;
            // Codex's own reading of the command — `read`, `search`, `unknown`.
            // The raw `command` argv is never consulted: it is `['/bin/zsh',
            // '-lc', <the whole script>]`, which is the shape that carries
            // secrets.
            const name = parsed && typeof parsed.type === 'string' ? parsed.type : 'exec';
            const target = oneLine(targetFrom(parsed, CODEX_PARSED_KEYS));
            const lines = resultLinesOf(item.aggregated_output);
            events.push({ kind: 'tool', id: item.id, name: clamp(name), ...(target ? { target } : {}), ...stamp });
            events.push({
                kind: 'tool_result',
                id: item.id,
                ok: succeeded(item),
                ...(lines ? { lines } : {}),
                ...stamp,
            });
            continue;
        }

        if (item.type === CODEX_EXTENSION) {
            // `kind` is the extension that ran (`web.search`), `query` what it
            // was asked. A search query is the user's own words, already on the
            // wire as the prompt that produced it.
            const name = typeof item.kind === 'string' ? item.kind : 'extension';
            const target = oneLine(typeof item.query === 'string' ? item.query : undefined);
            events.push({ kind: 'tool', id: item.id, name: clamp(name), ...(target ? { target: clamp(target) } : {}), ...stamp });
            events.push({
                kind: 'tool_result',
                id: item.id,
                // No failure field has been observed on an `Extension` item, and
                // an empty result list is a search that found nothing rather
                // than one that broke. Left as success until a failing sample
                // says what a failure looks like — a guessed field reads as a
                // red row on every successful search instead.
                ok: true,
                ...(Array.isArray(item.results) ? { lines: item.results.length } : {}),
                ...stamp,
            });
            continue;
        }

        // An item type this file has never seen falls out here, and the
        // timeline is thinner by one row rather than wrong by one. Naming it
        // without reading its fields would strand a call that never resolves;
        // reading its fields without a sample is guessing at a vendor's format.
    }

    if (!opts.sinceLastPrompt) return events;

    const lastPrompt = events.map((e) => e.kind).lastIndexOf('prompt');
    return lastPrompt === -1 ? events : events.slice(lastPrompt);
};
