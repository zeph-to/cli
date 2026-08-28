/**
 * Hook-driven agents and the quiet default.
 *
 * Every agent below installs the same completion command (`notifyCmd()` in
 * templates.ts). Those hooks supply no turn counts and no Push Signal marker,
 * so under the quiet default the gate could never let them push — Zeph would install cleanly and
 * then do nothing, forever, with no error anywhere. `--pushmode-default normal`
 * keeps them on the normal heuristic until the user sets a dial of their own.
 *
 * The flag name comes from gate.ts so the writer here and the reader in cli.ts
 * cannot drift; a typo in either would be exactly the silent regression this
 * file exists to prevent.
 */
import { transformSync } from 'esbuild';
import { describe, expect, it } from 'vitest';
import { NONREADONLY_COUNT_FLAG, PUSHMODE_DEFAULT_FLAG, TOOL_COUNT_FLAG } from './gate.js';
import { REMOTE_HOOK_AGENTS } from './remote-hook.js';
import * as templates from './templates.js';

// Derived from the module, not hand-listed: a sixth agent added to
// templates.ts joins this table by itself. A hand-written table would only
// ever constrain itself, which is no guard at all.
const HOOK_CONFIGS = Object.entries(templates).filter(([name]) => name.endsWith('_HOOKS'));

/** Every string leaf in a hook config, whether it ships as JSON text or object. */
const stringsOf = (value: unknown): string[] => {
    if (typeof value === 'string') return [value];
    if (Array.isArray(value)) return value.flatMap(stringsOf);
    if (value && typeof value === 'object') return Object.values(value).flatMap(stringsOf);
    return [];
};

const commandsOf = (config: unknown): string[] =>
    stringsOf(typeof config === 'string' ? JSON.parse(config) : config);

describe('templates.ts: completion hooks survive the quiet default', () => {
    it('every agent that installs hooks is covered here', () => {
        // Five today (Cursor, Windsurf, Gemini, Codex, Copilot) — every agent
        // whose completion hook ships as a `*_HOOKS` config. Pi and OpenCode are
        // hook-driven too but ship theirs as a dropped-in source file
        // (PI_EXTENSION / OPENCODE_PLUGIN), which this table deliberately does
        // not collect. The assertion is a floor, not a pin — a new agent must
        // not shrink the table.
        expect(HOOK_CONFIGS.length).toBeGreaterThanOrEqual(5);
    });

    for (const [name, config] of HOOK_CONFIGS) {
        it(`${name} names a push-mode default on every gated notify`, () => {
            // Per-command, not per-config: a config that grew a second notify
            // command with the flag on only one of them would still be broken.
            const notifyCommands = commandsOf(config).filter((c) => c.includes('--auto'));
            expect(notifyCommands.length).toBeGreaterThan(0);
            for (const command of notifyCommands) {
                expect(command).toContain(`--${PUSHMODE_DEFAULT_FLAG} normal`);
                // Turn counts belong to the drop-in artifacts alone. A JSON
                // config sees no per-tool events, so `notifyCmd(TURN_FACT_FLAGS)`
                // here would ship the literal text `${tools}` to the shell.
                expect(command).not.toContain(`--${TOOL_COUNT_FLAG} `);
                expect(command).not.toContain(`--${NONREADONLY_COUNT_FLAG} `);
            }
        });
    }
});

// Drop-in TS source artifacts (pi extension, opencode plugin) embed the same
// completion command, plus the turn counts only they can supply, and are not
// JSON — same quiet-default guard, at the string level. Derived from the
// module like HOOK_CONFIGS: a new drop-in joins by itself.
const ARTIFACT_SOURCES = Object.entries(templates)
    .filter(([name]) => /_(EXTENSION|PLUGIN)$/.test(name)) as [string, string][];

describe('templates.ts: drop-in artifacts survive the quiet default', () => {
    it('every drop-in artifact is covered here', () => {
        // Two today (pi extension, opencode plugin) — a floor, not a pin.
        expect(ARTIFACT_SOURCES.length).toBeGreaterThanOrEqual(2);
    });

    for (const [name, source] of ARTIFACT_SOURCES) {
        it(`${name} embeds the gated notify with a push-mode default`, () => {
            expect(source).toContain('command -v zeph');
            expect(source).toContain(`--${PUSHMODE_DEFAULT_FLAG} normal`);
        });

        it(`${name} types its handlers against the host agent's own package`, () => {
            // Untyped handler params are implicitly `any`, which is how the
            // hook names and payload shapes asserted throughout these
            // artifacts stop being checked by anything at all. The type-only
            // import is erased at load time, so it costs the artifact nothing.
            expect(source).toMatch(/^import type \{[^}]+\} from "[^"]+";$/m);
        });
    }
});

// Turn facts — the two drop-in artifacts are the only installed hooks that can
// count their own turn's tool calls, so they are the only ones that pass
// `--tools` / `--nonreadonly`. Getting this wrong is silent: without the flags
// the gate falls back to GATE_DEFAULTS ("assume real work") and the artifact
// pushes on every turn, including read-only ones. Verified 2026-08-28 against
// the installed packages (neither is a dependency of this repo, so pin the
// versions the claim was read from): pi 0.84.3's ToolExecutionEndEvent carries
// `toolName` (@earendil-works/pi-coding-agent dist/core/extensions/types.d.ts),
// and @opencode-ai/plugin 1.18.23's "tool.execute.after" carries `input.tool`
// (dist/index.d.ts).
describe('templates.ts: drop-in artifacts report turn facts', () => {
    // Per-agent event names — the one thing here that cannot be derived, since
    // each agent names its own turn boundary. A new artifact with no row fails
    // the first assertion rather than silently skipping the other two.
    const TURN_EVENTS: Record<string, { start: string; tool: string }> = {
        PI_EXTENSION: { start: 'before_agent_start', tool: 'tool_execution_end' },
        OPENCODE_PLUGIN: { start: 'chat.message', tool: 'tool.execute.after' },
    };

    for (const [name, source] of ARTIFACT_SOURCES) {
        it(`${name} names its turn-start and per-tool events`, () => {
            const events = TURN_EVENTS[name];
            expect(events).toBeDefined();
            expect(source).toContain(events.start);
            expect(source).toContain(events.tool);
        });

        it(`${name} interpolates live counts into the notify command`, () => {
            // A backtick literal, not JSON.stringify: a double-quoted embed
            // would ship the placeholder text where the numbers belong.
            expect(source).toMatch(
                /`[^`]*--tools \$\{tools\} --nonreadonly \$\{nonReadonly\}[^`]*`/,
            );
        });

        it(`${name} declares the counters the command interpolates`, () => {
            // The regex above only proves the *text* `${tools}` shipped. Rename
            // a counter in the artifact and that placeholder becomes an
            // unresolved identifier: a ReferenceError inside the event handler,
            // no spawn, no push, and every string assertion still green.
            expect(source).toMatch(/\b(let|const) tools\b|\btools,\s*nonReadonly\b/);
            expect(source).toMatch(/\b(let|const) nonReadonly\b|\btools,\s*nonReadonly\b/);
        });

        it(`${name} counts read-only tools apart from real work`, () => {
            // Mirrors the Claude Code Stop hook's Read/Grep/Glob set; the
            // per-agent spellings differ, `read`/`grep` are the overlap.
            expect(source).toContain('READ_ONLY');
            expect(source).toMatch(/READ_ONLY[^;]*"read"[^;]*"grep"/s);
        });
    }
});

// The assertions above read the artifact as text. Text cannot tell "counts a
// session" from "counts the *right* session", and getting that wrong is
// silent: opencode runs every `task` subagent in its own child session with
// its own full chat.message/tool.execute.after/session.idle lifecycle, so a
// naive plugin both pushes from the child mid-turn and leaves the parent
// crediting the whole delegation as the one `task` call it saw — one tool,
// below the gate, real completion silent. So run it: compile the emitted
// source and drive it against a fake host.
describe('templates.ts: the OpenCode plugin bills tool calls to the right session', () => {
    const PARENT = 'ses_parent';
    const CHILD = 'ses_child';

    /** Compile the emitted artifact and instantiate it with the host stubbed out. */
    const loadPlugin = async (parents: Record<string, string | undefined>, unreachable = false) => {
        const js = transformSync(templates.OPENCODE_PLUGIN, { loader: 'ts', format: 'cjs' }).code;
        const commands: string[] = [];
        const mod = { exports: {} as Record<string, unknown> };
        // `node:child_process` is the artifact's only value import — the type
        // import is erased, so nothing else needs a stub.
        new Function('exports', 'module', 'require', js)(mod.exports, mod, () => ({
            spawn: (_sh: string, argv: string[]) => {
                commands.push(argv[1]);
                return { on: () => {}, unref: () => {} };
            },
        }));

        const client = {
            session: {
                get: async ({ path }: { path: { id: string } }) => {
                    if (unreachable) throw new Error('econnrefused');
                    return { data: { id: path.id, parentID: parents[path.id] } };
                },
            },
        };
        type Hooks = Record<string, (input: never) => Promise<void>>;
        const plugin = mod.exports.ZephPlugin as (input: unknown) => Promise<Hooks>;
        const hooks = await plugin({ client, directory: '/repo' });

        return {
            commands,
            message: (sessionID: string) => hooks['chat.message']({ sessionID } as never),
            tool: (sessionID: string, tool: string) =>
                hooks['tool.execute.after']({ tool, sessionID } as never),
            idle: (sessionID: string) =>
                hooks.event({ event: { type: 'session.idle', properties: { sessionID } } } as never),
            deleted: (sessionID: string) =>
                hooks.event({
                    event: { type: 'session.deleted', properties: { info: { id: sessionID } } },
                } as never),
        };
    };

    it('rolls a subagent session up into its parent instead of pushing twice', async () => {
        const p = await loadPlugin({ [CHILD]: PARENT });
        await p.message(PARENT);
        // The child settles first — before the parent's own `task` call lands.
        await p.message(CHILD);
        await p.tool(CHILD, 'read');
        await p.tool(CHILD, 'write');
        await p.idle(CHILD);
        expect(p.commands).toEqual([]);

        await p.tool(PARENT, 'task');
        await p.idle(PARENT);
        expect(p.commands).toHaveLength(1);
        // 2 from the child plus the `task` call itself; the child's write is
        // the only non-read-only work the turn actually did.
        expect(p.commands[0]).toContain(`--${TOOL_COUNT_FLAG} 3`);
        expect(p.commands[0]).toContain(`--${NONREADONLY_COUNT_FLAG} 2`);
    });

    it('reports a background subagent that outlives its parent turn', async () => {
        // `task` can run with background=true, so the child settles after the
        // parent already pushed and dropped its entry. Rolling into a
        // recreated entry would leak it forever and lose the child's work.
        const p = await loadPlugin({ [CHILD]: PARENT });
        await p.message(PARENT);
        await p.tool(PARENT, 'task');
        await p.tool(PARENT, 'write');
        await p.idle(PARENT);
        expect(p.commands).toHaveLength(1);

        await p.message(CHILD);
        await p.tool(CHILD, 'write');
        await p.tool(CHILD, 'read');
        await p.idle(CHILD);
        expect(p.commands).toHaveLength(2);
        expect(p.commands[1]).toContain(`--${TOOL_COUNT_FLAG} 2`);
        expect(p.commands[1]).toContain(`--${NONREADONLY_COUNT_FLAG} 1`);
    });

    it('drops the entry for a deleted session', async () => {
        // A deleted session never idles again, so its entry would otherwise sit
        // in the map for the life of the process. Idling afterwards is not
        // something opencode does — it is how the test observes that the entry
        // is gone: a surviving entry would report the two calls below.
        const p = await loadPlugin({});
        await p.message(PARENT);
        await p.tool(PARENT, 'write');
        await p.tool(PARENT, 'edit');
        await p.deleted(PARENT);
        await p.idle(PARENT);
        expect(p.commands).toHaveLength(1);
        expect(p.commands[0]).toContain(`--${TOOL_COUNT_FLAG} 0`);
        expect(p.commands[0]).toContain(`--${NONREADONLY_COUNT_FLAG} 0`);
    });

    it('keeps concurrent sibling sessions apart', async () => {
        const other = 'ses_other';
        const p = await loadPlugin({});
        await p.message(PARENT);
        await p.message(other);
        await p.tool(other, 'write');
        await p.tool(other, 'write');
        await p.tool(PARENT, 'read');
        await p.idle(PARENT);

        expect(p.commands).toHaveLength(1);
        expect(p.commands[0]).toContain(`--${TOOL_COUNT_FLAG} 1`);
        expect(p.commands[0]).toContain(`--${NONREADONLY_COUNT_FLAG} 0`);
    });

    it('still pushes when the parent lookup fails', async () => {
        // Fail-open: an unreachable server must not turn every turn silent.
        const p = await loadPlugin({}, true);
        await p.message(PARENT);
        await p.tool(PARENT, 'write');
        await p.tool(PARENT, 'read');
        await p.idle(PARENT);

        expect(p.commands).toHaveLength(1);
        expect(p.commands[0]).toContain(`--${TOOL_COUNT_FLAG} 2`);
    });
});

// "No-hook REMOTE entry preamble ⟺ agent lacks a prompt hook" spans two files
// (rules here, registry in remote-hook.ts) — this is the only thing tying them.
// An agent that gains a prompt hook but keeps the preamble would end every
// NORMAL turn with zeph_ask, duplicating what its hook already does.
describe('templates.ts: rules agree with the remote-hook registry', () => {
    const RULES = Object.entries(templates).filter(([name]) => name.endsWith('_RULE')) as [string, string][];
    const NO_HOOK_MARKER = 'Entering REMOTE without a prompt hook';

    it('collects every rule', () => {
        expect(RULES.length).toBeGreaterThanOrEqual(9);
    });

    for (const [name, rule] of RULES) {
        const id = name.replace(/_RULE$/, '').toLowerCase();
        const hasPromptHook = (REMOTE_HOOK_AGENTS as readonly string[]).includes(id);
        it(`${name} ${hasPromptHook ? 'omits' : 'carries'} the no-hook REMOTE entry preamble`, () => {
            if (hasPromptHook) expect(rule).not.toContain(NO_HOOK_MARKER);
            else expect(rule).toContain(NO_HOOK_MARKER);
        });
    }
});
