import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { AGENT_SKILL_DIRS } from './agents.js';

/**
 * Scan the machine's installed agent skills into a name-only catalog.
 *
 * Payload discipline (plan PLAN-13-16-18): paths never leave this machine, so
 * the output carries skill names and nothing else.
 *
 * An entry is the slash command itself, so it carries whatever prefix the agent
 * registers the skill under (`AGENT_SKILL_PREFIX`, plugin names for Claude Code).
 *
 * Names come from the directory, not from the file — an ASSUMPTION, not a rule
 * the agents enforce: pi resolves a skill's name as `frontmatter.name` and only
 * falls back to the directory (`dist/core/skills.js:244`, pi 0.85.1), and its
 * docs say so outright ("Pi allows skill names to differ from their parent
 * directory"). It holds on every skill measured here — 132/132 under
 * `~/.claude/skills` and the installed plugins (2026-09-13), 12/12 under
 * `~/.agents/skills` (2026-09-13) — and a skill that breaks it shows the user a
 * command that does not run, which is the same as not listing it.
 *
 * Reading the file would buy the real name, and cost a YAML parser this scanner
 * is not equipped to be: 42 of 43 user skills quote their description and one
 * uses a folded scalar, so the regex this replaced shipped the quotes and
 * truncated to an unbalanced one. The file is opened for nothing but its own
 * existence until a divergent skill is actually measured.
 */

export interface AgentCommandEntry {
    /** What the user types after `/` — see `AGENT_SKILL_PREFIX`. */
    name: string;
}

/**
 * What each agent registers its skills as. The catalog exists to be typed into
 * the agent, so it carries the invocation token, not the bare directory name.
 *
 * pi registers `skill:<name>` (`docs/skills.md § Skill Commands`, and
 * `` `skill:${skill.name}` `` in its bundle, pi 0.85.1); typing `/01-plan` in a
 * pi session was observed to abort rather than run the skill (2026-09-13).
 * Claude Code's user skills are `/<name>`; its PLUGIN skills are
 * `/<plugin>:<name>`, so those get their prefix from the install entry instead.
 */
const AGENT_SKILL_PREFIX: Record<string, string> = {
    pi: 'skill:',
};

/** Agents that register skills filed under grouping folders — see `scanSkillDir`. */
const AGENT_SKILL_RECURSIVE = new Set(['pi']);

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
 * (`~/.agents/skills` had three) because the stat resolves through the link.
 */
const isSkillDir = (dir: string): boolean => {
    try {
        return statSync(join(dir, 'SKILL.md')).isFile();
    } catch {
        return false;
    }
};

/** A directory that is simply not there is not an error — every other one is. */
const isMissing = (err: unknown): boolean => {
    const code = (err as { code?: string })?.code;
    return code === 'ENOENT' || code === 'ENOTDIR';
};

/**
 * Directory entries, or none when the directory does not exist.
 *
 * Anything else — EACCES on a mode-000 skills dir, EIO on a stale network mount
 * — is rethrown rather than read as "no skills". Swallowing it would report an
 * empty catalog and blank the phone's menu, which is precisely the outcome the
 * listener's try/catch keeps the previous catalog to avoid.
 */
const entriesOf = (dir: string): string[] => {
    try {
        return readdirSync(dir);
    } catch (err) {
        if (isMissing(err)) return [];
        throw err;
    }
};

/**
 * How deep below a skills root a `SKILL.md` is still found. pi walks the tree
 * (`loadSkillsFromDirInternal`, `dist/core/skills.js:160`), so a skill filed
 * under a grouping folder is real to it; two levels covers the grouping folders
 * its docs describe without turning a stray checkout into a scan of the disk.
 */
const MAX_SKILL_DEPTH = 3;

/**
 * Skill directory names under `dir`. A directory holding `SKILL.md` IS the
 * skill and is not descended into — that is pi's own rule, and it keeps a
 * skill's bundled fixtures from being read as more skills.
 *
 * `recursive` mirrors the agent: pi groups skills in folders, while Claude Code
 * registers exactly `~/.claude/skills/<name>` — descending there would invent
 * commands out of directories it holds but does not register (`_shared/`).
 */
const scanSkillDir = (dir: string, recursive = false, depth = 1): string[] => {
    const names: string[] = [];
    for (const entry of entriesOf(dir)) {
        if (entry.startsWith('.') || entry === 'node_modules') continue;
        const child = join(dir, entry);
        if (isSkillDir(child)) {
            names.push(entry);
        } else if (recursive && depth < MAX_SKILL_DEPTH) {
            names.push(...scanSkillDir(child, true, depth + 1));
        }
    }
    return names;
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
    for (const [key, installs] of Object.entries(parsed.plugins ?? {})) {
        // Key is `<plugin>@<marketplace>`; the command prefix is the plugin half.
        const plugin = key.split('@')[0];
        for (const install of installs ?? []) {
            if (!install.installPath) continue;
            names.push(...scanSkillDir(join(install.installPath, 'skills')).map((name) => `${plugin}:${name}`));
        }
    }
    return names;
};

/** Byte length of the serialized catalog — the cap the ws frame actually feels. */
const payloadBytes = (catalog: AgentCommandCatalog): number => Buffer.byteLength(JSON.stringify(catalog), 'utf-8');

/**
 * Scan every agent's skill directories into one catalog. A directory that is
 * absent contributes nothing; a directory that exists and cannot be read throws,
 * and the caller keeps its previous catalog rather than publishing an empty one.
 * Dedup is within each agentKind only — the same skill installed for claude and
 * pi legitimately appears in both.
 */
export const scanAgentCommands = (homeDir: string): ScanResult => {
    const catalog: AgentCommandCatalog = {};
    for (const [agentId, dirs] of Object.entries(AGENT_SKILL_DIRS)) {
        const prefix = AGENT_SKILL_PREFIX[agentId] ?? '';
        const recursive = AGENT_SKILL_RECURSIVE.has(agentId);
        const names = dirs.flatMap((dir) =>
            scanSkillDir(join(homeDir, dir), recursive).map((name) => `${prefix}${name}`),
        );
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
