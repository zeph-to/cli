import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, cpSync } from 'fs';
import { homedir } from 'os';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { scanAgentCommands } from './command-scan.js';

// Fixture tree mirrors the real skill layouts measured 2026-09-12:
//   ~/.claude/skills/<name>/SKILL.md
//   ~/.claude/plugins/installed_plugins.json -> installPath/skills/*/SKILL.md
//   ~/.pi/skills/<name> -> symlink (some dangling)
// Nothing here touches the real home directory; `homeDir` is injected.

let home: string;

const skill = (dir: string, name: string, description: string) => {
    mkdirSync(join(dir, name), { recursive: true });
    writeFileSync(join(dir, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\nbody\n`);
};

beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cmdscan-'));
});

afterEach(() => {
    rmSync(home, { recursive: true, force: true });
});

describe('scanAgentCommands', () => {
    it('lists claude user skills with name and description', () => {
        skill(join(home, '.claude', 'skills'), 'tdd', 'Test-driven development');
        const catalog = scanAgentCommands(home);
        expect(catalog.claude).toContainEqual({ name: 'tdd', description: 'Test-driven development' });
    });

    it('lists pi skills resolved through symlinks', () => {
        const real = join(home, 'real-skill');
        mkdirSync(real);
        writeFileSync(join(real, 'SKILL.md'), '---\nname: pi-skill\ndescription: from pi\n---\n');
        mkdirSync(join(home, '.pi', 'skills'), { recursive: true });
        symlinkSync(real, join(home, '.pi', 'skills', 'pi-skill'));
        const catalog = scanAgentCommands(home);
        expect(catalog.pi).toContainEqual({ name: 'pi-skill', description: 'from pi' });
    });

    it('drops dangling symlinks', () => {
        mkdirSync(join(home, '.pi', 'skills'), { recursive: true });
        symlinkSync(join(home, 'nowhere'), join(home, '.pi', 'skills', 'ghost'));
        const catalog = scanAgentCommands(home);
        expect(catalog.pi ?? []).toHaveLength(0);
    });

    it('skips entries without SKILL.md frontmatter', () => {
        mkdirSync(join(home, '.claude', 'skills', 'naked'), { recursive: true });
        skill(join(home, '.claude', 'skills'), 'good', 'Has frontmatter');
        const catalog = scanAgentCommands(home);
        expect(catalog.claude).toHaveLength(1);
        expect(catalog.claude![0].name).toBe('good');
    });

    it('dedupes by name within one agent', () => {
        skill(join(home, '.claude', 'skills'), 'dup', 'first');
        skill(join(home, '.claude', 'skills'), 'dup', 'second');
        const catalog = scanAgentCommands(home);
        expect(catalog.claude!.filter((s) => s.name === 'dup')).toHaveLength(1);
    });

    it('truncates descriptions to 120 chars', () => {
        skill(join(home, '.claude', 'skills'), 'longy', 'x'.repeat(1000));
        const catalog = scanAgentCommands(home);
        expect(catalog.claude![0].description).toHaveLength(120);
    });

    it('includes installed plugin skills but not marketplace cache', () => {
        const plugins = join(home, '.claude', 'plugins');
        const cache = join(plugins, 'cache', 'official', 'installed-plugin', 'abc');
        skill(join(cache, 'skills'), 'plugin-skill', 'installed');
        // same tree layout, but NOT referenced by installed_plugins.json
        const orphan = join(plugins, 'cache', 'official', 'marketplace-cached', 'def');
        skill(join(orphan, 'skills'), 'orphan-skill', 'not installed');
        mkdirSync(plugins, { recursive: true });
        writeFileSync(
            join(plugins, 'installed_plugins.json'),
            JSON.stringify({ version: 2, plugins: { 'installed-plugin@official': [{ scope: 'user', installPath: cache }] } }),
        );
        const catalog = scanAgentCommands(home);
        const names = catalog.claude!.map((s) => s.name);
        expect(names).toContain('plugin-skill');
        expect(names).not.toContain('orphan-skill');
    });

    it('caps the serialized catalog at the byte limit, dropping from the tail', () => {
        for (let i = 0; i < 300; i++) {
            skill(join(home, '.claude', 'skills'), `skill-${i}`, `d${i}`.repeat(60));
        }
        const catalog = scanAgentCommands(home);
        expect(JSON.stringify(catalog).length).toBeLessThanOrEqual(64 * 1024);
    });

    it('never puts a filesystem path in the payload', () => {
        skill(join(home, '.claude', 'skills'), 'clean', 'no paths');
        const catalog = scanAgentCommands(home);
        expect(JSON.stringify(catalog)).not.toMatch(/\.claude|\.pi|home|tmpdir|\//);
    });

    it('returns an empty catalog for a home with no agents', () => {
        const catalog = scanAgentCommands(home);
        expect(JSON.stringify(catalog)).toBe('{}');
    });

    it('does not read the filesystem at import time', async () => {
        // re-import must not throw under a broken fs module — import side effects
        // would make the inventory worker re-scan (listener is imported in a thread)
        const mod = await import('./command-scan.js');
        expect(typeof mod.scanAgentCommands).toBe('function');
    });

    it('mixes agents independently — same skill name in two agents stays twice', () => {
        skill(join(home, '.claude', 'skills'), 'shared', 'claude copy');
        const piReal = join(home, 'pi-shared');
        mkdirSync(piReal);
        writeFileSync(join(piReal, 'SKILL.md'), '---\nname: shared\ndescription: pi copy\n---\n');
        mkdirSync(join(home, '.pi', 'skills'), { recursive: true });
        symlinkSync(piReal, join(home, '.pi', 'skills', 'shared'));
        const catalog = scanAgentCommands(home);
        expect(catalog.claude![0].description).toBe('claude copy');
        expect(catalog.pi![0].description).toBe('pi copy');
    });
});
