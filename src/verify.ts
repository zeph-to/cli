import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { detectAgents, hasCommand } from './agents.js';
import { loadConfig, resolvedEnv, VERSION } from './config.js';
import { ZephHook } from './zeph-hook.js';

const HOME = homedir();

const pass = (msg: string) => console.log(`    ✓ ${msg}`);
const warn = (msg: string) => console.log(`    ! ${msg}`);
const failMsg = (msg: string) => console.log(`    ✗ ${msg}`);

interface Check {
    label: string;
    state: 'pass' | 'warn' | 'fail';
}

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
};

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
    const hookId = resolvedEnv('ZEPH_HOOK_ID') || config.hookId;
    record(apiKey ? 'ZEPH_API_KEY is set' : 'ZEPH_API_KEY not set (env or ~/.zeph/config.json)',
        apiKey ? 'pass' : 'fail');
    record(hookId
        ? 'ZEPH_HOOK_ID is set (two-way zeph_ask/prompt/input enabled)'
        : 'ZEPH_HOOK_ID not set (notify-only — set it for remote control)',
        hookId ? 'pass' : 'warn');

    // ── Runtime ──────────────────────────────────────────────────
    console.log('\n  Runtime:');
    record(hasCommand('node') ? 'node available' : 'node not found', hasCommand('node') ? 'pass' : 'fail');
    record(hasCommand('npx') ? 'npx available (MCP server runs via npx)' : 'npx not found',
        hasCommand('npx') ? 'pass' : 'fail');
    record(hasCommand('zeph')
        ? 'zeph CLI on PATH'
        : 'zeph CLI not on PATH (hooks fall back to npx — slower first call)',
        hasCommand('zeph') ? 'pass' : 'warn');

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
