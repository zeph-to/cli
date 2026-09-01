/**
 * How every agent launches the Zeph MCP server — one source, four schemas.
 *
 * Registrations used to say `npx -y @zeph-to/mcp-server`, which left an
 * `npm exec` launcher resident beside the server for the life of the session.
 * `zeph mcp` (see mcp.ts) runs the server in the CLI's own process instead.
 *
 * Cursor, Windsurf, Gemini, OpenCode and the Claude Code plugin each want that
 * launch in a different shape, and the shapes drifted apart when each site
 * spelled the command out itself. Everything below is derived from
 * MCP_LAUNCH_ARGV.
 */

/** What the agents run. `zeph` resolves out of the same global bin dir as `npx`. */
export const MCP_LAUNCH_ARGV = ['zeph', 'mcp'] as const;

const [MCP_BIN, ...MCP_SUBCOMMAND] = MCP_LAUNCH_ARGV;

/**
 * `mcpServers.zeph` — Cursor, Windsurf, and plugin/.mcp.json.
 * The env block is deliberate: Cursor and Windsurf spawn the MCP server from a
 * graphical context that may not inherit shell env, so the key is passed
 * through explicitly rather than left to inheritance.
 */
export const MCP_SERVERS_ENTRY = {
    command: MCP_BIN,
    args: [...MCP_SUBCOMMAND],
    env: { ZEPH_API_KEY: '${ZEPH_API_KEY}' },
};

/**
 * opencode.json's own MCP schema — top-level `mcp` key (not `mcpServers`),
 * `command` as ARRAY (binary + args), `type: "local"`. No `environment` —
 * opencode is a terminal app that inherits shell env, and the MCP server
 * falls back to ~/.zeph/config.json anyway (an unexpanded "${ZEPH_API_KEY}"
 * literal would shadow that fallback with junk).
 */
export const OPENCODE_MCP_ENTRY = {
    type: 'local',
    command: [...MCP_LAUNCH_ARGV],
    enabled: true,
};

// gemini ≥0.26 syntax: `mcp add [-s scope] <name> <command> [args…]`. The
// server NAME and the BINARY are both "zeph" here, so the doubled word below
// is correct, not a copy-paste slip. Default scope is "project" (cwd-local
// .gemini/), so user scope is pinned for a machine-wide install.
export const GEMINI_MCP_ADD = `gemini mcp add -s user zeph ${MCP_BIN} -- ${MCP_SUBCOMMAND.join(' ')}`;

/** Older gemini CLIs only accept `mcp add <name> -- <command…>`, with no scope flag. */
export const GEMINI_MCP_ADD_LEGACY = `gemini mcp add zeph -- ${MCP_LAUNCH_ARGV.join(' ')}`;
