import { execSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync, rmSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { detectAgents } from './agents.js';
import { removeManagedBlock } from './templates.js';
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

/** Remove just the `zeph` entry from an mcpServers JSON file. */
const rmMcpEntry = (filePath: string, dry: boolean): string | null => {
    if (!existsSync(filePath)) return null;
    let data: Record<string, unknown>;
    try {
        data = JSON.parse(readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
    } catch {
        return null;
    }
    const servers = data.mcpServers as Record<string, unknown> | undefined;
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

/** Remove just the zeph-notify entry from Gemini's settings.json. */
const rmGeminiHook = (filePath: string, dry: boolean): string | null => {
    if (!existsSync(filePath)) return null;
    let data: Record<string, unknown>;
    try {
        data = JSON.parse(readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
    } catch {
        return null;
    }
    const hooks = data.hooks as Record<string, unknown> | undefined;
    const afterAgent = hooks?.AfterAgent as Array<{ hooks?: Array<{ name?: string }> }> | undefined;
    if (!Array.isArray(afterAgent)) return null;
    const kept = afterAgent.filter(
        (entry) => !(entry.hooks ?? []).some((h) => h.name === 'zeph-notify'),
    );
    if (kept.length === afterAgent.length) return null; // nothing of ours
    if (!dry) {
        if (kept.length === 0) {
            delete (hooks as Record<string, unknown>).AfterAgent;
        } else {
            (hooks as Record<string, unknown>).AfterAgent = kept;
        }
        writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
    }
    return `${verb(dry)} zeph-notify hook from ${filePath}`;
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
            try { execSync('gemini mcp remove zeph', { stdio: 'pipe' }); ok('MCP server removed'); }
            catch { skip('gemini MCP entry not found'); }
        } else {
            skip('would run: gemini mcp remove zeph');
        }
        runSteps([
            () => rmGeminiHook(join(HOME, '.gemini', 'settings.json'), dry),
            () => stripManagedRule(join(HOME, '.gemini', 'GEMINI.md'), dry),
        ]);
    },
    codex: (dry) => runSteps([
        () => rmFile(join(HOME, '.codex', 'hooks.json'), dry),
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
