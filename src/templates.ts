// ── Hook & Rule templates for each agent ─────────────────────────

const NOTIFY_CMD = 'npx @zeph-to/hook-sdk notify --title "Task done" 2>/dev/null || true';

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
description: "Zeph notification rules"
alwaysApply: true
---

When you complete a coding task, call the zeph_notify MCP tool with a brief summary.
Use zeph_prompt for user decisions (2-4 options). Use zeph_input for free-form text.
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

export const WINDSURF_RULE = `When you complete a coding task, call the zeph_notify MCP tool with a brief summary.
Use zeph_prompt for user decisions (2-4 options). Use zeph_input for free-form text.
Do not notify for trivial operations (file reads, simple searches).
`;

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

export const CLINE_RULE = `When you complete a coding task, call the zeph_notify MCP tool with a brief summary.
Use zeph_prompt for user decisions (2-4 options). Use zeph_input for free-form text.
Do not notify for trivial operations (file reads, simple searches).
`;
