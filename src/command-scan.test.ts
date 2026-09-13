import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PAYLOAD_LIMIT_BYTES, scanAgentCommands } from './command-scan.js';

// Fixture tree mirrors the real skill layouts measured 2026-09-12:
//   ~/.claude/skills/<name>/SKILL.md
//   ~/.claude/plugins/installed_plugins.json -> installPath/skills/*/SKILL.md
//   ~/.agents/skills/<name> -> symlink (some dangling)
// Nothing here touches the real home directory; `homeDir` is injected.
//
// The catalog carries names only, and a skill's name is its directory name, so
// SKILL.md content is never parsed — these fixtures write a body to prove the
// scanner ignores it.

let home: string;

const skill = (dir: string, name: string, body = 'anything at all') => {
    mkdirSync(join(dir, name), { recursive: true });
    writeFileSync(join(dir, name, 'SKILL.md'), body);
};

const names = (entries: Array<{ name: string }> | undefined) => (entries ?? []).map((e) => e.name);

beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cmdscan-'));
});

afterEach(() => {
    rmSync(home, { recursive: true, force: true });
});

describe('scanAgentCommands', () => {
    it('lists claude user skills by directory name', () => {
        skill(join(home, '.claude', 'skills'), 'tdd');
        expect(names(scanAgentCommands(home).catalog.claude)).toEqual(['tdd']);
    });

    it('ignores SKILL.md content entirely — quotes and folded scalars cannot leak', () => {
        // The regex parser this replaced shipped the quotes and truncated the
        // folded scalar to a bare '>'. Both live layouts are written here.
        skill(join(home, '.claude', 'skills'), 'quoted', '---\nname: "wrong"\ndescription: "has \\"quotes\\""\n---\n');
        skill(join(home, '.claude', 'skills'), 'folded', '---\nname: wrong\ndescription: >\n  folded text\n---\n');
        const serialized = JSON.stringify(scanAgentCommands(home).catalog);
        expect(names(scanAgentCommands(home).catalog.claude).sort()).toEqual(['folded', 'quoted']);
        expect(serialized).not.toContain('wrong');
        expect(serialized).not.toContain('>');
        expect(serialized).not.toContain('description');
    });

    it('lists pi skills resolved through symlinks', () => {
        const real = join(home, 'real-skill');
        mkdirSync(real);
        writeFileSync(join(real, 'SKILL.md'), 'body');
        mkdirSync(join(home, '.agents', 'skills'), { recursive: true });
        symlinkSync(real, join(home, '.agents', 'skills', 'pi-skill'));
        expect(names(scanAgentCommands(home).catalog.pi)).toEqual(['pi-skill']);
    });

    it('drops dangling symlinks', () => {
        mkdirSync(join(home, '.agents', 'skills'), { recursive: true });
        symlinkSync(join(home, 'nowhere'), join(home, '.agents', 'skills', 'ghost'));
        expect(names(scanAgentCommands(home).catalog.pi)).toEqual([]);
    });

    it('scans both of pi global skill dirs, not its project dir', () => {
        // pi 0.85.1 `docs/skills.md § Locations`: global = `~/.pi/agent/skills`
        // + `~/.agents/skills`; `.pi/skills` is the PROJECT dir, and scanning it
        // as if it were global reported pi as having no skills on this machine.
        skill(join(home, '.pi', 'agent', 'skills'), 'from-pi-agent');
        skill(join(home, '.agents', 'skills'), 'from-agents');
        skill(join(home, '.pi', 'skills'), 'project-only');
        const found = names(scanAgentCommands(home).catalog.pi).sort();
        expect(found).toEqual(['from-agents', 'from-pi-agent']);
    });

    it('skips directories with no SKILL.md', () => {
        mkdirSync(join(home, '.claude', 'skills', 'naked'), { recursive: true });
        skill(join(home, '.claude', 'skills'), 'good');
        expect(names(scanAgentCommands(home).catalog.claude)).toEqual(['good']);
    });

    it('dedupes a name that a user skill and an installed plugin both provide', () => {
        // Two distinct directories, one shared name — the case the previous test
        // could not reach, because it wrote both fixtures to the same path.
        skill(join(home, '.claude', 'skills'), 'ship');
        const plugins = join(home, '.claude', 'plugins');
        const install = join(plugins, 'cache', 'official', 'shipper', 'abc');
        skill(join(install, 'skills'), 'ship');
        mkdirSync(plugins, { recursive: true });
        writeFileSync(
            join(plugins, 'installed_plugins.json'),
            JSON.stringify({ version: 2, plugins: { 'shipper@official': [{ scope: 'user', installPath: install }] } }),
        );
        expect(names(scanAgentCommands(home).catalog.claude)).toEqual(['ship']);
    });

    it('includes installed plugin skills but not marketplace cache', () => {
        const plugins = join(home, '.claude', 'plugins');
        const cache = join(plugins, 'cache', 'official', 'installed-plugin', 'abc');
        skill(join(cache, 'skills'), 'plugin-skill');
        // same tree layout, but NOT referenced by installed_plugins.json
        const orphan = join(plugins, 'cache', 'official', 'marketplace-cached', 'def');
        skill(join(orphan, 'skills'), 'orphan-skill');
        mkdirSync(plugins, { recursive: true });
        writeFileSync(
            join(plugins, 'installed_plugins.json'),
            JSON.stringify({ version: 2, plugins: { 'installed-plugin@official': [{ scope: 'user', installPath: cache }] } }),
        );
        const found = names(scanAgentCommands(home).catalog.claude);
        expect(found).toContain('plugin-skill');
        expect(found).not.toContain('orphan-skill');
    });

    it('caps the serialized catalog at the byte limit, dropping from the tail', () => {
        // Sized to actually cross the limit: an entry serializes to ~22 bytes,
        // so the fixture must exceed ~3000 skills or the cap never engages and
        // the assertion passes with the drop loop deleted.
        const dir = join(home, '.claude', 'skills');
        for (let i = 0; i < 3600; i++) skill(dir, `skill-${String(i).padStart(4, '0')}`);
        const before = scanAgentCommands(home);
        expect(before.dropped).toBeGreaterThan(0);
        expect(Buffer.byteLength(JSON.stringify(before.catalog), 'utf-8')).toBeLessThanOrEqual(PAYLOAD_LIMIT_BYTES);
        expect(names(before.catalog.claude)).toContain('skill-0000');
        expect(names(before.catalog.claude)).not.toContain('skill-3599');
    });

    it('reports nothing dropped when the catalog fits', () => {
        skill(join(home, '.claude', 'skills'), 'small');
        expect(scanAgentCommands(home).dropped).toBe(0);
    });

    it('never puts a filesystem path in the payload', () => {
        skill(join(home, '.claude', 'skills'), 'clean');
        const serialized = JSON.stringify(scanAgentCommands(home).catalog);
        expect(serialized).not.toContain(home);
        expect(serialized).not.toContain('.claude');
        expect(serialized).not.toContain(tmpdir());
    });

    it('returns an empty catalog for a home with no agents', () => {
        const result = scanAgentCommands(home);
        expect(JSON.stringify(result.catalog)).toBe('{}');
        expect(result.dropped).toBe(0);
    });

    it('mixes agents independently — the same name in two agents stays in both', () => {
        skill(join(home, '.claude', 'skills'), 'shared');
        const piReal = join(home, 'pi-shared');
        mkdirSync(piReal);
        writeFileSync(join(piReal, 'SKILL.md'), 'body');
        mkdirSync(join(home, '.agents', 'skills'), { recursive: true });
        symlinkSync(piReal, join(home, '.agents', 'skills', 'shared'));
        const { catalog } = scanAgentCommands(home);
        expect(names(catalog.claude)).toEqual(['shared']);
        expect(names(catalog.pi)).toEqual(['shared']);
    });
});

describe('import side effects', () => {
    // The listener imports this module, and the inventory worker loads the
    // listener in a second thread — a filesystem read at module scope would run
    // the scan twice. Make every fs call throw, then import: the module must
    // still load, which it can only do by touching nothing on the way in.
    it('does not read the filesystem at import time', async () => {
        vi.resetModules();
        const explode = () => {
            throw new Error('fs touched at import time');
        };
        vi.doMock('fs', () => ({
            readdirSync: explode,
            statSync: explode,
            readFileSync: explode,
            mkdirSync: explode,
            writeFileSync: explode,
        }));
        const mod = await import('./command-scan.js');
        expect(typeof mod.scanAgentCommands).toBe('function');
        vi.doUnmock('fs');
        vi.resetModules();
    });
});
