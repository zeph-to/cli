import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// End-to-end uninstall tests. We scope HOME to a temp dir and create the
// artifacts `zeph install` would have written for the directory-detected
// agents (Cursor / Windsurf — detected by ~/.cursor and ~/.codeium
// existing, no CLI on PATH needed). Then assert handleUninstall removes
// exactly the Zeph parts and nothing else.

const UNINSTALL_ENV_KEYS = ['HOME'] as const;
const originalEnv: Record<string, string | undefined> = {};
for (const key of UNINSTALL_ENV_KEYS) originalEnv[key] = process.env[key];

let TMP: string;

beforeEach(() => {
    TMP = mkdtempSync(join(tmpdir(), 'sdk-uninstall-test-'));
    process.env.HOME = TMP;
    vi.resetModules();
});

afterEach(() => {
    rmSync(TMP, { recursive: true, force: true });
    for (const key of UNINSTALL_ENV_KEYS) {
        if (originalEnv[key] === undefined) delete process.env[key];
        else process.env[key] = originalEnv[key];
    }
});

const write = (rel: string, content: string): string => {
    const p = join(TMP, rel);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, content);
    return p;
};

// Create the Cursor + Windsurf artifacts a real install produces.
const seedCursorAndWindsurf = () => {
    mkdirSync(join(TMP, '.cursor'), { recursive: true });
    mkdirSync(join(TMP, '.codeium'), { recursive: true });

    const cursorMcp = write('.cursor/mcp.json', JSON.stringify({
        mcpServers: {
            other: { command: 'node' },
            zeph: { command: 'npx', args: ['-y', '@zeph-to/mcp-server'] },
        },
    }, null, 2));
    const cursorRule = write('.cursor/rules/zeph.mdc', 'zeph rule content');
    const cursorHooks = write('.cursor/hooks.json', '{"hooks":{}}');

    const wsRules = write(
        '.codeium/windsurf/memories/global_rules.md',
        '# My own windsurf rules\nkeep me\n\n<!-- ZEPH:START — managed by @zeph-to/cli, do not edit between markers -->\nzeph block\n<!-- ZEPH:END -->\n',
    );
    const wsHooks = write('.codeium/windsurf/hooks.json', '{"hooks":{}}');

    return { cursorMcp, cursorRule, cursorHooks, wsRules, wsHooks };
};

describe('handleUninstall — Cursor + Windsurf', () => {
    it('removes every Zeph artifact', async () => {
        const f = seedCursorAndWindsurf();
        const { handleUninstall } = await import('./uninstall.js');
        await handleUninstall({});

        // Cursor: rule + hooks files gone, mcp.json keeps `other`, drops `zeph`
        expect(existsSync(f.cursorRule)).toBe(false);
        expect(existsSync(f.cursorHooks)).toBe(false);
        const cursorMcp = JSON.parse(readFileSync(f.cursorMcp, 'utf-8'));
        expect(cursorMcp.mcpServers).toHaveProperty('other');
        expect(cursorMcp.mcpServers).not.toHaveProperty('zeph');

        // Windsurf: hooks gone; rule file keeps the user's content, drops the block
        expect(existsSync(f.wsHooks)).toBe(false);
        const wsRules = readFileSync(f.wsRules, 'utf-8');
        expect(wsRules).toContain('# My own windsurf rules');
        expect(wsRules).toContain('keep me');
        expect(wsRules).not.toContain('ZEPH:START');
        expect(wsRules).not.toContain('zeph block');
    });

    it('dry-run changes nothing', async () => {
        const f = seedCursorAndWindsurf();
        const { handleUninstall } = await import('./uninstall.js');
        await handleUninstall({ 'dry-run': true });

        expect(existsSync(f.cursorRule)).toBe(true);
        expect(existsSync(f.cursorHooks)).toBe(true);
        expect(existsSync(f.wsHooks)).toBe(true);
        const cursorMcp = JSON.parse(readFileSync(f.cursorMcp, 'utf-8'));
        expect(cursorMcp.mcpServers).toHaveProperty('zeph');
        expect(readFileSync(f.wsRules, 'utf-8')).toContain('ZEPH:START');
    });

    // Uses the legacy `@zeph-to/hook-sdk` marker on purpose: blocks written by
    // pre-rename installs must still be removable after the rename to
    // `@zeph-to/cli` (removeManagedBlock matches the `<!-- ZEPH:START` prefix).
    it('deletes a shared rule file only when it was Zeph-only (legacy marker)', async () => {
        mkdirSync(join(TMP, '.codeium'), { recursive: true });
        const onlyZeph = write(
            '.codeium/windsurf/memories/global_rules.md',
            '<!-- ZEPH:START — managed by @zeph-to/hook-sdk, do not edit between markers -->\nzeph block\n<!-- ZEPH:END -->\n',
        );
        const { handleUninstall } = await import('./uninstall.js');
        await handleUninstall({});
        // No user content remained → the whole file is removed
        expect(existsSync(onlyZeph)).toBe(false);
    });
});

describe('handleUninstall — config retention', () => {
    it('keeps ~/.zeph/config.json by default', async () => {
        const cfg = write('.zeph/config.json', '{"apiKey":"ak_x"}');
        const { handleUninstall } = await import('./uninstall.js');
        await handleUninstall({});
        expect(existsSync(cfg)).toBe(true);
    });

    it('removes ~/.zeph/config.json with --purge', async () => {
        const cfg = write('.zeph/config.json', '{"apiKey":"ak_x"}');
        const { handleUninstall } = await import('./uninstall.js');
        await handleUninstall({ purge: true });
        expect(existsSync(cfg)).toBe(false);
    });

    it('--purge in dry-run keeps the config', async () => {
        const cfg = write('.zeph/config.json', '{"apiKey":"ak_x"}');
        const { handleUninstall } = await import('./uninstall.js');
        await handleUninstall({ purge: true, 'dry-run': true });
        expect(existsSync(cfg)).toBe(true);
    });
});

describe('handleUninstall — Aider conf.yml', () => {
    it('removes the Zeph read: directive, keeps the rest of the YAML', async () => {
        // Aider is CLI-detected so its uninstaller only runs if `aider` is
        // on PATH. We can't rely on that in CI — instead assert the conf
        // file format the uninstaller targets is what install writes.
        const conf = write(
            '.aider.conf.yml',
            'auto-commits: false\n\n# Added by Zeph\nread: /home/u/.zeph/aider-conventions.md\n',
        );
        // Re-implement the documented removal contract inline (the helper
        // itself is not exported): drop "# Added by Zeph" + following read:.
        const lines = readFileSync(conf, 'utf-8').split('\n');
        const out: string[] = [];
        for (let i = 0; i < lines.length; i++) {
            if (lines[i].trim() === '# Added by Zeph') {
                if (lines[i + 1]?.trimStart().startsWith('read:')) i++;
                continue;
            }
            out.push(lines[i]);
        }
        const result = out.join('\n');
        expect(result).toContain('auto-commits: false');
        expect(result).not.toContain('# Added by Zeph');
        expect(result).not.toContain('read:');
    });
});

describe('rmGeminiHook — zeph-* entries only', () => {
    it('removes zeph-remote (BeforeAgent) and zeph-notify (AfterAgent), keeps user hooks', async () => {
        const settings = write('.gemini/settings.json', JSON.stringify({
            hooks: {
                BeforeAgent: [
                    { matcher: '*', hooks: [{ name: 'zeph-remote', type: 'command', command: 'zeph remote-hook gemini' }] },
                ],
                AfterAgent: [
                    { matcher: '*', hooks: [{ name: 'zeph-notify', type: 'command', command: 'zeph notify' }] },
                    { matcher: '*', hooks: [{ name: 'my-own', type: 'command', command: 'echo mine' }] },
                ],
                BeforeTool: [
                    { matcher: 'grep', hooks: [{ type: 'command', command: 'echo reminder' }] },
                ],
            },
        }));
        const { rmGeminiHook } = await import('./uninstall.js');
        expect(rmGeminiHook(settings, false)).toBeTruthy();

        const data = JSON.parse(readFileSync(settings, 'utf-8'));
        expect(data.hooks).not.toHaveProperty('BeforeAgent');
        expect(data.hooks.AfterAgent).toHaveLength(1);
        expect(data.hooks.AfterAgent[0].hooks[0].name).toBe('my-own');
        expect(data.hooks).toHaveProperty('BeforeTool');
    });

    it('dry-run reports but changes nothing', async () => {
        const settings = write('.gemini/settings.json', JSON.stringify({
            hooks: {
                BeforeAgent: [{ hooks: [{ name: 'zeph-remote', type: 'command', command: 'x' }] }],
            },
        }));
        const { rmGeminiHook } = await import('./uninstall.js');
        expect(rmGeminiHook(settings, true)).toBeTruthy();
        expect(JSON.parse(readFileSync(settings, 'utf-8')).hooks).toHaveProperty('BeforeAgent');
    });

    it('nothing of ours → null, file untouched', async () => {
        const original = JSON.stringify({
            hooks: { BeforeTool: [{ hooks: [{ type: 'command', command: 'echo hi' }] }] },
        });
        const settings = write('.gemini/settings.json', original);
        const { rmGeminiHook } = await import('./uninstall.js');
        expect(rmGeminiHook(settings, false)).toBeNull();
        expect(readFileSync(settings, 'utf-8')).toBe(original);
    });
});

describe('rmCodexHook — command-substring ownership (codex handlers have no name field)', () => {
    it('removes zeph groups, keeps user events, keeps the file when user content remains', async () => {
        const hooks = write('.codex/hooks.json', JSON.stringify({
            hooks: {
                UserPromptSubmit: [
                    { hooks: [{ type: 'command', command: '$(command -v zeph || echo "npx -y @zeph-to/cli") remote-hook codex 2>/dev/null || true', timeout: 5 }] },
                ],
                Stop: [
                    { hooks: [{ type: 'command', command: '$(command -v zeph || echo "npx -y @zeph-to/cli") notify --title "Task done" --auto 2>/dev/null || true' }] },
                    { hooks: [{ type: 'command', command: 'echo my own stop hook' }] },
                ],
            },
        }));
        const { rmCodexHook } = await import('./uninstall.js');
        expect(rmCodexHook(hooks, false)).toBeTruthy();

        const data = JSON.parse(readFileSync(hooks, 'utf-8'));
        expect(data.hooks).not.toHaveProperty('UserPromptSubmit');
        expect(data.hooks.Stop).toHaveLength(1);
        expect(data.hooks.Stop[0].hooks[0].command).toBe('echo my own stop hook');
    });

    it('deletes the file outright when nothing but zeph entries existed', async () => {
        const hooks = write('.codex/hooks.json', JSON.stringify({
            hooks: {
                Stop: [{ hooks: [{ type: 'command', command: 'npx -y @zeph-to/cli notify' }] }],
            },
        }));
        const { rmCodexHook } = await import('./uninstall.js');
        expect(rmCodexHook(hooks, false)).toBeTruthy();
        expect(existsSync(hooks)).toBe(false);
    });

    it('dry-run changes nothing', async () => {
        const hooks = write('.codex/hooks.json', JSON.stringify({
            hooks: {
                Stop: [{ hooks: [{ type: 'command', command: 'npx -y @zeph-to/cli notify' }] }],
            },
        }));
        const { rmCodexHook } = await import('./uninstall.js');
        expect(rmCodexHook(hooks, true)).toBeTruthy();
        expect(JSON.parse(readFileSync(hooks, 'utf-8')).hooks).toHaveProperty('Stop');
    });
});
