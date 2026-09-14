import { describe, expect, it } from 'vitest';
import { CODEX_MCP_TABLE, readZephMcpArgv, removeZephMcpTable, upsertZephMcpTable } from './codex-config.js';

const USER_CONFIG = `model = "gpt-5.6-luna"
model_reasoning_effort = "low"

[mcp_servers.graft]
command = "graft"
args = ["mcp"]

[projects."/Users/me/work"]
trust_level = "trusted"
`;

describe('upsertZephMcpTable', () => {
    it('appends the table to a config that has none', () => {
        const out = upsertZephMcpTable(USER_CONFIG);
        expect(out).toContain(CODEX_MCP_TABLE);
        expect(out).toContain('model = "gpt-5.6-luna"');
        expect(out).toContain('[mcp_servers.graft]');
    });

    it('writes a table into an empty config without a leading blank line', () => {
        expect(upsertZephMcpTable('')).toBe(`${CODEX_MCP_TABLE}\n`);
    });

    it('replaces a stale entry in place, keeping what follows', () => {
        const stale = `${USER_CONFIG}
[mcp_servers.zeph]
command = "npx"
args = ["-y", "@zeph-to/mcp-server"]

[history]
persistence = "none"
`;
        const out = upsertZephMcpTable(stale);
        expect(out).not.toContain('npx');
        expect(out).toContain('command = "zeph"');
        expect(out).toContain('[history]\npersistence = "none"');
    });

    it('is idempotent', () => {
        const once = upsertZephMcpTable(USER_CONFIG);
        expect(upsertZephMcpTable(once)).toBe(once);
    });
});

describe('removeZephMcpTable', () => {
    it('takes out only zeph, leaving the user\'s own servers', () => {
        const out = removeZephMcpTable(upsertZephMcpTable(USER_CONFIG));
        expect(out).not.toBeNull();
        expect(out).not.toContain('mcp_servers.zeph');
        expect(out).toContain('[mcp_servers.graft]');
        expect(out).toContain('model = "gpt-5.6-luna"');
    });

    it('reports nothing to do when the table is absent', () => {
        expect(removeZephMcpTable(USER_CONFIG)).toBeNull();
    });

    it('does not grow the file across install/uninstall cycles', () => {
        const cycled = removeZephMcpTable(upsertZephMcpTable(
            removeZephMcpTable(upsertZephMcpTable(USER_CONFIG)) as string,
        ));
        expect(cycled).toBe(removeZephMcpTable(upsertZephMcpTable(USER_CONFIG)));
    });
});

describe('readZephMcpArgv', () => {
    it('reads back what the installer wrote', () => {
        expect(readZephMcpArgv(upsertZephMcpTable(USER_CONFIG))).toEqual(['zeph', 'mcp']);
    });

    it('returns a stale registration verbatim, so verify can call it stale', () => {
        const stale = `[mcp_servers.zeph]\ncommand = "npx"\nargs = ["-y", "@zeph-to/mcp-server"]\n`;
        expect(readZephMcpArgv(stale)).toEqual(['npx', '-y', '@zeph-to/mcp-server']);
    });

    it('is null when codex has no zeph entry', () => {
        expect(readZephMcpArgv(USER_CONFIG)).toBeNull();
    });

    it('reads an entry codex wrote with a quoted table name', () => {
        expect(readZephMcpArgv('[mcp_servers."zeph"]\ncommand = "zeph"\nargs = ["mcp"]\n')).toEqual(['zeph', 'mcp']);
    });
});
