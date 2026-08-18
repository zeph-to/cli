// ── Hook & Rule templates for each agent ─────────────────────────
//
// Every supported agent gets the SAME behavioral rules so Zeph behaves
// identically everywhere. The rule text is assembled from one shared
// generated core (src/zeph-core.generated.ts) plus a per-agent
// notification preamble:
//
//   - Hook-driven agents (Cursor, Windsurf, Gemini, Codex, Copilot) have
//     a Stop-equivalent hook installed that auto-pushes on completion, so
//     they must NOT manually call zeph_notify for "done".
//   - Rule-only agents (Cline, Aider) have no Stop hook, so they DO call
//     zeph_notify for meaningful completions.
//
// The Ask-Loop / sticky-REMOTE / question-mandate rules are identical for
// all of them — that is the whole point of the shared generated core.
//
// One more axis, and it decides who can enter REMOTE at all: the core's
// Rules 3/4/10/11 are REMOTE-scoped, and REMOTE is entered by a prompt-submit
// hook note (a phone message) or by a `zeph_ask` answer. Only Gemini and Codex
// have that hook (remoteHookCmd below). Every other agent's only door is the
// ask itself — so for them the NORMAL branch must still send one after real
// work, or the phone loop can never begin. That is REMOTE_ENTRY_NO_HOOK.
//
// Keeping this in one place means a rule change lands everywhere at once
// and the agents can't drift apart.

import { PUSHMODE_DEFAULT_FLAG } from './gate.js';
import { ZEPH_CORE_HOOK_DRIVEN, ZEPH_CORE_RULE_ONLY } from './zeph-core.generated.js';

// Graceful resolution: prefer the installed `zeph` CLI, but fall back to
// `npx -y @zeph-to/cli` so the hook still fires when the user
// installed via a non-standard prefix and the binary isn't on PATH at hook
// fire time (e.g. ~/.local/bin without PATH update). This mirrors the
// pattern in plugin/hooks/zeph-{stop,ask}.sh.
//
// `--auto` applies the shared push-gate before sending (see src/gate.ts):
// the push still fires (gate defaults assume real work), and the
// /zeph-quiet | /zeph-loud dial works for every hook-driven agent.
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
const NOTIFY_CMD =
  '$(command -v zeph || echo "npx -y @zeph-to/cli") notify --title "Task done" --auto '
  + `--${PUSHMODE_DEFAULT_FLAG} normal 2>/dev/null || true`;

// Prompt-submit hook command — remote-origin detection (ADR-0002). Reads
// the hook JSON on stdin and prints additionalContext JSON on a marker
// match (see src/remote-hook.ts). stdout IS the hook response, so only
// stderr is discarded; `|| true` keeps a broken install from ever blocking
// a prompt.
const remoteHookCmd = (agent: 'gemini' | 'codex'): string =>
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
// Copilot, Cline, Aider). The shared core scopes Rules 3/4/10/11 to REMOTE
// and tells a NORMAL session it owes no `zeph_ask`. That is right where a
// hook can announce the phone message that starts REMOTE; here nothing can,
// and the only remaining entry is a `zeph_ask` answer that is not Done-like.
// So this preamble restores the one obligation the core dropped: after
// substantial work, end with `zeph_ask` — with `actions` — so the user has a
// button to tap that puts them in the driver's seat. Everything else the core
// says about NORMAL still holds (no ask on trivial turns, questions may go
// to the local picker, no `zeph_ask` just to mark a turn finished).
//
// This overrides the core's Rule 4 NORMAL clause for these agents. It is a
// per-agent preamble, not a fork of the core, for the reason the core's
// header gives: the rule text must stay one thing.
const REMOTE_ENTRY_NO_HOOK = `## Entering REMOTE without a prompt hook

This agent has no prompt-submit hook, so nothing can tell you when a
message arrived from the user's phone. The ONLY way this session enters
REMOTE is a \`zeph_ask\` answer that is not a Done-like button. So — and
this overrides the "In NORMAL, end with nothing" clause of Rule 4 below —
**after substantial work in NORMAL, end the response with \`zeph_ask\`**:
2–4 \`actions\` carrying the next-step candidates plus a Done-like
\`fallback\`, \`timeout\` 300–600 s. "Substantial" = file changes, commits,
builds, tests, deploys, destructive ops, milestone completions. Skip it on
trivial turns (read-only exploration, a mid-step in an approved plan, a
typo-sized fix). Once the answer reports \`zephState: "REMOTE"\`, Rule 9
takes over.`;

/** Assemble a full rule document from optional frontmatter + preambles + core. */
const buildRule = (opts: { frontmatter?: string; notify: string; remoteEntry?: string; core: string }): string => {
  const fm = opts.frontmatter ? `${opts.frontmatter}\n\n` : '';
  const entry = opts.remoteEntry ? `${opts.remoteEntry}\n\n` : '';
  return `${fm}# Zeph — Remote-Control Rules

Zeph lets the user steer this session from their phone via zeph_ask
buttons. Use it judiciously — too many asks is noisy, too few strands
the user.

${opts.notify}

${entry}${opts.core}
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

// ── Hook configs ─────────────────────────────────────────────────

export const CURSOR_HOOKS = JSON.stringify({
  version: 1,
  hooks: {
    stop: [{ command: NOTIFY_CMD }],
  },
}, null, 2);

export const WINDSURF_HOOKS = JSON.stringify({
  hooks: {
    post_cascade_response: [{
      command: NOTIFY_CMD,
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
        command: NOTIFY_CMD,
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
      hooks: [{ type: 'command', command: NOTIFY_CMD }],
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
      bash: NOTIFY_CMD,
      timeoutSec: 10,
    }],
  },
}, null, 2);

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
