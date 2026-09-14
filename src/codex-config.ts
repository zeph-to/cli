/**
 * The zeph entry inside `~/.codex/config.toml`, which Codex CLI owns.
 *
 * Codex is the one supported agent whose MCP registry is TOML, and the file is
 * the user's: it carries their model, their approval settings, their other
 * servers. So this module works at the text level on the one table zeph owns
 * (`[mcp_servers.zeph]`) and never rewrites the document — a parse-and-emit
 * round trip through a TOML library would reorder their keys and drop their
 * comments, which is a worse failure than the entry being missing.
 *
 * Install, uninstall and verify all go through here so the table's shape is
 * stated once.
 */
import { MCP_LAUNCH_ARGV } from './mcp-command.js';

const [MCP_BIN, ...MCP_SUBCOMMAND] = MCP_LAUNCH_ARGV;

/** Matches the table header, with or without the quotes TOML also allows. */
const ZEPH_TABLE_HEADER = /^\[mcp_servers\.(?:zeph|"zeph")\]\s*$/;
const ANY_TABLE_HEADER = /^\s*\[/;

/**
 * The table zeph writes. No `env` block, unlike the Cursor/Windsurf JSON entry:
 * codex is a terminal app, so the server inherits the shell's `ZEPH_API_KEY`,
 * and an unexpanded `"${ZEPH_API_KEY}"` literal would shadow the
 * ~/.zeph/config.json fallback with junk (the same reasoning as opencode's).
 */
export const CODEX_MCP_TABLE = [
    '[mcp_servers.zeph]',
    `command = "${MCP_BIN}"`,
    `args = [${MCP_SUBCOMMAND.map((a) => `"${a}"`).join(', ')}]`,
].join('\n');

/** Line index of the zeph header, or -1. */
const headerIndex = (lines: readonly string[]): number =>
    lines.findIndex((line) => ZEPH_TABLE_HEADER.test(line.trim()));

/** Index one past the zeph table's last line — the next table header, or EOF. */
const tableEnd = (lines: readonly string[], start: number): number => {
    const next = lines.slice(start + 1).findIndex((line) => ANY_TABLE_HEADER.test(line));
    return next === -1 ? lines.length : start + 1 + next;
};

/**
 * The config with zeph's table present and current, leaving every other byte
 * alone. Appended at the end when absent: a table header ends the table before
 * it, so nothing above can capture the keys.
 */
export const upsertZephMcpTable = (config: string): string => {
    const lines = config.split('\n');
    const start = headerIndex(lines);
    if (start === -1) {
        const body = config.trimEnd();
        return `${body ? `${body}\n\n` : ''}${CODEX_MCP_TABLE}\n`;
    }
    const rest = lines.slice(tableEnd(lines, start));
    // Both branches end the file with exactly one newline, so writing a config
    // that already carries the table is a no-op rather than a one-byte diff.
    return `${[...lines.slice(0, start), ...CODEX_MCP_TABLE.split('\n'), ...rest].join('\n').trimEnd()}\n`;
};

/** The config with zeph's table gone, or null when it was never there (so the
 *  caller can report "nothing to remove" rather than rewriting an untouched
 *  file). */
export const removeZephMcpTable = (config: string): string | null => {
    const lines = config.split('\n');
    const start = headerIndex(lines);
    if (start === -1) return null;
    const kept = [...lines.slice(0, start), ...lines.slice(tableEnd(lines, start))];
    // The removed table left its trailing blank line behind; collapse the run
    // so repeated install/uninstall cycles cannot grow the file.
    return `${kept.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
};

/**
 * The launch argv codex has recorded for zeph, verbatim, or null when the
 * table is absent. Same contract as `registeredMcpArgv` in verify.ts: returned
 * unnormalized, because a stale entry is only visible if the reader does not
 * reshape it into what it expects.
 */
export const readZephMcpArgv = (config: string): string[] | null => {
    const lines = config.split('\n');
    const start = headerIndex(lines);
    if (start === -1) return null;
    const body = lines.slice(start + 1, tableEnd(lines, start));
    const value = (key: string): string | undefined =>
        body.find((line) => line.trimStart().startsWith(`${key} `) || line.trimStart().startsWith(`${key}=`))
            ?.split('=').slice(1).join('=').trim();

    const command = value('command')?.replace(/^["']|["']$/g, '');
    if (!command) return null;
    const args = (value('args') ?? '')
        .replace(/^\[|\]$/g, '')
        .split(',')
        .map((a) => a.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean);
    return [command, ...args];
};
