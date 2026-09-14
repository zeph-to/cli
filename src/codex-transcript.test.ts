import { describe, it, expect } from 'vitest';

import { projectCodexEntries } from './codex-transcript.js';
import { MAX_EVENT_FIELD_CHARS, MAX_EVENT_TEXT_CHARS } from './transcript-tail.js';

/**
 * Codex's line shapes, built by hand from what the writer emits (codex-cli
 * 0.154.0) and what a real rollout on this machine contains. Hand-built rather
 * than copied out of a live file for the same reason pi's fixtures are: a
 * fixture lifted from a transcript the projector also parsed proves only that
 * the projector agrees with itself.
 */
const line = (obj: unknown): string => JSON.stringify(obj);

const AT = '2026-09-14T00:00:00.000Z';

const event = (payload: Record<string, unknown>, ordinal = 1, timestamp = AT) =>
    line({ timestamp, ordinal, type: 'event_msg', payload });

const item = (it: Record<string, unknown>, ordinal = 1, timestamp = AT) =>
    event({ type: 'item_completed', item: it, turn_id: 't1' }, ordinal, timestamp);

const userLine = (text: string, id = 'u1') =>
    item({ type: 'UserMessage', id, client_id: null, content: line([{ type: 'text', text, text_elements: [] }]) });

const agentLine = (text: string, phase = 'final_answer', id = 'm1') =>
    item({ type: 'AgentMessage', id, phase, content: line([{ type: 'Text', text }]) });

const commandLine = (
    id: string,
    parsed: Record<string, unknown> | null,
    exitCode = 0,
    output = 'one\ntwo\nthree',
) => item({
    type: 'CommandExecution',
    id,
    command: ['/bin/zsh', '-lc', 'whatever the agent actually wrote'],
    parsed_cmd: parsed ? [parsed] : [],
    exit_code: exitCode,
    status: exitCode === 0 ? 'completed' : 'failed',
    aggregated_output: output,
});

describe('projectCodexEntries', () => {
    it('carries what the person asked', () => {
        expect(projectCodexEntries([userLine('ship the thing')])).toEqual([
            { kind: 'prompt', text: 'ship the thing', at: AT },
        ]);
    });

    it('carries what the agent replied', () => {
        expect(projectCodexEntries([agentLine('here is what I found')])).toEqual([
            { kind: 'text', text: 'here is what I found', at: AT },
        ]);
    });

    /*
     * The reason this projector reads `event_msg` and not `response_item`.
     *
     * Codex files its own injections under `role: 'user'` in the `response_item`
     * lane and stamps no provenance on them — measured in a real rollout, the
     * first user-role entry is `# AGENTS.md instructions …` followed by an
     * `<environment_context>` block naming this machine's paths, and it carries
     * the same keys as a message the person typed. The `item_completed` lane
     * files only the person's own messages, so Codex has already drawn the line
     * this projector needs.
     */
    describe('does not attribute the harness\'s own injections to the person', () => {
        const injected = [
            line({
                timestamp: AT,
                ordinal: 1,
                type: 'response_item',
                payload: {
                    type: 'message',
                    role: 'user',
                    id: 'r1',
                    content: [
                        { type: 'input_text', text: '# AGENTS.md instructions\n<INSTRUCTIONS>secrets</INSTRUCTIONS>' },
                        { type: 'input_text', text: '<environment_context>\n <cwd>/Users/tak/private</cwd>\n</environment_context>' },
                    ],
                },
            }),
            line({
                timestamp: AT,
                ordinal: 2,
                type: 'response_item',
                payload: { type: 'message', role: 'developer', id: 'r2', content: [{ type: 'input_text', text: '<skills_instructions>…' }] },
            }),
        ];

        it('draws no row from the response_item lane at all', () => {
            expect(projectCodexEntries(injected)).toEqual([]);
        });

        it('leaks neither the injected text nor the paths inside it', () => {
            const wire = JSON.stringify(projectCodexEntries([...injected, userLine('the only real row')]));
            expect(wire).not.toContain('AGENTS.md');
            expect(wire).not.toContain('/Users/tak/private');
            expect(wire).not.toContain('skills_instructions');
            expect(wire).toContain('the only real row');
        });
    });

    /*
     * A shell call reaches the timeline as Codex's own reading of it —
     * `parsed_cmd` — and never as the command line. The raw `command` is
     * `['/bin/zsh', '-lc', <the whole script>]`, which is the field most likely
     * to hold a token, an Authorization header or a signed URL.
     */
    describe('a shell call shows Codex\'s reading of it and never the command line', () => {
        it('pairs the call with its result', () => {
            const events = projectCodexEntries([
                commandLine('exec-1', { type: 'read', cmd: 'sed -n 1,240p /src/index.ts', name: 'index.ts', path: '/src/index.ts' }),
            ]);

            expect(events).toEqual([
                { kind: 'tool', id: 'exec-1', name: 'read', target: 'index.ts', at: AT },
                { kind: 'tool_result', id: 'exec-1', ok: true, lines: 3, at: AT },
            ]);
        });

        it('marks a failed command', () => {
            const [, result] = projectCodexEntries([
                commandLine('exec-2', { type: 'unknown', cmd: 'npm test' }, 1),
            ]);
            expect(result).toMatchObject({ kind: 'tool_result', id: 'exec-2', ok: false });
        });

        /*
         * An interrupted command completes as an item without ever having
         * exited. Reading a missing `exit_code` as 0 would draw a green result
         * row for work that never finished, which is the one thing a result row
         * must never say.
         */
        it.each([
            ['completed', true],
            ['aborted', false],
            ['failed', false],
        ])('falls back to status %s when the command never exited', (status, ok) => {
            const [, result] = projectCodexEntries([
                item({
                    type: 'CommandExecution',
                    id: 'exec-9',
                    command: ['/bin/zsh', '-lc', 'npm run build'],
                    parsed_cmd: [{ type: 'unknown' }],
                    status,
                    aggregated_output: '',
                }),
            ]);
            expect(result).toMatchObject({ kind: 'tool_result', id: 'exec-9', ok });
        });

        // Every real `aggregated_output` ends with a newline, and `lines` has to
        // mean the same number on the wire whichever agent produced it — the
        // shared `resultLinesOf` ends the last line on a trailing newline rather
        // than starting another.
        it('counts output lines the way every other projector counts them', () => {
            const [, result] = projectCodexEntries([
                commandLine('exec-6', { type: 'read', name: 'a.ts' }, 0, 'one\ntwo\nthree\n'),
            ]);
            expect(result).toMatchObject({ lines: 3 });
        });

        it('falls back to a bare exec row when Codex parsed nothing', () => {
            const [tool] = projectCodexEntries([commandLine('exec-3', null)]);
            expect(tool).toEqual({ kind: 'tool', id: 'exec-3', name: 'exec', at: AT });
        });

        it.each([
            'curl -H "Authorization: Bearer sk-live-abcd1234" https://api.example.com',
            'psql postgres://user:hunter2@db.example.com/prod -c "select 1"',
            'echo ghp_AAAABBBBCCCCDDDD | gh auth login --with-token',
        ])('carries nothing out of the command line of %s', (command) => {
            const wire = JSON.stringify(projectCodexEntries([
                item({
                    type: 'CommandExecution',
                    id: 'exec-4',
                    command: ['/bin/zsh', '-lc', command],
                    parsed_cmd: [{ type: 'unknown', cmd: command }],
                    exit_code: 0,
                    aggregated_output: '',
                }),
            ]));

            expect(wire).not.toMatch(/hunter2|sk-live|ghp_|Authorization/);
        });
    });

    it('reads a web search as the tool it is', () => {
        const events = projectCodexEntries([
            item({
                type: 'Extension',
                id: 'ext-1',
                kind: 'web.search',
                query: 'how to set default model',
                action: { type: 'search', query: 'how to set default model' },
                results: [{}, {}, {}],
            }),
        ]);

        expect(events).toEqual([
            { kind: 'tool', id: 'ext-1', name: 'web.search', target: 'how to set default model', at: AT },
            { kind: 'tool_result', id: 'ext-1', ok: true, lines: 3, at: AT },
        ]);
    });

    /*
     * Codex reports usage as one already-total input number with the cached half
     * inside it, unlike Claude's three separate counters — adding them would
     * double-count the cache. `last_token_usage` is this turn's;
     * `total_token_usage` is the session's running sum and would make every row
     * report the whole session.
     */
    it('takes this turn\'s usage and not the session\'s running total', () => {
        const events = projectCodexEntries([
            line({ timestamp: AT, ordinal: 5, type: 'turn_context', payload: { model: 'gpt-5.6-luna', cwd: '/x' } }),
            event({
                type: 'token_count',
                info: {
                    total_token_usage: { input_tokens: 99_999, output_tokens: 8_888, reasoning_output_tokens: 777, total_tokens: 108_887 },
                    last_token_usage: { input_tokens: 20_423, cached_input_tokens: 5_888, output_tokens: 125, reasoning_output_tokens: 29 },
                    model_context_window: 258_400,
                },
            }, 36),
        ]);

        expect(events).toEqual([
            { kind: 'msg', mid: '36', model: 'gpt-5.6-luna', out: 125, ctx: 20_423, thinking: 29, at: AT },
        ]);
    });

    /*
     * A Codex release that renames `ordinal` would otherwise drop every usage
     * row, blanking the phone's token readout with no other symptom. The
     * stand-in has to stay distinct across ticks as well as within one: the
     * viewer dedupes by `mid`, and every tick has a `lines[0]`, so a bare index
     * would collapse two ticks' numbers into whichever arrived first.
     */
    it('still reports usage when the line carries no ordinal', () => {
        const usage = (timestamp: string, output: number) => line({
            timestamp,
            type: 'event_msg',
            payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 10, output_tokens: output } } },
        });

        const [first] = projectCodexEntries([usage(AT, 2)]);
        const [second] = projectCodexEntries([usage('2026-09-14T00:00:01.000Z', 9)]);

        expect(first).toMatchObject({ kind: 'msg', out: 2, ctx: 10 });
        expect((first as { mid: string }).mid).not.toBe((second as { mid: string }).mid);
    });

    it('reports no model until a turn_context has named one', () => {
        const [msg] = projectCodexEntries([
            event({ type: 'token_count', info: { last_token_usage: { input_tokens: 10, output_tokens: 2 } } }, 3),
        ]);
        expect(msg).toEqual({ kind: 'msg', mid: '3', out: 2, ctx: 10, at: AT });
    });

    /*
     * Codex's content kinds include `SkillMention`, `Image` and `Audio`. One of
     * those carrying an incidental `text` field would be glued into the middle
     * of what the phone renders as the person's own sentence.
     */
    it('takes prose only out of text blocks, whichever capital Codex used', () => {
        const [prompt] = projectCodexEntries([
            item({
                type: 'UserMessage',
                id: 'u1',
                content: line([
                    { type: 'text', text: 'what the person typed' },
                    { type: 'SkillMention', text: ' /Users/tak/.codex/skills/secret/SKILL.md' },
                    { type: 'Image', text: ' data:image/png;base64,AAAA' },
                ]),
            }),
        ]);

        expect(prompt).toEqual({ kind: 'prompt', text: 'what the person typed', at: AT });
    });

    it('collapses a multi-line target into one row', () => {
        const [tool] = projectCodexEntries([
            commandLine('exec-7', { type: 'search', query: 'first line\n\nsecond   line' }),
        ]);
        expect(tool).toMatchObject({ target: 'first line second line' });
    });

    it('drops reasoning, which is what the agent considered and not what it did', () => {
        const events = projectCodexEntries([
            item({ type: 'Reasoning', id: 'rs-1', summary_text: 'a private deliberation', raw_content: 'more of it' }),
            agentLine('here is what I found'),
        ]);

        expect(events).toEqual([{ kind: 'text', text: 'here is what I found', at: AT }]);
        expect(JSON.stringify(events)).not.toContain('private deliberation');
    });

    /*
     * Codex ships item types no session on this machine has produced
     * (`FileChange`, `McpToolCall`) and will ship more. An unnamed one draws no
     * row: naming it without reading its fields strands a call that never
     * resolves, and reading its fields without a sample is guessing at a
     * vendor's format.
     */
    it('skips an item type this projector has never seen, without breaking the run around it', () => {
        const events = projectCodexEntries([
            item({ type: 'FileChange', id: 'fc-1', changes: [{ path: '/secret/local/path.ts' }] }),
            item({ type: 'SomethingCodexAddedLater', id: 'x-1', whatever: true }),
            agentLine('still standing'),
        ]);

        expect(events).toEqual([{ kind: 'text', text: 'still standing', at: AT }]);
        expect(JSON.stringify(events)).not.toContain('/secret/local/path.ts');
    });

    it('skips Codex bookkeeping that is not something the agent did', () => {
        const events = projectCodexEntries([
            line({ timestamp: AT, ordinal: 1, type: 'session_meta', payload: { cwd: '/x', base_instructions: 'a wall of prompt' } }),
            line({ timestamp: AT, ordinal: 2, type: 'world_state', payload: { full: true, state: {} } }),
            line({ timestamp: AT, ordinal: 3, type: 'token_usage_record', payload: {} }),
            event({ type: 'task_started', turn_id: 't1', model_context_window: 258_400 }),
            event({ type: 'task_complete', turn_id: 't1', duration_ms: 4_200, last_agent_message: 'done' }),
            event({ type: 'thread_settings_applied', thread_id: 'th1', thread_settings: {} }),
            userLine('the only real row'),
        ]);

        expect(events).toEqual([{ kind: 'prompt', text: 'the only real row', at: AT }]);
        expect(JSON.stringify(events)).not.toContain('a wall of prompt');
    });

    it('skips a malformed or truncated line instead of throwing', () => {
        const events = projectCodexEntries([
            '{"type":"event_msg","payload":{"type":"item_comple',
            'not json at all',
            '',
            'null',
            '[]',
            line({ timestamp: AT, ordinal: 1, type: 'event_msg' }),
            item({ type: 'UserMessage', id: 'u9', content: 'not an encoded array' }),
            item({ type: 'UserMessage' }),
            userLine('still standing'),
        ]);

        expect(events).toEqual([{ kind: 'prompt', text: 'still standing', at: AT }]);
    });

    it('clamps prose and labels to the budget every projector shares', () => {
        const [prompt] = projectCodexEntries([userLine('x'.repeat(MAX_EVENT_TEXT_CHARS + 500))]);
        expect((prompt as { text: string }).text.length).toBe(MAX_EVENT_TEXT_CHARS);

        const [tool] = projectCodexEntries([
            commandLine('exec-5', { type: 'read', name: 'n'.repeat(MAX_EVENT_FIELD_CHARS + 50) }),
        ]);
        expect((tool as { target: string }).target.length).toBe(MAX_EVENT_FIELD_CHARS);
    });

    it('backfills only the turn still in flight', () => {
        const events = projectCodexEntries([
            userLine('finished turn', 'u1'),
            commandLine('exec-old', { type: 'read', name: 'old.ts' }),
            userLine('current turn', 'u2'),
            commandLine('exec-new', { type: 'read', name: 'new.ts' }),
        ], { sinceLastPrompt: true });

        expect(JSON.stringify(events)).not.toContain('old.ts');
        expect(JSON.stringify(events)).toContain('new.ts');
        expect(events[0]).toMatchObject({ kind: 'prompt', text: 'current turn' });
    });
});
