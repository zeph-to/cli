import { describe, expect, it } from 'vitest';
import {
    GEMINI_MCP_ADD, GEMINI_MCP_ADD_LEGACY, MCP_LAUNCH_ARGV, MCP_SERVERS_ENTRY, OPENCODE_MCP_ENTRY,
} from './mcp-command.js';

// Four registries describe the same launch in four schemas. Pinning the
// literal values in each one is what let them drift apart before; these
// tests pin the SOURCE once and assert every shape is derived from it.

const asArgv = [...MCP_LAUNCH_ARGV];

/** Shell-split a `gemini mcp add …` line and drop the `--` separator. */
const argvAfterServerName = (command: string): string[] =>
    command.split(' ').slice(command.split(' ').indexOf('zeph', 3) + 1).filter((t) => t !== '--');

describe('MCP_LAUNCH_ARGV', () => {
    it('launches the CLI subcommand, not an npx launcher', () => {
        expect(asArgv).toEqual(['zeph', 'mcp']);
    });

    // GEMINI_MCP_ADD interpolates these tokens into a shell string handed to
    // execSync. Anything needing quotes would silently mis-split there.
    it('has no token that would need shell quoting', () => {
        for (const token of asArgv) expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    });
});

describe('derived registration shapes', () => {
    it('mcpServers entry (Cursor/Windsurf/plugin) reconstructs the launch argv', () => {
        expect([MCP_SERVERS_ENTRY.command, ...MCP_SERVERS_ENTRY.args]).toEqual(asArgv);
    });

    // Dropping env would break the IDEs that spawn the MCP server from a
    // graphical context with no shell env to inherit.
    it('mcpServers entry keeps the ZEPH_API_KEY placeholder', () => {
        expect(MCP_SERVERS_ENTRY.env).toEqual({ ZEPH_API_KEY: '${ZEPH_API_KEY}' });
    });

    it('opencode entry carries the launch argv in its array-command schema', () => {
        expect(OPENCODE_MCP_ENTRY).toEqual({ type: 'local', command: asArgv, enabled: true });
    });

    it('both gemini forms reconstruct the launch argv after the server name', () => {
        expect(argvAfterServerName(GEMINI_MCP_ADD)).toEqual(asArgv);
        expect(argvAfterServerName(GEMINI_MCP_ADD_LEGACY)).toEqual(asArgv);
    });

    it('pins user scope on the modern gemini form, project scope being its default', () => {
        expect(GEMINI_MCP_ADD).toContain('-s user');
        expect(GEMINI_MCP_ADD_LEGACY).not.toContain('-s user');
    });
});

// The whole point of the change: no shape may reach for the npm launcher.
describe('no npx launcher survives in any shape', () => {
    it('no derived registration mentions npx or the mcp-server package', () => {
        const everything = JSON.stringify([
            MCP_SERVERS_ENTRY, OPENCODE_MCP_ENTRY, GEMINI_MCP_ADD, GEMINI_MCP_ADD_LEGACY,
        ]);
        expect(everything).not.toContain('npx');
        expect(everything).not.toContain('@zeph-to/mcp-server');
    });
});
