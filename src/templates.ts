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
// Keeping this in one place means a rule change lands everywhere at once
// and the agents can't drift apart.

import { ZEPH_CORE_HOOK_DRIVEN, ZEPH_CORE_RULE_ONLY } from './zeph-core.generated.js';

// Graceful resolution: prefer the installed `zeph` CLI, but fall back to
// `npx -y @zeph-to/cli` so the hook still fires when the user
// installed via a non-standard prefix and the binary isn't on PATH at hook
// fire time (e.g. ~/.local/bin without PATH update). This mirrors the
// pattern in plugin/hooks/zeph-{stop,ask}.sh.
//
// `--auto` applies the shared push-gate before sending (see src/gate.ts):
// in normal mode the push still fires (gate defaults assume real work), but
// the /zeph-quiet | /zeph-loud dial now works for every hook-driven agent.
// Older installed `zeph` versions parse `--auto` as an unknown boolean flag
// and ignore it — graceful backward compatibility.
const NOTIFY_CMD =
  '$(command -v zeph || echo "npx -y @zeph-to/cli") notify --title "Task done" --auto 2>/dev/null || true';

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

/** Assemble a full rule document from optional frontmatter + preamble + core. */
const buildRule = (opts: { frontmatter?: string; notify: string; core: string }): string => {
  const fm = opts.frontmatter ? `${opts.frontmatter}\n\n` : '';
  return `${fm}# Zeph — Remote-Control Rules

Zeph lets the user steer this session from their phone via zeph_ask
buttons. Use it judiciously — too many asks is noisy, too few strands
the user.

${opts.notify}

${opts.core}
`;
};

// ── Per-agent rule documents ─────────────────────────────────────
//
// The two generated cores are identical today; the split exists so a rule
// that only applies to one audience (e.g. Push Signal, once hook-driven
// agents' hooks process markers) is a one-line manifest change upstream.

/** Cursor — written to ~/.cursor/rules/zeph.mdc (needs .mdc frontmatter). */
export const CURSOR_RULE = buildRule({
  frontmatter: '---\ndescription: "Zeph remote-control rules"\nalwaysApply: true\n---',
  notify: HOOK_DRIVEN_NOTIFY,
  core: ZEPH_CORE_HOOK_DRIVEN,
});

/** Windsurf — appended into ~/.codeium/windsurf/memories/global_rules.md. */
export const WINDSURF_RULE = buildRule({ notify: HOOK_DRIVEN_NOTIFY, core: ZEPH_CORE_HOOK_DRIVEN });

/** Gemini CLI — appended into ~/.gemini/GEMINI.md. */
export const GEMINI_RULE = buildRule({ notify: HOOK_DRIVEN_NOTIFY, core: ZEPH_CORE_HOOK_DRIVEN });

/** Codex CLI — appended into ~/.codex/AGENTS.md. */
export const CODEX_RULE = buildRule({ notify: HOOK_DRIVEN_NOTIFY, core: ZEPH_CORE_HOOK_DRIVEN });

/** GitHub Copilot CLI — written to ~/.copilot/instructions/zeph.instructions.md. */
export const COPILOT_RULE = buildRule({ notify: HOOK_DRIVEN_NOTIFY, core: ZEPH_CORE_HOOK_DRIVEN });

/** Cline — written to ~/.cline/rules/zeph.md (no Stop hook). */
export const CLINE_RULE = buildRule({ notify: MANUAL_NOTIFY, core: ZEPH_CORE_RULE_ONLY });

/** Aider — written to a standalone conventions file, loaded via .aider.conf.yml `read:`. */
export const AIDER_RULE = buildRule({ notify: MANUAL_NOTIFY, core: ZEPH_CORE_RULE_ONLY });

// ── Hook configs (notification side, unchanged) ──────────────────

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

export const CODEX_HOOKS = JSON.stringify({
  version: 1,
  hooks: {
    Stop: [{
      type: 'command',
      bash: NOTIFY_CMD,
    }],
  },
}, null, 2);

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
