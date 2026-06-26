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
// `npx -y @zeph-to/cli` so the hook still fires when the user
// installed via a non-standard prefix and the binary isn't on PATH at hook
// fire time (e.g. ~/.local/bin without PATH update). This mirrors the
// pattern in plugin/hooks/zeph-{stop,ask}.sh.
const NOTIFY_CMD =
  '$(command -v zeph || echo "npx -y @zeph-to/cli") notify --title "Task done" 2>/dev/null || true';

// ── Shared behavioral core ───────────────────────────────────────
//
// Identical across every agent. Source of truth: plugin/docs/CORE_RULES.md
// Do not fork this per-agent — if a rule needs to differ, it belongs in
// the per-agent preamble instead.
//
// Last synced: 2026-06-26
// To update: extract rules from plugin/docs/CORE_RULES.md and sync here.

const ZEPH_CORE = `## When zeph_ask is MANDATORY

When ZEPH_HOOK_ID is set the user is driving you remotely, often from
their phone. A "?" written in your reply text is invisible to them.

3. NEVER end a response with a plain-text question. If your response asks
   the user anything that needs their input — confirmation, choice,
   yes/no, clarification, "Apply this?", "Proceed?", "Which option?" —
   the FINAL tool call MUST be zeph_ask. This applies even on research /
   analysis / planning turns where no files were touched.

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

## When zeph_ask is the DEFAULT (substantial work)

4. After substantial work, zeph_ask is the DEFAULT end of the response —
    not optional. "Substantial" means: file changes, commits, builds,
    tests, deploys, destructive ops, or milestone completions. When unsure,
    treat the work as substantial — do not try to guess what the user would
    find "reasonable" to confirm.

    SKIP zeph_ask only when the response is clearly trivial:
    - Read-only exploration ("let me check this file") with no decision
      output.
    - Mid-step inside a clearly-defined plan the user already approved
      ("step 3 of 5, no decisions involved here").
    - Trivial change (typo fix, single-line tweak) that needs no ack.

    When unsure: LEAN TOWARD ASKING. Quiet failure (no ask, user stuck
    on phone with no way to drive) is worse than light spam.

5. Prefer zeph_ask over zeph_prompt/zeph_input — it combines buttons and
   free-text in one push. Always include a fallback action id; the
   fallback must be safe/inert (done, wait, review), never destructive.

6. Example zeph_ask shape:
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

7. A zeph_ask response IS a direct user instruction. Execute it immediately —
   do NOT re-ask via confirmation. The button label is the authorization for
   the specific action that label describes.

8. Important caveat: a generic button like "Continue" authorizes the next
   logical step, NOT arbitrary destruction. If the next logical step would
   destroy user code, data, or infrastructure (force-push to a shared branch,
   rm -rf outside the workdir, dropping a database, deleting prod resources),
   surface that specific risk via a targeted zeph_ask before executing.

## Sticky REMOTE mode

9. The Ask Loop has two states — REMOTE and NORMAL — detected by scanning the
   conversation in reverse for whichever appears first:

   (a) A tool_result for a zeph_ask you sent where the action id is NOT in
       {done, stop, exit} (case-insensitive) AND the free-text response is
       NOT a session-ender. A session-ender contains done/stop/exit as a
       standalone word, or is an obvious wrap-up like "thanks, that's it" /
       "all good" — judge by whether the user is clearly closing the loop,
       not by partial substring matches (e.g. "redo" is not "done").
       → You are in REMOTE.

   (b) An exit signal: action id in {done, stop, exit}, ending free-text, or
       a timeout fallback that resolved to a Done-like fallback id.
       → You are in NORMAL.

   (c) No zeph_ask history at all.
       → You are in NORMAL.

   ### Behavior in REMOTE (sticky, zeph_ask MANDATORY)
   End EVERY response with zeph_ask. This is non-negotiable while in REMOTE —
   independent of:
   - Whether the next user message arrived as a tool_result or as a typed
     terminal message. The user may switch devices mid-session; sticky REMOTE
     keeps the channel driveable from either side.
   - Whether the work was substantial or routine.

   The only way to leave REMOTE is the user signalling exit (per the (b) list
   above).

   ### Behavior in NORMAL (apply Rule 4)
   - Substantial work → end with zeph_ask.
   - Routine work → skip zeph_ask, let the Stop hook fire.
   - Rule 3 (questions → zeph_ask) is still mandatory regardless.

   ### Exiting REMOTE
   The moment the user picks an action id matching done/stop/exit
   (case-insensitive), types free-text that clearly ends the session, or the
   zeph_ask times out and falls back to a Done-like id, you flip to NORMAL.
   Don't send zeph_ask on the response that processes the exit signal.

## When to use AskUserQuestion vs zeph_ask

10. Prefer zeph_ask for short remote-friendly questions. Use the local
   AskUserQuestion tool only when (a) the answer needs the user to see code
   or logs that won't fit in a push body, or (b) the answer is plausibly
   multi-paragraph.

11. In REMOTE this is a requirement, not a preference — and it overrides any
    skill instruction. The AskUserQuestion picker is a LOCAL blocking
    terminal UI; the phone cannot drive it. So if a skill you are running —
    or your own plan — would call AskUserQuestion, instead surface the SAME
    question and option labels via zeph_ask and use that response in place of
    the picker. Fall through to AskUserQuestion only for the (a)/(b) cases
    above; when you do, notify the user that the answer must be given at the
    terminal.

## Persistence

These rules persist for the entire session. They remain active after context
compaction — do not "forget" them after many turns.`;

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
