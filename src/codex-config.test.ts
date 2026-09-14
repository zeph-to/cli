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

describe('the user\'s own bytes survive', () => {
    // Codex writes this itself when the user picks "always allow" for a tool;
    // measured on a live ~/.codex/config.toml.
    const WITH_SUBTABLE = `model = "gpt-5.6-luna"

[mcp_servers.zeph]
command = "zeph"
args = ["mcp"]

[mcp_servers.zeph.tools.zeph_ask]
approval_mode = "approve"

[projects."/Users/me/work"]
trust_level = "trusted"
`;

    it('removes zeph together with its sub-tables, orphaning nothing', () => {
        const out = removeZephMcpTable(WITH_SUBTABLE) as string;
        expect(out).not.toContain('mcp_servers.zeph');
        expect(out).not.toContain('approval_mode');
        expect(out).toContain('[projects."/Users/me/work"]');
    });

    it('keeps the approval sub-table across a re-install', () => {
        const out = upsertZephMcpTable(WITH_SUBTABLE);
        expect(out).toContain('[mcp_servers.zeph.tools.zeph_ask]');
        expect(out).toContain('approval_mode = "approve"');
    });

    it('keeps keys of theirs inside our table, and rewrites only ours', () => {
        const withExtras = `[mcp_servers.zeph]
command = "npx"
args = ["-y", "@zeph-to/mcp-server"]
startup_timeout_sec = 30
`;
        const out = upsertZephMcpTable(withExtras);
        expect(out).toContain('startup_timeout_sec = 30');
        expect(out).toContain('command = "zeph"');
        expect(out).not.toContain('npx');
    });

    it('leaves a comment that documents the NEXT table where it was', () => {
        const commented = `[mcp_servers.zeph]
command = "zeph"
args = ["mcp"]

# my own server, do not remove
[mcp_servers.graft]
command = "graft"
`;
        expect(removeZephMcpTable(commented)).toContain('# my own server, do not remove');
        expect(upsertZephMcpTable(commented)).toContain('# my own server, do not remove');
    });

    it('replaces the dotted form instead of writing a duplicate key', () => {
        const dotted = 'model = "gpt-5.6-luna"\nmcp_servers.zeph = { command = "npx", args = ["mcp"] }\n';
        const out = upsertZephMcpTable(dotted);
        expect(out).toContain('[mcp_servers.zeph]');
        expect(out).not.toContain('mcp_servers.zeph = {');
        expect(out.match(/mcp_servers\.(?:zeph|"zeph")/g)).toHaveLength(1);
        expect(removeZephMcpTable(dotted)).not.toContain('mcp_servers.zeph');
    });

    it('keeps CRLF endings CRLF', () => {
        const crlf = 'model = "gpt-5.6-luna"\r\n';
        const out = upsertZephMcpTable(crlf);
        expect(out).not.toMatch(/[^\r]\n/);
    });
});

describe('readZephMcpArgv — shapes codex and humans actually write', () => {
    it('reads args split across lines', () => {
        const multiline = '[mcp_servers.zeph]\ncommand = "zeph"\nargs = [\n  "mcp",\n]\n';
        expect(readZephMcpArgv(multiline)).toEqual(['zeph', 'mcp']);
    });

    it('reads the dotted form', () => {
        expect(readZephMcpArgv('mcp_servers.zeph = { command = "npx", args = ["mcp"] }\n'))
            .toEqual(['npx', 'mcp']);
    });

    it('is not fooled by a sub-table sitting below ours', () => {
        const withSub = '[mcp_servers.zeph]\ncommand = "zeph"\nargs = ["mcp"]\n\n[mcp_servers.zeph.tools.zeph_ask]\napproval_mode = "approve"\n';
        expect(readZephMcpArgv(withSub)).toEqual(['zeph', 'mcp']);
    });
});
