// ── Hook & Rule templates for each agent ─────────────────────────
//
// Every supported agent gets the SAME behavioral rules so Zeph behaves
// identically everywhere. The rule text is assembled from one shared
// generated core (src/zeph-core.generated.ts) plus a per-agent
// notification preamble:
//
//   - Hook-driven agents (Cursor, Windsurf, Gemini, Codex, Copilot, Pi,
//     OpenCode) have
//     a Stop-equivalent hook installed that auto-pushes on completion, so
//     they must NOT manually call zeph_notify for "done".
//   - Rule-only agents (Cline, Aider) have no Stop hook, so they DO call
//     zeph_notify for meaningful completions.
//
// The Ask-Loop / sticky-REMOTE / question-mandate rules are identical for
// all of them — that is the whole point of the shared generated core.
//
// One more axis, and it decides who can enter REMOTE at all: the core's
// Rules 1/2/8/9 are REMOTE-scoped, and REMOTE is entered by a prompt-submit
// hook note (a phone message) or by a `zeph_ask` answer. Only Gemini, Codex
// and Pi have that hook (remoteHookCmd below). Every other agent's only door is the
// ask itself — so for them the NORMAL branch must still send one after real
// work, or the phone loop can never begin. That is REMOTE_ENTRY_NO_HOOK.
//
// Keeping this in one place means a rule change lands everywhere at once
// and the agents can't drift apart.

import { NONREADONLY_COUNT_FLAG, PUSHMODE_DEFAULT_FLAG, TOOL_COUNT_FLAG } from './gate.js';
import { ZEPH_CORE_HOOK_DRIVEN, ZEPH_CORE_RULE_ONLY } from './zeph-core.generated.js';

// Graceful resolution: prefer the installed `zeph` CLI, but fall back to
// `npx -y @zeph-to/cli` so the hook still fires when the user
// installed via a non-standard prefix and the binary isn't on PATH at hook
// fire time (e.g. ~/.local/bin without PATH update). This mirrors the
// pattern in plugin/hooks/zeph-{stop,ask}.sh.
//
// `--auto` applies the shared push-gate before sending (see src/gate.ts):
// a caller that names no turn counts still pushes (gate defaults assume real
// work), and the /zeph-quiet | /zeph-loud dial works for every hook-driven
// agent. The two drop-in artifacts do name counts — see `turnFacts` below.
//
// `--pushmode-default normal` is what keeps the first half of that true. The
// built-in default for a project with no dial is quiet, and quiet only lets a
// `high` Push Signal marker through — a marker these hooks have no way to
// emit. Without the flag they would install and then never push again. The
// user's own dial still outranks it, so /zeph-quiet keeps working here.
//
// Older installed `zeph` versions parse both flags as unknown booleans and
// ignore them — graceful backward compatibility, and for `--pushmode-default`
// specifically the old build's behavior was already "normal when no dial".
//
// `turnFacts` carries the `--tools` / `--nonreadonly` counts, which only the
// two drop-in artifacts can supply — a JSON hook config sees no per-tool
// events, so it passes nothing and keeps riding GATE_DEFAULTS.
const notifyCmd = (turnFacts = ''): string =>
  '$(command -v zeph || echo "npx -y @zeph-to/cli") notify --title "Task done" --auto'
  + turnFacts
  + ` --${PUSHMODE_DEFAULT_FLAG} normal 2>/dev/null || true`;

// The same command as a JS template literal, so an artifact's runtime counters
// interpolate into it. JSON.stringify would emit a double-quoted string and
// ship the placeholders verbatim. Safe as long as the command holds no
// backtick and no `${` of its own — `$(command -v zeph …)` is shell, not JS.
const notifyCmdLiteral = (turnFacts: string): string => '`' + notifyCmd(turnFacts) + '`';

// The turn-fact fragment, as JS template-literal placeholders. Both artifacts
// name their counters `tools` / `nonReadonly`, so one fragment serves both —
// templates.test.ts pins those identifiers, since a rename on the artifact side
// would leave `${tools}` unresolved and kill the push with a ReferenceError.
const TURN_FACT_FLAGS =
  ` --${TOOL_COUNT_FLAG} \${tools} --${NONREADONLY_COUNT_FLAG} \${nonReadonly}`;

// Prompt-submit hook command — remote-origin detection (ADR-0002). Reads
// the hook JSON on stdin and prints additionalContext JSON on a marker
// match (see src/remote-hook.ts). stdout IS the hook response, so only
// stderr is discarded; `|| true` keeps a broken install from ever blocking
// a prompt.
const remoteHookCmd = (agent: 'gemini' | 'codex' | 'pi'): string =>
  `$(command -v zeph || echo "npx -y @zeph-to/cli") remote-hook ${agent} 2>/dev/null || true`;

// ── Shared behavioral core ───────────────────────────────────────
//
// GENERATED from plugin/docs/CORE_RULES.md — see src/zeph-core.generated.ts
// (regenerate with `npm run sync:plugin`). Do not fork per-agent — if a rule
// needs to differ, it belongs in the per-agent preamble instead, or in the
// audience classification in the plugin repo's core-rules.manifest.json.

// Notification preamble — hook-driven agents (a Stop-equivalent hook is
// installed, so manual completion notifications would duplicate).
const HOOK_DRIVEN_NOTIFY = `## Notification discipline

A Stop-equivalent hook is installed that auto-pushes a completion
notification on every response with meaningful work. Do NOT call
zeph_notify just to announce completion — it duplicates the auto-push.
Use zeph_notify only for mid-task errors/blockers (priority: "high"),
explicit progress milestones during long-running work, or multi-session
signals ("session A done, session B still building").`;

// Notification preamble — rule-only agents (no Stop hook; the AI is the
// only source of completion notifications).
const MANUAL_NOTIFY = `## Notification discipline

This agent has no Stop hook, so completion notifications must come from
you. After meaningful task completion (build, test, deploy, large
refactor, multi-file changes) call zeph_notify. Skip it for trivial
operations (file reads, simple searches). Set priority "high" for
errors/blockers.`;

// REMOTE-entry preamble — agents with NO prompt-submit hook (Cursor, Windsurf,
// Copilot, Cline, Aider, OpenCode). The shared core scopes Rules 1/2/8/9 to REMOTE
// and tells a NORMAL session it owes no `zeph_ask`. That is right where a
// hook can announce the phone message that starts REMOTE; here nothing can,
// and the only remaining entry is a `zeph_ask` answer that is not Done-like.
// So this preamble restores the one obligation the core dropped: after
// substantial work, end with `zeph_ask` — with `actions` — so the user has a
// button to tap that puts them in the driver's seat. Everything else the core
// says about NORMAL still holds (no ask on trivial turns, questions may go
// to the local picker, no `zeph_ask` just to mark a turn finished).
//
// This overrides the core's Rule 2 NORMAL clause for these agents. It is a
// per-agent preamble, not a fork of the core, for the reason the core's
// header gives: the rule text must stay one thing.
const REMOTE_ENTRY_NO_HOOK = `## Entering REMOTE without a prompt hook

This agent has no prompt-submit hook, so nothing can tell you when a
message arrived from the user's phone. The ONLY way this session enters
REMOTE is a \`zeph_ask\` answer that is not a Done-like button. So — and
this overrides the "In NORMAL, end with nothing" clause below —
**after substantial work in NORMAL, end the response with \`zeph_ask\`**:
2–4 \`actions\` carrying the next-step candidates plus a Done-like
\`fallback\`, \`timeout\` 300–600 s. "Substantial" = file changes, commits,
builds, tests, deploys, destructive ops, milestone completions. Skip it on
trivial turns (read-only exploration, a mid-step in an approved plan, a
typo-sized fix). Once the answer reports \`zephState: "REMOTE"\`, sticky REMOTE
mode takes over.`;

// Tool-access preamble — pi only.
const PI_TOOL_ACCESS = `## Zeph tools via the CLI (no MCP)

Pi has no MCP support, so the zeph_* tools these rules name are not in your
tool list. Wherever a rule says to call one, run the zeph CLI with your bash
tool instead — same semantics:

- zeph_ask    → \`zeph ask --title "…" --body "…" --actions "id:Label,id2:Label2" --timeout 300\`
  Blocks until answered; prints one JSON line. \`answered: false\` (timeout /
  unreachable) is a Done-like outcome — treat it as NORMAL.
- zeph_notify → \`zeph notify --title "…" --body "…" [--priority high]\`
- AskUserQuestion → pi's own terminal prompt.`;

/** Assemble a full rule document from optional frontmatter + preambles + core. */
const buildRule = (opts: { frontmatter?: string; notify: string; toolAccess?: string; remoteEntry?: string; core: string }): string => {
  const fm = opts.frontmatter ? `${opts.frontmatter}\n\n` : '';
  const tools = opts.toolAccess ? `${opts.toolAccess}\n\n` : '';
  const entry = opts.remoteEntry ? `${opts.remoteEntry}\n\n` : '';
  return `${fm}# Zeph — Remote-Control Rules

Zeph lets the user steer this session from their phone via zeph_ask
buttons. Use it judiciously — too many asks is noisy, too few strands
the user.

${opts.notify}

${tools}${entry}${opts.core}
`;
};

// ── Per-agent rule documents ─────────────────────────────────────
//
// The two generated cores are identical today; the split exists so a rule
// that only applies to one audience (e.g. Push Signal, once hook-driven
// agents' hooks process markers) is a one-line manifest change upstream.

/** Cursor — written to ~/.cursor/rules/zeph.mdc (needs .mdc frontmatter). No prompt hook. */
export const CURSOR_RULE = buildRule({
  frontmatter: '---\ndescription: "Zeph remote-control rules"\nalwaysApply: true\n---',
  notify: HOOK_DRIVEN_NOTIFY,
  remoteEntry: REMOTE_ENTRY_NO_HOOK,
  core: ZEPH_CORE_HOOK_DRIVEN,
});

/** Windsurf — appended into ~/.codeium/windsurf/memories/global_rules.md. No prompt hook. */
export const WINDSURF_RULE = buildRule({
  notify: HOOK_DRIVEN_NOTIFY,
  remoteEntry: REMOTE_ENTRY_NO_HOOK,
  core: ZEPH_CORE_HOOK_DRIVEN,
});

/** Gemini CLI — appended into ~/.gemini/GEMINI.md. Has the prompt hook (GEMINI_HOOKS). */
export const GEMINI_RULE = buildRule({ notify: HOOK_DRIVEN_NOTIFY, core: ZEPH_CORE_HOOK_DRIVEN });

/** Codex CLI — appended into ~/.codex/AGENTS.md. Has the prompt hook (CODEX_HOOKS). */
export const CODEX_RULE = buildRule({ notify: HOOK_DRIVEN_NOTIFY, core: ZEPH_CORE_HOOK_DRIVEN });

/** GitHub Copilot CLI — written to ~/.copilot/instructions/zeph.instructions.md. No prompt hook. */
export const COPILOT_RULE = buildRule({
  notify: HOOK_DRIVEN_NOTIFY,
  remoteEntry: REMOTE_ENTRY_NO_HOOK,
  core: ZEPH_CORE_HOOK_DRIVEN,
});

/** Cline — written to ~/.cline/rules/zeph.md (no Stop hook, no prompt hook). */
export const CLINE_RULE = buildRule({
  notify: MANUAL_NOTIFY,
  remoteEntry: REMOTE_ENTRY_NO_HOOK,
  core: ZEPH_CORE_RULE_ONLY,
});

/** Aider — standalone conventions file via .aider.conf.yml `read:` (no Stop hook, no prompt hook). */
export const AIDER_RULE = buildRule({
  notify: MANUAL_NOTIFY,
  remoteEntry: REMOTE_ENTRY_NO_HOOK,
  core: ZEPH_CORE_RULE_ONLY,
});

/** Pi — managed block in ~/.pi/agent/AGENTS.md. Extension = Stop-equivalent + prompt hook (PI_EXTENSION). */
export const PI_RULE = buildRule({
  notify: HOOK_DRIVEN_NOTIFY,
  toolAccess: PI_TOOL_ACCESS,
  core: ZEPH_CORE_HOOK_DRIVEN,
});

/** OpenCode — managed block in ~/.config/opencode/AGENTS.md. Stop hook via plugin, no prompt hook (v1). */
export const OPENCODE_RULE = buildRule({
  notify: HOOK_DRIVEN_NOTIFY,
  remoteEntry: REMOTE_ENTRY_NO_HOOK,
  core: ZEPH_CORE_HOOK_DRIVEN,
});

// ── Hook configs ─────────────────────────────────────────────────

export const CURSOR_HOOKS = JSON.stringify({
  version: 1,
  hooks: {
    stop: [{ command: notifyCmd() }],
  },
}, null, 2);

export const WINDSURF_HOOKS = JSON.stringify({
  hooks: {
    post_cascade_response: [{
      command: notifyCmd(),
      show_output: false,
    }],
  },
}, null, 2);

export const GEMINI_HOOKS = {
  hooks: {
    // Fires after the user submits a prompt, before planning — Gemini's
    // UserPromptSubmit equivalent (same additionalContext contract).
    BeforeAgent: [{
      matcher: '*',
      hooks: [{
        name: 'zeph-remote',
        type: 'command',
        command: remoteHookCmd('gemini'),
        timeout: 5000,
      }],
    }],
    AfterAgent: [{
      matcher: '*',
      hooks: [{
        name: 'zeph-notify',
        type: 'command',
        command: notifyCmd(),
      }],
    }],
  },
  hooksConfig: { enabled: true },
};

// Codex validates hooks.json strictly (serde deny_unknown_fields at the
// top level; handlers are a `type`-tagged enum inside matcher groups —
// codex-rs/config/src/hook_config.rs). The previous flat
// `{version, hooks: {Stop: [{type, bash}]}}` shape predates that schema
// and made codex reject the entire file, so the Stop hook is migrated to
// the schema-correct form here alongside the new UserPromptSubmit entry.
// An object (not a JSON string) so the installer can merge it into a
// user-owned hooks.json instead of overwriting. Timeouts are in seconds;
// codex's handler schema has no `name` field, so zeph ownership is
// recognizable only by the `@zeph-to/cli` command substring.
export const CODEX_HOOKS = {
  hooks: {
    UserPromptSubmit: [{
      hooks: [{ type: 'command', command: remoteHookCmd('codex'), timeout: 5 }],
    }],
    Stop: [{
      hooks: [{ type: 'command', command: notifyCmd() }],
    }],
  },
};

/**
 * True when a matcher group was written by zeph — by handler `name`
 * (`zeph-*`, Gemini) or by the `@zeph-to/cli` command substring (Codex,
 * whose handler schema has no name field; every zeph command carries the
 * substring via the `command -v zeph || npx -y @zeph-to/cli` fallback).
 * Shared by the installer (replace ours, keep the user's groups on
 * re-install) and the uninstaller (remove exactly ours).
 */
export const isZephHookGroup = (group: unknown): boolean => {
  const hooks = (group as { hooks?: unknown })?.hooks;
  if (!Array.isArray(hooks)) return false;
  return hooks.some((h) => {
    const { name, command } = (h ?? {}) as { name?: unknown; command?: unknown };
    return (
      (typeof name === 'string' && name.startsWith('zeph-')) ||
      (typeof command === 'string' && command.includes('@zeph-to/cli'))
    );
  });
};

export const COPILOT_HOOKS = JSON.stringify({
  version: 1,
  hooks: {
    sessionEnd: [{
      type: 'command',
      bash: notifyCmd(),
      timeoutSec: 10,
    }],
  },
}, null, 2);

// ── Drop-in artifact sources (pi extension, opencode plugin) ─────
//
// Not named *_HOOKS: those exports are JSON configs that templates.test.ts
// JSON.parses — these are TS source, auto-collected there as *_EXTENSION /
// *_PLUGIN for the same quiet-default guard, at the string level.

/** Pi extension source — written to ~/.pi/agent/extensions/zeph.ts (drop-in auto-load). */
export const PI_EXTENSION = `// Generated by @zeph-to/cli — reinstall overwrites; \`zeph uninstall\` removes.
import { spawn } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const sh = (cmd: string, cwd: string, stdin?: string): Promise<string> =>
  new Promise((resolve) => {
    const child = spawn("sh", ["-c", cmd], { cwd, stdio: ["pipe", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.on("error", () => resolve(""));
    child.on("close", () => resolve(out));
    child.stdin.end(stdin ?? "");
  });

// Read-only tools, mirroring what the Claude Code Stop hook excludes
// (Read/Grep/Glob). Names read from the installed package's dist/core/tools on
// 2026-08-28: bash, edit, find, grep, ls, powershell, read, write — \`find\` is
// pi's Glob. Anything absent here, MCP tools included, counts as real work, so
// an unknown tool errs toward pushing rather than toward silence.
const READ_ONLY = new Set(["read", "grep", "find", "ls"]);

export default function (pi: ExtensionAPI) {
  // Turn facts for the push gate. One agent per process, so plain counters
  // suffice — no session keying.
  let tools = 0;
  let nonReadonly = 0;

  pi.on("tool_execution_end", (event) => {
    tools += 1;
    if (!READ_ONLY.has(event.toolName)) nonReadonly += 1;
  });
  // Stop-equivalent: agent_settled fires once per user turn, after retries/compaction.
  // Fire-and-forget: never block pi's turn-end on the notify network call.
  pi.on("agent_settled", (_event, ctx) => {
    const child = spawn("sh", ["-c", ${notifyCmdLiteral(TURN_FACT_FLAGS)}], { cwd: ctx.cwd, stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  });
  // Prompt-submit: remote-origin detection (ADR-0002) — additionalContext comes
  // back as a persistent injected message (this extension is the consumer).
  // Doubles as the turn boundary: this is where the counters start over.
  pi.on("before_agent_start", async (event, ctx) => {
    tools = 0;
    nonReadonly = 0;
    const out = await sh(${JSON.stringify(remoteHookCmd('pi'))}, ctx.cwd,
      JSON.stringify({ prompt: event.prompt, cwd: ctx.cwd }));
    try {
      const context = JSON.parse(out)?.hookSpecificOutput?.additionalContext;
      if (typeof context === "string" && context) {
        return { message: { customType: "zeph-remote", content: context, display: false } };
      }
    } catch { /* silent no-op — the hook only ever adds context */ }
  });
}
`;

/** OpenCode plugin source — written to ~/.config/opencode/plugins/zeph.ts (drop-in auto-load). */
export const OPENCODE_PLUGIN = `// Generated by @zeph-to/cli — reinstall overwrites; \`zeph uninstall\` removes.
import { spawn } from "node:child_process";
import type { Plugin } from "@opencode-ai/plugin";

// Read-only tools, mirroring what the Claude Code Stop hook excludes
// (Read/Grep/Glob). Names read from the installed opencode binary's tool
// registry on 2026-08-28: read, list, glob, grep, webfetch, websearch, task,
// shell, bash, edit, write, patch, skill, lsp, todowrite. Anything absent
// here, MCP tools included, counts as real work — an unknown tool errs toward
// pushing rather than toward silence.
const READ_ONLY = new Set(["read", "grep", "glob", "list"]);

type TurnFacts = { tools: number; nonReadonly: number };
const zeroFacts = (): TurnFacts => ({ tools: 0, nonReadonly: 0 });

// Typed against the real plugin contract, the way the pi extension is: the
// hook names and payload shapes this file asserts by hand are then checked by
// the compiler, so an upstream rename fails loudly instead of silently
// handing every handler an \`any\`.
export const ZephPlugin: Plugin = async ({ client, directory }) => {
  // Turn facts, keyed by session. The plugin instance is per-project, not
  // per-session, and the \`task\` tool runs subagents in their own child
  // sessions with their own full lifecycle — one shared counter would bill
  // their tool calls to whatever else the project had running.
  const facts = new Map<string, TurnFacts>();

  // A child session's id is all \`session.idle\` carries; the parent link lives
  // on the session record. This is the one blocking call in the idle handler —
  // the notify spawn below stays fire-and-forget, but the push decision cannot
  // be made without knowing whether this session is somebody's subagent. The
  // generated client defaults to \`throwOnError: false\`, so a non-2xx arrives as
  // a result with no \`data\` rather than as a throw; both paths land on
  // undefined, which pushes — the same direction every other unknown in this
  // file leans.
  const parentOf = async (id: string): Promise<string | undefined> => {
    try {
      return (await client.session.get({ path: { id } })).data?.parentID;
    } catch {
      return undefined;
    }
  };

  return {
    // Turn start. Create-if-absent, never reset: this fires per *message*, and
    // a second message queued while the agent is still working would otherwise
    // zero the counts already earned. session.idle deletes the entry, so the
    // next turn always starts from zero anyway.
    "chat.message": async ({ sessionID }) => {
      if (!facts.has(sessionID)) facts.set(sessionID, zeroFacts());
    },
    "tool.execute.after": async ({ tool, sessionID }) => {
      const entry = facts.get(sessionID) ?? zeroFacts();
      entry.tools += 1;
      if (!READ_ONLY.has(tool)) entry.nonReadonly += 1;
      facts.set(sessionID, entry);
    },
    // Stop-equivalent. Unlike the named hooks above, session.idle arrives only
    // through the generic \`event\` hook — there is no per-event key for it, so
    // filter by type.
    event: async ({ event }) => {
      // A deleted session never idles again, so nothing would ever consume its
      // entry. Drop it here or it outlives the turn for the life of the
      // process. An *aborted* turn needs no such handling: the entry survives
      // to the session's next chat.message, which adds to it rather than
      // resetting, so the interrupted work is reported with the retry.
      if (event.type === "session.deleted") {
        facts.delete(event.properties.info.id);
        return;
      }
      if (event.type !== "session.idle") return;
      const { sessionID } = event.properties;
      // No entry means no user message was seen for this session, so there is
      // no turn to report — the zeroes gate the push out, which is correct.
      const settled = facts.get(sessionID) ?? zeroFacts();
      facts.delete(sessionID);

      // A \`task\` subagent settles first, in its own session. Pushing there
      // would announce "Task done" for a slice of a turn still in flight, and
      // leave the parent crediting the whole delegation as the single
      // \`task\` call it saw — one tool, below the gate, so the real
      // completion would go silent. Roll the counts up and stay quiet.
      const parentID = await parentOf(sessionID);
      const parent = parentID === undefined ? undefined : facts.get(parentID);
      if (parent) {
        parent.tools += settled.tools;
        parent.nonReadonly += settled.nonReadonly;
        return;
      }
      // Falling through means no live parent entry to roll into — either this
      // is a top-level session, or a \`background\` task outlived the turn that
      // spawned it and the parent settled and pushed already, or the lookup
      // above failed. The three are indistinguishable from here, and all three
      // want the same thing: report this session's own work rather than write
      // it into an entry nobody will ever read. Never conjure that entry — that
      // would leak one per background task.

      const { tools, nonReadonly } = settled;
      // Fire-and-forget: never block opencode's event pipeline on the notify call.
      const child = spawn("sh", ["-c", ${notifyCmdLiteral(TURN_FACT_FLAGS)}], { cwd: directory, stdio: "ignore", detached: true });
      child.on("error", () => {});
      child.unref();
    },
  };
};
`;

// ── Marker-section helpers for shared global rule files ──────────
//
// Windsurf / Gemini / Codex all use a single shared global rule file
// that the user may already own. We never overwrite it — we manage just
// our own block, delimited by these markers, so install/uninstall is
// idempotent and the user's content is preserved.

export const ZEPH_MARK_START = '<!-- ZEPH:START — managed by @zeph-to/cli, do not edit between markers -->';
export const ZEPH_MARK_END = '<!-- ZEPH:END -->';

// Match the start marker by stable prefix, not its full text. Installs from
// older releases wrote `… managed by @zeph-to/hook-sdk …`; matching the prefix
// keeps upsert/uninstall working across the rename instead of orphaning their
// managed blocks.
const ZEPH_MARK_START_PREFIX = '<!-- ZEPH:START';

/**
 * Return `existing` with the Zeph-managed block inserted or replaced.
 * If the markers are already present, the content between them is
 * swapped; otherwise the block is appended.
 */
export const upsertManagedBlock = (existing: string, rule: string): string => {
  const block = `${ZEPH_MARK_START}\n${rule}\n${ZEPH_MARK_END}`;
  const startIdx = existing.indexOf(ZEPH_MARK_START_PREFIX);
  const endIdx = existing.indexOf(ZEPH_MARK_END);
  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    const before = existing.slice(0, startIdx).replace(/\n*$/, '');
    const after = existing.slice(endIdx + ZEPH_MARK_END.length).replace(/^\n*/, '');
    return [before, block, after].filter(Boolean).join('\n\n') + '\n';
  }
  const base = existing.replace(/\n*$/, '');
  return (base ? `${base}\n\n` : '') + block + '\n';
};

/** Strip the Zeph-managed block from a shared file (for uninstall). */
export const removeManagedBlock = (existing: string): string => {
  const startIdx = existing.indexOf(ZEPH_MARK_START_PREFIX);
  const endIdx = existing.indexOf(ZEPH_MARK_END);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) return existing;
  const before = existing.slice(0, startIdx).replace(/\n*$/, '');
  const after = existing.slice(endIdx + ZEPH_MARK_END.length).replace(/^\n*/, '');
  return [before, after].filter(Boolean).join('\n\n') + (before || after ? '\n' : '');
};
