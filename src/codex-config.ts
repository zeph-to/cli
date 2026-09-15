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
 * What that promise costs, stated once here because every function below is
 * shaped by it:
 *
 *  - **Sub-tables are part of the entry.** Codex writes per-tool settings as
 *    `[mcp_servers.zeph.tools.zeph_ask]` when the user picks "always allow".
 *    Removal takes them along (a child of a deleted server is dead config);
 *    re-install keeps them, since they are the user's answer, not ours.
 *  - **Only `command` and `args` are ours.** Any other key in the table —
 *    `cwd`, `startup_timeout_sec`, a comment — survives a re-install.
 *  - **Comments before the next table belong to that table**, not to ours, so
 *    the region we replace or delete stops short of them.
 *
 * Install, uninstall and verify all go through here so this is stated once.
 */
import { MCP_LAUNCH_ARGV } from './mcp-command.js';

const [MCP_BIN, ...MCP_SUBCOMMAND] = MCP_LAUNCH_ARGV;

/** The table header, with or without the quotes TOML also allows. */
const ZEPH_TABLE_HEADER = /^\[mcp_servers\.(?:zeph|"zeph")\]$/;
/** A sub-table of ours: `[mcp_servers.zeph.tools.zeph_ask]` and friends. */
const ZEPH_SUBTABLE_HEADER = /^\[mcp_servers\.(?:zeph|"zeph")\..+\]$/;
/**
 * The dotted/inline form — `mcp_servers.zeph = { command = "npx", … }` — which
 * is valid TOML and which older hand-written configs use. It has to be found,
 * because appending a header table beside it is a duplicate-key error that
 * makes codex reject the WHOLE config, zeph's entry and the user's alike.
 */
const ZEPH_INLINE_ENTRY = /^mcp_servers\.(?:zeph|"zeph")\s*=/;
const ANY_TABLE_HEADER = /^\[/;

const isZephDefinition = (line: string): boolean =>
    ZEPH_TABLE_HEADER.test(line.trim()) || ZEPH_INLINE_ENTRY.test(line.trim());

/** The keys zeph owns; everything else in the table is the user's. */
const OWNED_KEY = /^(?:command|args)\s*=/;

const commandLine = `command = "${MCP_BIN}"`;
const argsLine = `args = [${MCP_SUBCOMMAND.map((a) => `"${a}"`).join(', ')}]`;

/** The table zeph writes into a config that has none. No `env` block, unlike
 *  the Cursor/Windsurf JSON entry: codex is a terminal app, so the server
 *  inherits the shell's `ZEPH_API_KEY`, and an unexpanded `"${ZEPH_API_KEY}"`
 *  literal would shadow the ~/.zeph/config.json fallback with junk (the same
 *  reasoning as opencode's). */
export const CODEX_MCP_TABLE = ['[mcp_servers.zeph]', commandLine, argsLine].join('\n');

/** CRLF in, CRLF out — a Windows config must not come back with mixed endings. */
const eolOf = (config: string): string => (config.includes('\r\n') ? '\r\n' : '\n');
const splitLines = (config: string): string[] => config.split(/\r?\n/);

/** Line index of zeph's definition — header or inline — or -1. */
const definitionIndex = (lines: readonly string[]): number =>
    lines.findIndex((line) => isZephDefinition(line));

/** One past the last line of zeph's own key/value body (the next table header
 *  of any kind, or EOF). Meaningless for the inline form, which is one line. */
const bodyEnd = (lines: readonly string[], start: number): number => {
    const next = lines.slice(start + 1).findIndex((line) => ANY_TABLE_HEADER.test(line.trim()));
    return next === -1 ? lines.length : start + 1 + next;
};

/** One past the last line of the whole entry: body plus every sub-table of
 *  ours, stopping at the first header that belongs to someone else. */
const entryEnd = (lines: readonly string[], start: number): number => {
    let end = bodyEnd(lines, start);
    while (end < lines.length && ZEPH_SUBTABLE_HEADER.test(lines[end].trim())) {
        end = bodyEnd(lines, end);
    }
    return end;
};

/**
 * `end` walked back past the blank lines and comments that precede whatever
 * comes next. A comment sitting above `[mcp_servers.graft]` documents THAT
 * server; deleting it with our table is the exact loss this module exists to
 * avoid.
 */
const withoutTrailingPreamble = (lines: readonly string[], start: number, end: number): number => {
    let cut = end;
    while (cut > start + 1) {
        const line = lines[cut - 1].trim();
        if (line === '' || line.startsWith('#')) cut -= 1;
        else break;
    }
    return cut;
};

/** The document, ending in exactly one newline, so writing a config that
 *  already carries the table is a no-op rather than a one-byte diff. */
const rejoin = (lines: readonly string[], eol: string): string =>
    `${lines.join(eol).replace(/(?:\r?\n)+$/, '')}${eol}`;

/**
 * The config with zeph's entry present and current, leaving every other byte
 * alone. Appended at the end when absent: a table header ends the table before
 * it, so nothing above can capture the keys.
 */
export const upsertZephMcpTable = (config: string): string => {
    const eol = eolOf(config);
    const lines = splitLines(config);
    const start = definitionIndex(lines);
    if (start === -1) {
        const body = config.replace(/(?:\r?\n)+$/, '');
        const table = CODEX_MCP_TABLE.split('\n').join(eol);
        return `${body ? `${body}${eol}${eol}` : ''}${table}${eol}`;
    }

    // The inline form is a single line and cannot hold keys of ours to keep.
    if (ZEPH_INLINE_ENTRY.test(lines[start].trim())) {
        const table = CODEX_MCP_TABLE.split('\n');
        return rejoin([...lines.slice(0, start), ...table, ...lines.slice(start + 1)], eol);
    }

    const end = withoutTrailingPreamble(lines, start, bodyEnd(lines, start));
    const kept = lines.slice(start + 1, end).filter((line) => !OWNED_KEY.test(line.trim()));
    return rejoin([
        ...lines.slice(0, start),
        '[mcp_servers.zeph]',
        commandLine,
        argsLine,
        ...kept,
        ...lines.slice(end),
    ], eol);
};

/** The config with zeph's entry and its sub-tables gone, or null when it was
 *  never there (so the caller can report "nothing to remove" rather than
 *  rewriting an untouched file). */
export const removeZephMcpTable = (config: string): string | null => {
    const eol = eolOf(config);
    const lines = splitLines(config);
    const start = definitionIndex(lines);
    if (start === -1) return null;
    const end = ZEPH_INLINE_ENTRY.test(lines[start].trim())
        ? start + 1
        : withoutTrailingPreamble(lines, start, entryEnd(lines, start));
    const kept = [...lines.slice(0, start), ...lines.slice(end)];
    // The removed entry left its blank separator behind; collapse the run so
    // repeated install/uninstall cycles cannot grow the file.
    return `${kept.join(eol).replace(/(?:\r?\n){3,}/g, `${eol}${eol}`).replace(/(?:\r?\n)+$/, '')}${eol}`;
};

/**
 * The launch argv codex has recorded for zeph, verbatim, or null when there is
 * no entry. Same contract as `registeredMcpArgv` in verify.ts: returned
 * unnormalized, because a stale entry is only visible if the reader does not
 * reshape it into what it expects.
 */
export const readZephMcpArgv = (config: string): string[] | null => {
    const lines = splitLines(config);
    const start = definitionIndex(lines);
    if (start === -1) return null;
    // Joined, not scanned line by line: `args` is often written across several
    // lines, and a line-wise reader drops it — which verify would then report
    // as a stale registration for an entry that is in fact current.
    const body = ZEPH_INLINE_ENTRY.test(lines[start].trim())
        ? lines[start]
        : lines.slice(start + 1, bodyEnd(lines, start)).join('\n');

    const command = body.match(/(?:^|[\s,{])command\s*=\s*["']([^"']+)["']/)?.[1];
    if (!command) return null;
    const rawArgs = body.match(/(?:^|[\s,{])args\s*=\s*\[([^\]]*)\]/)?.[1] ?? '';
    const args = rawArgs
        .split(',')
        .map((a) => a.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean);
    return [command, ...args];
};
