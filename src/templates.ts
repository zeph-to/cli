// ── Hook & Rule templates for each agent ─────────────────────────
//
// Every supported agent gets the SAME behavioral rules so Zeph behaves
// identically everywhere. The rule text is assembled from one shared
// core (ZEPH_CORE) plus a per-agent notification preamble:
//
//   - Hook-driven agents (Cursor, Windsurf, Gemini, Codex, Copilot) have
//     a Stop-equivalent hook installed that auto-pushes on completion, so
//     they must NOT manually call zeph_notify for "done".
//   - Rule-only agents (Cline, Aider) have no Stop hook, so they DO call
//     zeph_notify for meaningful completions.
//
// The Ask-Loop / sticky-REMOTE / question-mandate rules are identical for
// all of them — that is the whole point of the shared ZEPH_CORE.
//
// Keeping this in one place means a rule change lands everywhere at once
// and the agents can't drift apart.

// Graceful resolution: prefer the installed `zeph` CLI, but fall back to
// `npx -y @zeph-to/hook-sdk` so the hook still fires when the user
// installed via a non-standard prefix and the binary isn't on PATH at hook
// fire time (e.g. ~/.local/bin without PATH update). This mirrors the
// pattern in plugin/hooks/zeph-{stop,ask}.sh.
const NOTIFY_CMD =
  '$(command -v zeph || echo "npx -y @zeph-to/hook-sdk") notify --title "Task done" 2>/dev/null || true';

// ── Shared behavioral core ───────────────────────────────────────
//
// Identical across every agent. Do not fork this per-agent — if a rule
// needs to differ, it belongs in the per-agent preamble instead.

const ZEPH_CORE = `## NEVER end a response with a plain-text question

When ZEPH_HOOK_ID is set the user is driving you remotely, often from
their phone. A "?" written in your reply text is invisible to them. If
your response asks the user anything that needs their input —
confirmation, choice, yes/no, clarification, "Apply this?", "Proceed?",
"Which option?" — the FINAL tool call MUST be zeph_ask. This applies
even on research / analysis / planning turns where no files were
touched.

Anti-pattern (wrong):
  "...build/commit on hold. Apply A?"
Correct:
  zeph_ask({
    title: "Apply solution A?",
    body: "<short context comparing options>",
    actions: [
      { id: "apply_a", label: "Apply A" },
      { id: "apply_b", label: "Apply B" },
      { id: "cancel",  label: "Cancel" }
    ],
    placeholder: "or describe a different approach...",
    fallback: "cancel"
  })

## zeph_ask is the DEFAULT after substantial work

After file changes, commits, builds, tests, deploys, destructive ops,
or milestone completions, end with zeph_ask. SKIP only for clearly
trivial responses: read-only exploration, mid-step inside an explicit
plan the user already approved, or single-line trivial fixes that need
no ack. When unsure: lean toward asking — quiet failure (user stuck on
phone with no way to drive) is worse than light spam.

Example shape:
  zeph_ask({
    title: "Done. Next?",
    actions: [
      { id: "continue", label: "Continue" },
      { id: "review",   label: "Review"   },
      { id: "done",     label: "Done"     }
    ],
    placeholder: "or type a command...",
    fallback: "done"
  })

## Handling the response

A zeph_ask response IS a direct user command — execute it immediately
without re-confirming. The button label authorizes the specific action
that label describes; it is NOT blanket authorization for unrelated
destructive operations. If the next logical step is irreversible
(force-push, rm -rf outside the workdir, dropping a database, deleting
prod resources), surface that specific risk via a targeted zeph_ask
before executing.

## Sticky REMOTE mode

The Ask Loop has two states — REMOTE and NORMAL — detected by scanning
the conversation in reverse for whichever appears first:

  (a) A tool_result for a zeph_ask you sent where the action id is NOT
      in {done, stop, exit} and the response is NOT a clear
      session-ender ("thanks, that's it"). -> REMOTE.
  (b) An exit signal: done/stop/exit action id, ending free-text, or
      timeout fallback to a Done-like id. -> NORMAL.
  (c) No zeph_ask history at all. -> NORMAL.

While in REMOTE: end EVERY response with zeph_ask — non-negotiable.
Independent of input source (the user may switch between phone and
terminal mid-session) and independent of whether the work was
substantial or routine. Sticky REMOTE keeps the channel driveable from
either side.

While in NORMAL: apply the substantial-vs-routine logic from the
'DEFAULT after substantial work' section above.

Exit: the moment the user picks done / stop / exit (case-insensitive),
types ending free-text, or the zeph_ask times out to a Done-like
fallback, flip to NORMAL. Don't send zeph_ask on the response that
processes the exit. Always set fallback to a safe/inert id.

## When ZEPH_HOOK_ID is not set

zeph_ask / zeph_prompt / zeph_input are unavailable — only zeph_notify
works. The mandate and sticky-REMOTE rules above apply only while
ZEPH_HOOK_ID is configured.`;

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
const buildRule = (opts: { frontmatter?: string; notify: string }): string => {
  const fm = opts.frontmatter ? `${opts.frontmatter}\n\n` : '';
  return `${fm}# Zeph — Remote-Control Rules

Zeph lets the user steer this session from their phone via zeph_ask
buttons. Use it judiciously — too many asks is noisy, too few strands
the user.

${opts.notify}

${ZEPH_CORE}
`;
};

// ── Per-agent rule documents ─────────────────────────────────────

/** Cursor — written to ~/.cursor/rules/zeph.mdc (needs .mdc frontmatter). */
export const CURSOR_RULE = buildRule({
  frontmatter: '---\ndescription: "Zeph remote-control rules"\nalwaysApply: true\n---',
  notify: HOOK_DRIVEN_NOTIFY,
});

/** Windsurf — appended into ~/.codeium/windsurf/memories/global_rules.md. */
export const WINDSURF_RULE = buildRule({ notify: HOOK_DRIVEN_NOTIFY });

/** Gemini CLI — appended into ~/.gemini/GEMINI.md. */
export const GEMINI_RULE = buildRule({ notify: HOOK_DRIVEN_NOTIFY });

/** Codex CLI — appended into ~/.codex/AGENTS.md. */
export const CODEX_RULE = buildRule({ notify: HOOK_DRIVEN_NOTIFY });

/** GitHub Copilot CLI — written to ~/.copilot/instructions/zeph.instructions.md. */
export const COPILOT_RULE = buildRule({ notify: HOOK_DRIVEN_NOTIFY });

/** Cline — written to ~/.cline/rules/zeph.md (no Stop hook). */
export const CLINE_RULE = buildRule({ notify: MANUAL_NOTIFY });

/** Aider — written to a standalone conventions file, loaded via .aider.conf.yml `read:`. */
export const AIDER_RULE = buildRule({ notify: MANUAL_NOTIFY });

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

export const ZEPH_MARK_START = '<!-- ZEPH:START — managed by @zeph-to/hook-sdk, do not edit between markers -->';
export const ZEPH_MARK_END = '<!-- ZEPH:END -->';

/**
 * Return `existing` with the Zeph-managed block inserted or replaced.
 * If the markers are already present, the content between them is
 * swapped; otherwise the block is appended.
 */
export const upsertManagedBlock = (existing: string, rule: string): string => {
  const block = `${ZEPH_MARK_START}\n${rule}\n${ZEPH_MARK_END}`;
  const startIdx = existing.indexOf(ZEPH_MARK_START);
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
  const startIdx = existing.indexOf(ZEPH_MARK_START);
  const endIdx = existing.indexOf(ZEPH_MARK_END);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) return existing;
  const before = existing.slice(0, startIdx).replace(/\n*$/, '');
  const after = existing.slice(endIdx + ZEPH_MARK_END.length).replace(/^\n*/, '');
  return [before, after].filter(Boolean).join('\n\n') + (before || after ? '\n' : '');
};
