// ── Hook & Rule templates for each agent ─────────────────────────
//
// Two policies depending on whether the agent has a working Stop-equivalent
// hook installed via this SDK:
//
//   1) Hook-driven agents (Cursor, Windsurf, Gemini, Codex, Copilot, and
//      Claude Code via the separate plugin) — the hook fires on every
//      response and runs `zeph notify`. The AI should NOT manually call
//      zeph_notify just to announce completion, because that duplicates the
//      auto-push. Rules here mirror the Claude Code plugin's policy.
//
//   2) Rule-only agents (Cline, Aider) — no Stop hook is wired up, so the
//      AI must manually call zeph_notify for meaningful completions. The
//      Ask-Loop pattern still applies when ZEPH_HOOK_ID is configured.

// Graceful resolution: prefer the installed `zeph` CLI, but fall back to
// `npx -y @zeph-to/hook-sdk` so the hook still fires when the user
// installed via a non-standard prefix and the binary isn't on PATH at hook
// fire time (e.g. ~/.local/bin without PATH update). This mirrors the
// pattern in plugin/hooks/zeph-{stop,ask}.sh.
const NOTIFY_CMD =
  '$(command -v zeph || echo "npx -y @zeph-to/hook-sdk") notify --title "Task done" 2>/dev/null || true';

// ── Cursor ───────────────────────────────────────────────────────

export const CURSOR_HOOKS = JSON.stringify({
  version: 1,
  hooks: {
    stop: [{
      command: NOTIFY_CMD,
    }],
  },
}, null, 2);

export const CURSOR_RULE = `---
description: "Zeph remote-control rules"
alwaysApply: true
---

# Zeph — Remote-Control Rules

A Stop hook (~/.cursor/hooks.json) auto-pushes a completion notification
on every response that did meaningful work. You do not need to call
zeph_notify to announce that you finished — it duplicates the auto-push.

## When to use zeph_notify

Only for:
- Mid-task errors or blockers (set priority: "high")
- Explicit progress milestones during long-running work
- Multi-session signals ("session A done, session B still building")

## When ZEPH_HOOK_ID is set (remote two-way control)

After responses that involved file changes, builds, deploys, or destructive
ops, end with a zeph_ask offering next actions. Two reasons: (a) the user
may be on their phone and uses the buttons to drive what you do next, and
(b) when you send zeph_ask the Stop hook stays silent, so there is no
duplicate push.

Example final action:
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

A zeph_ask response IS a direct user command — execute it immediately
without re-confirming. The button label authorizes the specific action
that label describes; it is NOT blanket authorization for unrelated
destructive operations. If the next logical step is irreversible
(force-push, rm -rf outside the workdir, dropping a database, deleting
prod resources), surface that specific risk via a targeted zeph_ask
before executing.

End the Ask Loop when the user picks an action id matching
done / stop / exit (case-insensitive) or types free-text that clearly
ends the session. Treat the timeout fallback the same as the user picking
the fallback id — so always set fallback to a safe/inert id.

## When ZEPH_HOOK_ID is not set

zeph_ask / zeph_prompt / zeph_input are unavailable. Use zeph_notify only
as described above.

Do not notify for trivial operations (file reads, simple searches).
`;

// ── Windsurf ─────────────────────────────────────────────────────

export const WINDSURF_HOOKS = JSON.stringify({
  hooks: {
    post_cascade_response: [{
      command: NOTIFY_CMD,
      show_output: false,
    }],
  },
}, null, 2);

// ── Gemini ───────────────────────────────────────────────────────

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

// ── Codex ────────────────────────────────────────────────────────

export const CODEX_HOOKS = JSON.stringify({
  version: 1,
  hooks: {
    Stop: [{
      type: 'command',
      bash: NOTIFY_CMD,
    }],
  },
}, null, 2);

// ── Copilot ──────────────────────────────────────────────────────

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

// ── Cline ────────────────────────────────────────────────────────

export const CLINE_RULE = `# Zeph — Notification & Remote-Control Rules

Cline does not have a Stop hook wired up, so notifications must come from
you via MCP tools.

## When to call zeph_notify

After meaningful task completion (build, test, deploy, large refactor, or
multi-file changes). Skip for trivial operations (file reads, simple
searches, short clarifications).

Set priority "high" for errors or blockers that interrupt your progress.

## When ZEPH_HOOK_ID is set (remote two-way control)

Prefer zeph_ask over zeph_notify after responses that involved file
changes, builds, deploys, or destructive ops. The user may be on their
phone and uses the buttons to drive what you do next.

Example final action:
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

A zeph_ask response IS a direct user command — execute it immediately
without re-confirming. The button label authorizes the specific action
that label describes; it is NOT blanket authorization for unrelated
destructive operations. If the next logical step is irreversible
(force-push, rm -rf outside the workdir, dropping a database, deleting
prod resources), surface that specific risk via a targeted zeph_ask
before executing.

End the Ask Loop when the user picks an action id matching
done / stop / exit (case-insensitive). Treat the timeout fallback the
same as the user picking the fallback id — so always set fallback to a
safe/inert id.
`;
