import { execSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync, rmSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { detectAgents } from './agents.js';
import { SERVICE_LABEL, serviceInstalled, uninstallService } from './listener-service.js';
import { isZephHookGroup, removeManagedBlock } from './templates.js';
import { CONFIG_FILE, VERSION } from './config.js';

const HOME = homedir();

const ok = (msg: string) => console.log(`    + ${msg}`);
const skip = (msg: string) => console.log(`    - ${msg}`);

// ── Removal primitives ───────────────────────────────────────────
// Each primitive returns a short human description of what it did (or
// would do, in dry-run), or null when there was nothing to remove.

/** Past/conditional verb so dry-run output reads honestly. */
const verb = (dry: boolean): string => (dry ? 'would remove' : 'removed');

/** Delete a file Zeph fully owns. */
const rmFile = (filePath: string, dry: boolean): string | null => {
    if (!existsSync(filePath)) return null;
    if (!dry) rmSync(filePath, { force: true });
    return `${verb(dry)} ${filePath}`;
};

/** Remove just the `zeph` entry from an MCP registry JSON file. `key` is the
 *  container: `mcpServers` for Cursor/Windsurf, top-level `mcp` for
 *  opencode.json (opencode's own schema). Exported for tests. */
export const rmMcpEntry = (filePath: string, dry: boolean, key = 'mcpServers'): string | null => {
    if (!existsSync(filePath)) return null;
    let data: Record<string, unknown>;
    try {
        data = JSON.parse(readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
    } catch {
        return null;
    }
    const servers = data[key] as Record<string, unknown> | undefined;
    if (!servers || !('zeph' in servers)) return null;
    if (!dry) {
        delete servers.zeph;
        writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
    }
    return `${verb(dry)} zeph from ${filePath}`;
};

/** Strip the <!-- ZEPH:START/END --> block from a shared rule file. */
const stripManagedRule = (filePath: string, dry: boolean): string | null => {
    if (!existsSync(filePath)) return null;
    const existing = readFileSync(filePath, 'utf-8');
    const stripped = removeManagedBlock(existing);
    if (stripped === existing) return null; // no Zeph block present
    if (!dry) {
        if (stripped.trim() === '') {
            rmSync(filePath, { force: true }); // file was ours alone
        } else {
            writeFileSync(filePath, stripped);
        }
    }
    return `${verb(dry)} Zeph block from ${filePath}`;
};

/** Drop the Zeph `read:` directive from ~/.aider.conf.yml. */
const rmAiderReadDirective = (confPath: string, dry: boolean): string | null => {
    if (!existsSync(confPath)) return null;
    const conf = readFileSync(confPath, 'utf-8');
    if (!conf.includes('# Added by Zeph')) return null;
    // Drop the "# Added by Zeph" line and the "read:" line that follows it.
    const lines = conf.split('\n');
    const out: string[] = [];
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].trim() === '# Added by Zeph') {
            if (lines[i + 1]?.trimStart().startsWith('read:')) i++; // skip read: too
            continue;
        }
        out.push(lines[i]);
    }
    if (!dry) writeFileSync(confPath, out.join('\n').replace(/\n{3,}/g, '\n\n'));
    return `${verb(dry)} Zeph read: directive from ${confPath}`;
};

/**
 * Filter zeph-written matcher groups out of `data.hooks` (all events).
 * Mutates `data` unless dry; returns true when anything of ours was found.
 * Empty events are deleted so a clean file stays clean.
 */
const stripZephHookGroups = (data: Record<string, unknown>, dry: boolean): boolean => {
    const hooks = data.hooks as Record<string, unknown> | undefined;
    if (!hooks) return false;
    let removed = false;
    for (const event of Object.keys(hooks)) {
        const groups = hooks[event];
        if (!Array.isArray(groups)) continue;
        const kept = groups.filter((g) => !isZephHookGroup(g));
        if (kept.length === groups.length) continue; // nothing of ours
        removed = true;
        if (!dry) {
            if (kept.length === 0) delete hooks[event];
            else hooks[event] = kept;
        }
    }
    return removed;
};

/** Remove just the zeph-written entries from Gemini's settings.json.
 *  Exported for tests (gemini is PATH-detected, so the full-uninstall
 *  suite can't reach this deterministically). */
export const rmGeminiHook = (filePath: string, dry: boolean): string | null => {
    if (!existsSync(filePath)) return null;
    let data: Record<string, unknown>;
    try {
        data = JSON.parse(readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
    } catch {
        return null;
    }
    if (!stripZephHookGroups(data, dry)) return null;
    if (!dry) writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
    return `${verb(dry)} zeph hooks from ${filePath}`;
};

/** Remove the zeph-written entries from Codex's hooks.json. The file is
 *  usually zeph-born, so it is deleted outright when nothing else remains —
 *  but events the user added since install survive. Exported for tests
 *  (codex is PATH-detected, same as gemini). */
export const rmCodexHook = (filePath: string, dry: boolean): string | null => {
    if (!existsSync(filePath)) return null;
    let data: Record<string, unknown>;
    try {
        data = JSON.parse(readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
    } catch {
        return null;
    }
    if (!stripZephHookGroups(data, dry)) return null;
    if (!dry) {
        const hooks = data.hooks as Record<string, unknown>;
        if (Object.keys(hooks).length === 0) rmSync(filePath, { force: true });
        else writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
    }
    return `${verb(dry)} zeph hooks from ${filePath}`;
};

// ── Per-agent uninstallers ───────────────────────────────────────

type Step = () => string | null;

const runSteps = (steps: Step[]): void => {
    let did = false;
    for (const step of steps) {
        const result = step();
        if (result) { ok(result); did = true; }
    }
    if (!did) skip('nothing to remove');
};

const AGENT_UNINSTALLERS: Record<string, (dry: boolean) => void> = {
    claude: (dry) => {
        if (dry) { skip('would run: claude plugin uninstall zeph@zeph'); return; }
        try {
            execSync('claude plugin uninstall zeph@zeph', { stdio: 'pipe' });
            ok('plugin uninstalled');
        } catch {
            skip('plugin not installed (or claude CLI unavailable)');
        }
    },
    cursor: (dry) => runSteps([
        () => rmMcpEntry(join(HOME, '.cursor', 'mcp.json'), dry),
        () => rmFile(join(HOME, '.cursor', 'hooks.json'), dry),
        () => rmFile(join(HOME, '.cursor', 'rules', 'zeph.mdc'), dry),
    ]),
    windsurf: (dry) => runSteps([
        () => rmMcpEntry(join(HOME, '.codeium', 'windsurf', 'mcp_config.json'), dry),
        () => rmFile(join(HOME, '.codeium', 'windsurf', 'hooks.json'), dry),
        () => stripManagedRule(join(HOME, '.codeium', 'windsurf', 'memories', 'global_rules.md'), dry),
    ]),
    gemini: (dry) => {
        if (!dry) {
            // user scope first (where the ≥0.26 installer adds it), then the
            // legacy scope-less form for entries created by older installs.
            try { execSync('gemini mcp remove -s user zeph', { stdio: 'pipe' }); ok('MCP server removed'); }
            catch {
                try { execSync('gemini mcp remove zeph', { stdio: 'pipe' }); ok('MCP server removed'); }
                catch { skip('gemini MCP entry not found'); }
            }
        } else {
            skip('would run: gemini mcp remove -s user zeph');
        }
        runSteps([
            () => rmGeminiHook(join(HOME, '.gemini', 'settings.json'), dry),
            () => stripManagedRule(join(HOME, '.gemini', 'GEMINI.md'), dry),
        ]);
    },
    codex: (dry) => runSteps([
        () => rmCodexHook(join(HOME, '.codex', 'hooks.json'), dry),
        () => stripManagedRule(join(HOME, '.codex', 'AGENTS.md'), dry),
    ]),
    copilot: (dry) => runSteps([
        () => rmFile(join(HOME, '.copilot', 'hooks', 'zeph.json'), dry),
        () => rmFile(join(HOME, '.copilot', 'instructions', 'zeph.instructions.md'), dry),
    ]),
    cline: (dry) => runSteps([
        () => rmFile(join(HOME, '.cline', 'rules', 'zeph.md'), dry),
    ]),
    aider: (dry) => runSteps([
        () => rmFile(join(HOME, '.zeph', 'aider-conventions.md'), dry),
        () => rmAiderReadDirective(join(HOME, '.aider.conf.yml'), dry),
    ]),
    pi: (dry) => runSteps([
        () => rmFile(join(HOME, '.pi', 'agent', 'extensions', 'zeph.ts'), dry),
        () => stripManagedRule(join(HOME, '.pi', 'agent', 'AGENTS.md'), dry),
    ]),
    opencode: (dry) => runSteps([
        () => rmMcpEntry(join(HOME, '.config', 'opencode', 'opencode.json'), dry, 'mcp'),
        () => rmFile(join(HOME, '.config', 'opencode', 'plugins', 'zeph.ts'), dry),
        () => stripManagedRule(join(HOME, '.config', 'opencode', 'AGENTS.md'), dry),
    ]),
};

/**
 * Remove the login-time LaunchAgent, if one is installed.
 *
 * Async, so it does not fit the sync `Step` shape the per-agent uninstallers
 * use — launchctl has to be waited on. Returns the same "one line or null"
 * contract those steps do.
 */
export const removeServiceStep = async (dry: boolean): Promise<string | null> => {
    if (!serviceInstalled()) return null;
    if (dry) return `would remove the login-time service (${SERVICE_LABEL})`;
    const result = await uninstallService();
    if (!result.ok) return `could not remove the login-time service: ${result.reason}`;
    return `removed the login-time service (${SERVICE_LABEL})`;
};

// ── Entry point ──────────────────────────────────────────────────

export const handleUninstall = async (args: Record<string, string | boolean>): Promise<number> => {
    const dry = args['dry-run'] === true;
    const purge = args.purge === true;

    console.log(`\n  Zeph uninstall${dry ? ' (dry-run)' : ''} — v${VERSION}\n`);

    const detected = detectAgents().filter((a) => a.detected);
    if (detected.length === 0) {
        console.log('  No supported agents detected.\n');
    }

    for (const agent of detected) {
        console.log(`  ${agent.name}:`);
        AGENT_UNINSTALLERS[agent.id]?.(dry);
    }

    // The LaunchAgent outlives every agent's rules, so removing it is part of
    // uninstall and not of any one agent's teardown.
    console.log('\n  Login-time service:');
    const serviceLine = await removeServiceStep(dry);
    if (serviceLine) ok(serviceLine); else skip('not installed');

    // ~/.zeph/config.json holds the API key — kept by default so a
    // re-install doesn't need the key re-entered. --purge removes it.
    console.log('\n  Config:');
    if (purge) {
        const removed = rmFile(CONFIG_FILE, dry);
        if (removed) ok(removed); else skip('no config file');
    } else {
        skip(`kept ${CONFIG_FILE} (pass --purge to remove)`);
    }

    console.log(dry
        ? '\n  Dry-run complete — nothing was changed.\n'
        : '\n  Uninstall complete. Restart your agents.\n');
    return 0;
};
