import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { AGENT_SKILL_DIRS } from './agents.js';

/**
 * Scan the machine's installed agent skills into a name-only catalog.
 *
 * Payload discipline (plan PLAN-13-16-18): paths never leave this machine, so
 * the output carries skill names and nothing else.
 *
 * Names come from the directory, not from the file. Every skill on this machine
 * (132/132, measured 2026-09-13 across `~/.claude/skills` and every installed
 * plugin) declares a frontmatter `name` equal to its directory name, and the
 * agents themselves address a skill by that directory. Reading the file bought
 * a second copy of the same string — and cost a YAML parser this scanner is not
 * equipped to be: 42 of 43 user skills quote their description and one uses a
 * folded scalar, so a regex shipped the quotes and truncated to an unbalanced
 * one. The file is now opened for nothing but its own existence.
 */

export interface AgentCommandEntry {
    name: string;
}

/** agentKind -> skill entries; agents with no skills are omitted. */
export type AgentCommandCatalog = Record<string, AgentCommandEntry[]>;

/** Serialized-catalog budget. Names-only measures ~2KB here; ws frames die at 128KB. */
export const PAYLOAD_LIMIT_BYTES = 64 * 1024;

export interface ScanResult {
    catalog: AgentCommandCatalog;
    /** Skills cut to fit the budget. Non-zero is worth a log line — never shrink silently. */
    dropped: number;
}

/**
 * True when `<dir>/SKILL.md` is a readable file. This is the whole membership
 * test: it rejects non-skill directories, and it rejects dangling symlinks
 * (`~/.pi/skills` had three) because the stat resolves through the link.
 */
const isSkillDir = (dir: string): boolean => {
    try {
        return statSync(join(dir, 'SKILL.md')).isFile();
    } catch {
        return false;
    }
};

const scanSkillDir = (dir: string): string[] => {
    let names: string[];
    try {
        names = readdirSync(dir);
    } catch {
        return [];
    }
    return names.filter((name) => isSkillDir(join(dir, name)));
};

/**
 * Plugin skills live at `<installPath>/skills/<name>/SKILL.md`. Only install paths
 * listed in `installed_plugins.json` are scanned — the plugin cache also holds
 * uninstalled marketplace entries (514 of 710 on this machine) that must not
 * appear.
 */
const scanClaudePlugins = (home: string): string[] => {
    let parsed: { plugins?: Record<string, Array<{ installPath?: string }>> };
    try {
        parsed = JSON.parse(readFileSync(join(home, '.claude', 'plugins', 'installed_plugins.json'), 'utf-8'));
    } catch {
        return [];
    }
    const names: string[] = [];
    for (const installs of Object.values(parsed.plugins ?? {})) {
        for (const install of installs ?? []) {
            if (!install.installPath) continue;
            names.push(...scanSkillDir(join(install.installPath, 'skills')));
        }
    }
    return names;
};

/** Byte length of the serialized catalog — the cap the ws frame actually feels. */
const payloadBytes = (catalog: AgentCommandCatalog): number => Buffer.byteLength(JSON.stringify(catalog), 'utf-8');

/**
 * Scan every agent's skill directories into one catalog. Per-agent failures
 * degrade to no entries; the caller keeps its previous catalog when the scan as
 * a whole throws. Dedup is within each agentKind only — the same skill
 * installed for claude and pi legitimately appears in both.
 */
export const scanAgentCommands = (homeDir: string): ScanResult => {
    const catalog: AgentCommandCatalog = {};
    for (const [agentId, dirs] of Object.entries(AGENT_SKILL_DIRS)) {
        const names = dirs.flatMap((dir) => scanSkillDir(join(homeDir, dir)));
        if (agentId === 'claude') names.push(...scanClaudePlugins(homeDir));
        const merged = [...new Set(names)].map((name) => ({ name }));
        if (merged.length > 0) catalog[agentId] = merged;
    }

    // Enforce the serialized budget by dropping whole skills from the tail. The
    // catalog is ~2KB in practice, so this loop is a backstop, not a hot path —
    // it re-measures the real payload each pass rather than keeping a running
    // subtraction that no realistic input would ever exercise.
    let dropped = 0;
    while (payloadBytes(catalog) > PAYLOAD_LIMIT_BYTES) {
        const lastAgent = Object.keys(catalog).pop();
        if (!lastAgent) break;
        catalog[lastAgent].pop();
        dropped += 1;
        if (catalog[lastAgent].length === 0) delete catalog[lastAgent];
    }
    return { catalog, dropped };
};
