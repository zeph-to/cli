import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { AGENT_SKILL_DIRS } from './agents.js';

/**
 * Scan the machine's installed agent skills into a name+description catalog.
 *
 * Payload discipline (plan PLAN-13-16-18): paths never leave this machine, so
 * the output carries names and descriptions only. The result is what the
 * `listener.commands` ws message serializes, so the size cap is on serialized
 * bytes, not entry count.
 */

export interface AgentCommandEntry {
    name: string;
    description: string;
}

/** agentKind -> skill entries; agents with no skills are omitted. */
export type AgentCommandCatalog = Record<string, AgentCommandEntry[]>;

const DESCRIPTION_LIMIT = 120;
/** Serialized-catalog budget. Measured: full install fits in ~12.5KB; ws frames die at 128KB. */
const PAYLOAD_LIMIT_BYTES = 64 * 1024;

/**
 * Parse `name` and `description` out of the leading YAML frontmatter of a
 * SKILL.md. Only the first 4KB is read — frontmatter is at the top by
 * convention and skill bodies run large. Returns null when there is no
 * parseable frontmatter.
 */
export const parseSkillFrontmatter = (skillMdPath: string): AgentCommandEntry | null => {
    let fd: ReturnType<typeof readFileSync>;
    try {
        fd = readFileSync(skillMdPath, { encoding: 'utf-8', flag: 'r' });
    } catch {
        return null;
    }
    const head = fd.slice(0, 4096);
    const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(head);
    if (!match) return null;
    const name = /^name:\s*(.+)$/m.exec(match[1])?.[1]?.trim();
    const description = /^description:\s*(.+)$/m.exec(match[1])?.[1]?.trim();
    if (!name) return null;
    return { name, description: (description ?? '').slice(0, DESCRIPTION_LIMIT) };
};

/** True when the path exists through symlinks — false for dangling links. */
const resolvesOnDisk = (path: string): boolean => {
    try {
        statSync(path);
        return true;
    } catch {
        return false;
    }
};

const scanSkillDir = (dir: string): AgentCommandEntry[] => {
    let names: string[];
    try {
        names = readdirSync(dir);
    } catch {
        return [];
    }
    const entries: AgentCommandEntry[] = [];
    const seen = new Set<string>();
    for (const name of names) {
        const path = join(dir, name);
        if (!resolvesOnDisk(path)) continue; // dangling symlink or vanished dir
        try {
            if (!statSync(path).isDirectory()) continue;
        } catch {
            continue;
        }
        const entry = parseSkillFrontmatter(join(path, 'SKILL.md'));
        if (entry && !seen.has(entry.name)) {
            seen.add(entry.name);
            entries.push(entry);
        }
    }
    return entries;
};

/**
 * Plugin skills live at `<installPath>/skills/<name>/SKILL.md`. Only install paths
 * listed in `installed_plugins.json` are scanned — the plugin cache also holds
 * uninstalled marketplace entries (514 of 710 on this machine) that must not
 * appear.
 */
const scanClaudePlugins = (home: string): AgentCommandEntry[] => {
    let raw: string;
    try {
        raw = readFileSync(join(home, '.claude', 'plugins', 'installed_plugins.json'), 'utf-8');
    } catch {
        return [];
    }
    let parsed: { plugins?: Record<string, Array<{ installPath?: string }>> };
    try {
        parsed = JSON.parse(raw);
    } catch {
        return [];
    }
    const entries: AgentCommandEntry[] = [];
    const seen = new Set<string>();
    for (const installs of Object.values(parsed.plugins ?? {})) {
        for (const install of installs ?? []) {
            if (!install.installPath) continue;
            for (const entry of scanSkillDir(join(install.installPath, 'skills'))) {
                if (!seen.has(entry.name)) {
                    seen.add(entry.name);
                    entries.push(entry);
                }
            }
        }
    }
    return entries;
};

/** Byte length of the serialized catalog — the cap the ws frame actually feels. */
const payloadBytes = (catalog: AgentCommandCatalog): number => Buffer.byteLength(JSON.stringify(catalog), 'utf-8');

/**
 * Scan every agent's skill directories into one catalog. Per-agent failures
 * degrade to empty entries; the caller keeps its previous catalog when the
 * scan as a whole throws. Dedup is within each agentKind only — the same skill
 * installed for claude and pi legitimately appears in both.
 */
export const scanAgentCommands = (homeDir: string): AgentCommandCatalog => {
    const catalog: AgentCommandCatalog = {};
    for (const [agentId, dirs] of Object.entries(AGENT_SKILL_DIRS)) {
        const merged: AgentCommandEntry[] = [];
        const seen = new Set<string>();
        for (const dir of dirs) {
            for (const entry of scanSkillDir(join(homeDir, dir))) {
                if (!seen.has(entry.name)) {
                    seen.add(entry.name);
                    merged.push(entry);
                }
            }
        }
        if (agentId === 'claude') {
            for (const entry of scanClaudePlugins(homeDir)) {
                if (!seen.has(entry.name)) {
                    seen.add(entry.name);
                    merged.push(entry);
                }
            }
        }
        if (merged.length > 0) catalog[agentId] = merged;
    }

    // Enforce the serialized budget by dropping whole skills from the tail.
    // Count what was cut so the caller can log it — never shrink silently.
    while (payloadBytes(catalog) > PAYLOAD_LIMIT_BYTES) {
        const lastAgent = Object.keys(catalog).pop();
        if (!lastAgent) break;
        const dropped = catalog[lastAgent].pop();
        if (dropped && catalog[lastAgent].length === 0) delete catalog[lastAgent];
        if (!dropped) break;
        console.warn(`[command-scan] payload over ${PAYLOAD_LIMIT_BYTES}B — dropped skill '${dropped.name}' (${lastAgent})`);
    }
    return catalog;
};
