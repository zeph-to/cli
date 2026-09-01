/**
 * `zeph mcp` — run the Zeph MCP server inside THIS process.
 *
 * Every registration used to say `npx -y @zeph-to/mcp-server`, which left an
 * `npm exec` launcher resident for the whole session on top of the server it
 * spawned — two node processes where one does the work. `@zeph-to/mcp-server`
 * is a dependency of this package now, so agents register `zeph mcp` and get
 * exactly one process.
 */

/**
 * Importing `@zeph-to/mcp-server` IS starting it: the package is a bin entry
 * whose module body wires an McpServer to a StdioServerTransport and exports
 * nothing. Verified against 2.3.0 (`dist/index.js` ends in `main().catch(…)`).
 * Injectable so tests don't need the real package resolvable.
 */
type McpServerLoader = () => Promise<unknown>;

const importMcpServer: McpServerLoader = () => import('@zeph-to/mcp-server');

export const handleMcp = async (load: McpServerLoader = importMcpServer): Promise<number> => {
    try {
        await load();
    } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        console.error(`zeph: could not start the MCP server (@zeph-to/mcp-server): ${reason}`);
        console.error('zeph: reinstall the CLI with `npm i -g @zeph-to/cli`.');
        return 1;
    }

    // The server owns this process from here: it holds stdio open and decides
    // when to exit. Resolving would hand cli.ts a code for `process.exit()`,
    // killing the server the line above just started.
    return new Promise<number>(() => {});
};
