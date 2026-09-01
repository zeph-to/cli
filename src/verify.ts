import { accessSync, constants, existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { execFileSync } from 'child_process';
import { detectAgents, hasCommand } from './agents.js';
import { loadConfig, resolvedEnv, resolveHookId, VERSION } from './config.js';
import { serviceHealthChecks, serviceStatus, type ServiceHealthRow } from './listener-service.js';
import { ZephHook } from './zeph-hook.js';
import { MCP_LAUNCH_ARGV } from './mcp-command.js';

const HOME = homedir();

const pass = (msg: string) => console.log(`    ✓ ${msg}`);
const warn = (msg: string) => console.log(`    ! ${msg}`);
const failMsg = (msg: string) => console.log(`    ✗ ${msg}`);

// The service health rows already carry exactly this shape, and every check
// here is recorded the same way — one declaration, not two kept in step by hand.
type Check = ServiceHealthRow;

/** Does a shared rule file contain the Zeph managed block? */
const hasManagedBlock = (filePath: string): boolean => {
    try {
        return readFileSync(filePath, 'utf-8').includes('ZEPH:START');
    } catch {
        return false;
    }
};

// Per-agent: report whether the rule artifact Zeph installs is present.
const AGENT_RULE_PRESENT: Record<string, () => boolean> = {
    claude: () => {
        try { return /zeph/.test(readFileSync(join(HOME, '.claude.json'), 'utf-8')); }
        catch { return existsSync(join(HOME, '.claude', 'plugins')); }
    },
    cursor: () => existsSync(join(HOME, '.cursor', 'rules', 'zeph.mdc')),
    windsurf: () => hasManagedBlock(join(HOME, '.codeium', 'windsurf', 'memories', 'global_rules.md')),
    gemini: () => hasManagedBlock(join(HOME, '.gemini', 'GEMINI.md')),
    codex: () => hasManagedBlock(join(HOME, '.codex', 'AGENTS.md')),
    copilot: () => existsSync(join(HOME, '.copilot', 'instructions', 'zeph.instructions.md')),
    cline: () => existsSync(join(HOME, '.cline', 'rules', 'zeph.md')),
    aider: () => existsSync(join(HOME, '.zeph', 'aider-conventions.md')),
    pi: () => hasManagedBlock(join(HOME, '.pi', 'agent', 'AGENTS.md')),
    opencode: () => hasManagedBlock(join(HOME, '.config', 'opencode', 'AGENTS.md')),
};

/** Where each agent records the MCP launch `zeph install` writes, and under which container key. */
export const MCP_REGISTRIES: ReadonlyArray<{ agent: string; path: string; key: string }> = [
    { agent: 'Cursor', path: join(HOME, '.cursor', 'mcp.json'), key: 'mcpServers' },
    { agent: 'Windsurf', path: join(HOME, '.codeium', 'windsurf', 'mcp_config.json'), key: 'mcpServers' },
    { agent: 'Gemini', path: join(HOME, '.gemini', 'settings.json'), key: 'mcpServers' },
    { agent: 'OpenCode', path: join(HOME, '.config', 'opencode', 'opencode.json'), key: 'mcp' },
];

/**
 * The launch argv a registry file records for zeph, verbatim — null when the
 * file is absent, unparseable, or has no zeph entry. Two schemas in the wild:
 * `command` + `args` (Cursor/Windsurf/Gemini) and `command` as a whole array
 * (opencode). Returned as-is on purpose: a stale entry is only detectable if
 * the reader does not normalize it into the shape it expects.
 */
export const registeredMcpArgv = (filePath: string, key: string): string[] | null => {
    let data: Record<string, unknown>;
    try {
        data = JSON.parse(readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
    } catch {
        return null;
    }
    const container = data[key] as Record<string, unknown> | undefined;
    const entry = container?.zeph as { command?: unknown; args?: unknown } | undefined;
    if (!entry) return null;
    if (Array.isArray(entry.command)) return entry.command.map(String);
    if (typeof entry.command !== 'string') return null;
    return [entry.command, ...(Array.isArray(entry.args) ? entry.args.map(String) : [])];
};

/**
 * Can this launch binary actually be run? Registered commands come out of a
 * config file, so they can be an absolute path with spaces in it — the shared
 * `hasCommand` interpolates into `which ${cmd}`, where such a path splits into
 * two words and reports a perfectly good binary as missing (and where any `;`
 * in the file would reach the shell). Nothing here touches a shell.
 */
export const binaryResolves = (bin: string): boolean => {
    if (bin.includes('/')) {
        try {
            accessSync(bin, constants.X_OK);
            return true;
        } catch {
            return false;
        }
    }
    try {
        execFileSync('which', [bin], { stdio: 'pipe' });
        return true;
    } catch {
        return false;
    }
};

/**
 * What a recorded registration is worth right now. `unresolvable` outranks
 * `stale`: a stale entry still starts a server (through the npm launcher this
 * release exists to delete), an unresolvable one starts nothing at all and
 * takes the agent's whole zeph toolset down with it, silently — the config is
 * read once at install time and never checked again.
 */
export type McpRegistration =
    | { readonly state: 'absent' }
    | { readonly state: 'current' }
    | { readonly state: 'stale'; readonly argv: string[] }
    | { readonly state: 'unresolvable'; readonly argv: string[] };

export const classifyMcpRegistration = (
    argv: string[] | null,
    isOnPath: (bin: string) => boolean,
): McpRegistration => {
    if (!argv || argv.length === 0) return { state: 'absent' };
    if (!isOnPath(argv[0])) return { state: 'unresolvable', argv };
    const isCanonical = argv.length === MCP_LAUNCH_ARGV.length
        && argv.every((token, i) => token === MCP_LAUNCH_ARGV[i]);
    return isCanonical ? { state: 'current' } : { state: 'stale', argv };
};

/** The registries that actually hold a zeph entry, classified. Absent ones drop
 *  out here so the report has no row for an agent that was never installed. */
const activeMcpRegistrations = (
    isOnPath: (bin: string) => boolean,
): Array<{ agent: string; result: Exclude<McpRegistration, { state: 'absent' }> }> =>
    MCP_REGISTRIES.flatMap((registry) => {
        const result = classifyMcpRegistration(registeredMcpArgv(registry.path, registry.key), isOnPath);
        return result.state === 'absent' ? [] : [{ agent: registry.agent, result }];
    });

export const handleVerify = async (args: Record<string, string | boolean>): Promise<number> => {
    const doPing = args.ping === true;
    const checks: Check[] = [];
    const record = (label: string, state: Check['state']) => {
        checks.push({ label, state });
        if (state === 'pass') pass(label);
        else if (state === 'warn') warn(label);
        else failMsg(label);
    };

    console.log(`\n  Zeph verify — v${VERSION}\n`);

    // ── Credentials ──────────────────────────────────────────────
    console.log('  Credentials:');
    const config = loadConfig();
    const apiKey = resolvedEnv('ZEPH_API_KEY') || config.apiKey;
    const hookId = resolveHookId();
    record(apiKey ? 'ZEPH_API_KEY is set' : 'ZEPH_API_KEY not set (env or ~/.zeph/config.json)',
        apiKey ? 'pass' : 'fail');
    record(hookId
        ? 'ZEPH_HOOK_ID is set (two-way zeph_ask/prompt/input enabled)'
        : 'ZEPH_HOOK_ID not set (notify-only — set it for remote control)',
        hookId ? 'pass' : 'warn');

    // ── Runtime ──────────────────────────────────────────────────
    console.log('\n  Runtime:');
    record(hasCommand('node') ? 'node available' : 'node not found', hasCommand('node') ? 'pass' : 'fail');
    record(hasCommand('npx') ? 'npx available (hook fallback when zeph is off PATH)' : 'npx not found',
        hasCommand('npx') ? 'pass' : 'warn');
    // Not a warning any more: `zeph mcp` IS the MCP server, so a zeph that
    // isn't on PATH means no MCP tools at all, not just a slower first call.
    record(hasCommand('zeph')
        ? 'zeph CLI on PATH (runs the MCP server and the hooks)'
        : 'zeph CLI not on PATH — MCP tools will not start. Reinstall: npm i -g @zeph-to/cli',
        hasCommand('zeph') ? 'pass' : 'fail');

    // ── Login-time service ───────────────────────────────────────
    // Optional, so a missing one is a warning. A broken one is not: every way
    // it breaks still looks installed from the outside.
    const serviceRows = serviceHealthChecks(serviceStatus());
    if (serviceRows.length > 0) {
        console.log('\n  Login-time service:');
        for (const row of serviceRows) record(row.label, row.state);
    }

    // ── MCP registrations ────────────────────────────────────────
    const registrations = activeMcpRegistrations(binaryResolves);
    if (registrations.length > 0) {
        console.log('\n  MCP registrations:');
        for (const { agent, result } of registrations) {
            if (result.state === 'current') record(`${agent}: launches \`${MCP_LAUNCH_ARGV.join(' ')}\``, 'pass');
            else if (result.state === 'stale') {
                record(`${agent}: still launches \`${result.argv.join(' ')}\` — one extra resident process per session. Re-run: zeph install`, 'warn');
            } else {
                record(`${agent}: launches \`${result.argv[0]}\`, which is not on PATH — zeph tools will not load. Re-run: zeph install`, 'fail');
            }
        }
    }

    // ── Per-agent config ─────────────────────────────────────────
    console.log('\n  Agents:');
    const detected = detectAgents().filter((a) => a.detected);
    if (detected.length === 0) {
        warn('no supported agents detected');
    }
    for (const agent of detected) {
        const present = AGENT_RULE_PRESENT[agent.id]?.() ?? false;
        record(`${agent.name}: ${present ? 'Zeph rules installed' : 'Zeph rules NOT installed — run: zeph install'}`,
            present ? 'pass' : 'warn');
    }

    // ── Optional live API ping ───────────────────────────────────
    if (doPing) {
        console.log('\n  API ping:');
        if (!apiKey) {
            record('skipped — no API key', 'warn');
        } else {
            try {
                const hook = new ZephHook({ apiKey, ...(config.baseUrl && { baseUrl: config.baseUrl }) });
                await hook.list({ limit: 1 });
                record('API reachable, key accepted', 'pass');
            } catch (err) {
                record(`API call failed: ${err instanceof Error ? err.message : 'unknown'}`, 'fail');
            }
        }
    }

    // ── Summary ──────────────────────────────────────────────────
    const fails = checks.filter((c) => c.state === 'fail').length;
    const warns = checks.filter((c) => c.state === 'warn').length;
    console.log('');
    if (fails === 0 && warns === 0) {
        console.log('  ✓ All checks passed.\n');
    } else {
        console.log(`  ${fails} failed, ${warns} warnings.${doPing ? '' : ' (run with --ping to test the API)'}\n`);
    }
    return fails === 0 ? 0 : 1;
};
