import { describe, it, expect } from 'vitest';

import { projectPiEntries } from './pi-transcript.js';
import { MAX_EVENT_FIELD_CHARS, MAX_EVENT_TEXT_CHARS } from './transcript-tail.js';

/**
 * pi's line shapes, built by hand from what the writer emits
 * (`@earendil-works/pi-coding-agent/dist/core/session-manager.js`) and what 40
 * real sessions on this machine contain. Hand-built rather than copied from a
 * live file so the expectations stay independent of the projector — a fixture
 * lifted out of a transcript the projector also parsed proves only that it
 * agrees with itself.
 */
const line = (obj: unknown): string => JSON.stringify(obj);

const entry = (id: string, message: Record<string, unknown>, timestamp = '2026-09-14T00:00:00.000Z') =>
    line({ type: 'message', id, parentId: null, timestamp, message });

const userLine = (text: string, id = 'u1') => entry(id, { role: 'user', content: [{ type: 'text', text }] });

const toolCallLine = (id: string, callId: string, name: string, args: Record<string, unknown>) =>
    entry(id, { role: 'assistant', content: [{ type: 'toolCall', id: callId, name, arguments: args }] });

const toolResultLine = (id: string, callId: string, toolName: string, text: string, isError = false) =>
    entry(id, { role: 'toolResult', toolCallId: callId, toolName, isError, content: [{ type: 'text', text }] });

describe('projectPiEntries', () => {
    it('carries what the person asked', () => {
        expect(projectPiEntries([userLine('ship the thing')])).toEqual([
            { kind: 'prompt', text: 'ship the thing', at: '2026-09-14T00:00:00.000Z' },
        ]);
    });

    it('reads a tool call and the result that answers it', () => {
        const events = projectPiEntries([
            toolCallLine('a1', 'call_7', 'read', { path: '/src/index.ts' }),
            toolResultLine('r1', 'call_7', 'read', 'one\ntwo\nthree\n'),
        ]);

        expect(events).toEqual([
            { kind: 'tool', id: 'call_7', name: 'read', target: '/src/index.ts', at: '2026-09-14T00:00:00.000Z' },
            { kind: 'tool_result', id: 'call_7', ok: true, lines: 3, at: '2026-09-14T00:00:00.000Z' },
        ]);
    });

    /*
     * pi files its own context injections under `role: 'user'` and stamps no
     * provenance on them — a harness entry and a typed one carry identical
     * keys. Without the wrapper check these reach the phone as the user's own
     * words, carrying whole file bodies and this machine's absolute paths.
     */
    describe('does not attribute the harness\'s own injections to the person', () => {
        it.each([
            '<file name="/Users/tak/.pi/agent/sessions/--Users-tak-repo--/artifacts/01a0/context/report.md">\nbody\n</file>',
            '<skill name="02-implement" location="/Users/tak/.agents/skills/02-implement/SKILL.md">\nwhole skill body\n</skill>',
            '   <file name="/abs/path">leading whitespace still counts</file>',
        ])('drops an entry opening with %s', (text) => {
            expect(projectPiEntries([userLine(text)])).toEqual([]);
        });

        it('still carries a message that merely mentions one of those words', () => {
            const [prompt] = projectPiEntries([userLine('read the file and the skill, then report')]);
            expect(prompt).toMatchObject({ kind: 'prompt', text: 'read the file and the skill, then report' });
        });

        // `<pm>` is the plan template's package-manager placeholder, not a pi
        // wrapper — filtering on a tag that merely looks injected deletes a
        // person's message, which is the failure this filter must not cause.
        it.each(['<scope>cli only</scope> please', '<pm> run lint — is this right?'])(
            'still carries a message that merely opens with a tag: %s',
            (text) => {
                expect(projectPiEntries([userLine(text)])[0]).toMatchObject({ kind: 'prompt' });
            },
        );
    });

    // Claude's projector has the same posture and it is deliberate: a result
    // whose call landed in an earlier tick is the normal case, so merging by id
    // is the viewer's job. Pinned so the posture is a decision, not an accident.
    it('emits a tool result whose call is not in this batch, for the viewer to merge', () => {
        const [result] = projectPiEntries([toolResultLine('r1', 'call_from_an_earlier_tick', 'bash', 'ok')]);
        expect(result).toMatchObject({ kind: 'tool_result', id: 'call_from_an_earlier_tick', ok: true });
    });

    it('collapses a multi-line target into one row', () => {
        const [tool] = projectPiEntries([
            toolCallLine('a1', 'c1', 'subagent', { agent: 'x', task: 'first line\n\nsecond   line' }),
        ]);
        expect(tool).toMatchObject({ target: 'first line second line' });
    });

    it('marks a failed tool result', () => {
        const [result] = projectPiEntries([toolResultLine('r1', 'call_7', 'bash', 'boom', true)]);
        expect(result).toMatchObject({ kind: 'tool_result', id: 'call_7', ok: false });
    });

    // pi's argument names, not Claude's — `description` does not exist here.
    it.each([
        ['read', { path: '/a/b.ts' }, '/a/b.ts'],
        ['grep', { pattern: 'TODO', path: '/src' }, '/src'],
        ['search_graph', { query: 'who calls x', limit: 5 }, 'who calls x'],
        ['ask_user_question', { question: 'which one?', options: [] }, 'which one?'],
        // `name`, not `task`: a real subagent briefing runs to hundreds of
        // characters with newlines in it, and a label is not a paragraph.
        ['subagent', { agent: 'explorer', name: 'scout', task: 'map it\nin detail' }, 'scout'],
    ])('labels a %s call from its own arguments', (name, args, expected) => {
        const [tool] = projectPiEntries([toolCallLine('a1', 'c1', name, args)]);
        expect(tool).toMatchObject({ kind: 'tool', name, target: expected });
    });

    /*
     * The shell calls are the reason this projector needs a rule Claude's does
     * not. Two thirds of pi's tool calls are `bash`, whose only argument is
     * `command` — the field most likely to hold a token or a signed URL. The
     * program name is what reaches the wire; nothing after it ever does.
     */
    describe('a shell call shows its program and never its arguments', () => {
        const targetOfCommand = (command: string): string | undefined => {
            const [tool] = projectPiEntries([toolCallLine('a1', 'c1', 'bash', { command })]);
            return (tool as { target?: string }).target;
        };

        it('takes the program', () => {
            expect(targetOfCommand('git status --short')).toBe('git');
        });

        // `cd <dir> && <work>` is how most of pi's shell calls are written —
        // 786 of ~1400 measured. Stopping at `cd` labels the majority of a
        // timeline with the one word that carries no information.
        it.each([
            ['cd /Users/x/repo && npm test', 'npm'],
            ['cd /x && cd y && rg TODO src', 'rg'],
            ['cd /x&&ls -la', 'ls'],
            ['set -e; python3 build.py', 'python3'],
            ['-l /some/path', undefined],
            ['cd /only/a/directory', undefined],
        ])('reaches the real program in %s', (command, expected) => {
            expect(targetOfCommand(command)).toBe(expected);
        });

        it('drops a leading environment assignment rather than showing its value', () => {
            expect(targetOfCommand('AWS_SECRET_ACCESS_KEY=hunter2 aws s3 ls')).toBe('aws');
        });

        it.each([
            'curl -H "Authorization: Bearer sk-live-abcd1234" https://api.example.com',
            'psql postgres://user:hunter2@db.example.com/prod -c "select 1"',
            'echo ghp_AAAABBBBCCCCDDDD | gh auth login --with-token',
        ])('carries nothing but the program out of %s', (command) => {
            const target = targetOfCommand(command)!;
            expect(target).not.toMatch(/hunter2|sk-live|ghp_|Authorization/);
            expect(target).not.toContain(' ');
        });
    });

    it('counts thinking blocks without carrying them, and totals the context', () => {
        const events = projectPiEntries([
            entry('m1', {
                role: 'assistant',
                model: 'claude-opus-5',
                content: [
                    { type: 'thinking', thinking: 'a private deliberation', thinkingSignature: 'sig' },
                    { type: 'thinking', thinking: 'more of it', thinkingSignature: 'sig' },
                    { type: 'text', text: 'here is what I found' },
                ],
                usage: { input: 100, output: 20, cacheRead: 300, cacheWrite: 50, cost: 0.01, totalTokens: 470 },
            }),
        ]);

        expect(events).toEqual([
            {
                kind: 'msg',
                mid: 'm1',
                model: 'claude-opus-5',
                out: 20,
                ctx: 450,
                thinking: 2,
                at: '2026-09-14T00:00:00.000Z',
            },
            { kind: 'text', text: 'here is what I found', at: '2026-09-14T00:00:00.000Z' },
        ]);
        expect(JSON.stringify(events)).not.toContain('private deliberation');
    });

    it('skips pi bookkeeping that is not something the agent did', () => {
        const events = projectPiEntries([
            line({ type: 'session', version: 3, id: 's1', timestamp: '2026-09-14T00:00:00.000Z', cwd: '/tmp/p' }),
            line({ type: 'model_change', model: 'x' }),
            line({ type: 'thinking_level_change', thinkingLevel: 'low' }),
            line({ type: 'compaction', summary: 'a long markdown summary', firstKeptEntryId: 'm9' }),
            line({ type: 'custom', payload: {} }),
            line({ type: 'custom_message', payload: {} }),
            // An entry type from a version this projector has never seen.
            line({ type: 'something_pi_added_later', whatever: true }),
            userLine('the only real row'),
        ]);

        expect(events).toEqual([{ kind: 'prompt', text: 'the only real row', at: '2026-09-14T00:00:00.000Z' }]);
    });

    it('skips a malformed or truncated line instead of throwing', () => {
        const events = projectPiEntries([
            '{"type":"message","id":"m1","message":{"role":"user","conte',
            'not json at all',
            '',
            'null',
            '[]',
            line({ type: 'message', id: 'm2' }),
            line({ type: 'message', id: 'm3', message: { role: 'toolResult', content: [] } }),
            userLine('still standing'),
        ]);

        expect(events).toEqual([{ kind: 'prompt', text: 'still standing', at: '2026-09-14T00:00:00.000Z' }]);
    });

    it('clamps prose and labels to the budget every projector shares', () => {
        const [prompt] = projectPiEntries([userLine('x'.repeat(MAX_EVENT_TEXT_CHARS + 500))]);
        expect((prompt as { text: string }).text.length).toBe(MAX_EVENT_TEXT_CHARS);

        const [tool] = projectPiEntries([toolCallLine('a1', 'c1', 'read', { path: '/'.repeat(MAX_EVENT_FIELD_CHARS + 50) })]);
        expect((tool as { target: string }).target.length).toBe(MAX_EVENT_FIELD_CHARS);
    });

    it('backfills only the turn still in flight', () => {
        const lines = [
            userLine('finished turn', 'u1'),
            toolCallLine('a1', 'c1', 'read', { path: '/old.ts' }),
            userLine('current turn', 'u2'),
            toolCallLine('a2', 'c2', 'read', { path: '/new.ts' }),
        ];

        const events = projectPiEntries(lines, { sinceLastPrompt: true });

        expect(JSON.stringify(events)).not.toContain('/old.ts');
        expect(JSON.stringify(events)).toContain('/new.ts');
        expect(events[0]).toMatchObject({ kind: 'prompt', text: 'current turn' });
    });
});
