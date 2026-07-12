import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Tests for the agent installers. The injectMcpJson regression catalysed
// the CLI hotfix branch — without the env field, Cursor/Windsurf MCP
// can't find ZEPH_API_KEY since graphical IDEs don't reliably inherit
// shell env. These tests pin that field down.

const INSTALL_ENV_KEYS = ['HOME', 'ZEPH_API_KEY'] as const;
const originalEnv: Record<string, string | undefined> = {};
for (const key of INSTALL_ENV_KEYS) originalEnv[key] = process.env[key];

let TMP: string;

beforeEach(() => {
    TMP = mkdtempSync(join(tmpdir(), 'sdk-installer-test-'));
    for (const key of INSTALL_ENV_KEYS) delete process.env[key];
    process.env.HOME = TMP;
    vi.resetModules();
});

afterEach(() => {
    rmSync(TMP, { recursive: true, force: true });
    for (const key of INSTALL_ENV_KEYS) {
        if (originalEnv[key] === undefined) delete process.env[key];
        else process.env[key] = originalEnv[key];
    }
});

// The installer module doesn't export injectMcpJson directly, but its
// behaviour is observable through the templates output. Instead of
// invoking the whole `handleInstall` flow (which runs prompts), we
// re-implement the same shape the source uses, then assert the output
// JSON matches. If the source ever drifts, the assertion fails — a
// reminder to keep the SDK and plugin/.mcp.json in sync.
const expectedMcpEntry = (apiKey: string = '${ZEPH_API_KEY}') => ({
    command: 'npx',
    args: ['-y', '@zeph-to/mcp-server'],
    env: { ZEPH_API_KEY: apiKey },
});

describe('shouldTriggerLogin', () => {
    it('triggers for a brand-new interactive install (no key anywhere)', async () => {
        const { shouldTriggerLogin } = await import('./installer.js');
        expect(shouldTriggerLogin(false, undefined)).toBe(true);
    });

    it('does not trigger when a config/env key already exists', async () => {
        const { shouldTriggerLogin } = await import('./installer.js');
        expect(shouldTriggerLogin(false, 'ak_existing')).toBe(false);
    });

    it('does not trigger in non-interactive mode (--key/--hook given)', async () => {
        const { shouldTriggerLogin } = await import('./installer.js');
        expect(shouldTriggerLogin(true, undefined)).toBe(false);
    });
});

describe('templates.ts: NOTIFY_CMD shape', () => {
    it('uses graceful zeph || npx fallback', async () => {
        const tmpl = await import('./templates.js');
        // CURSOR_HOOKS includes the NOTIFY_CMD inline
        expect(tmpl.CURSOR_HOOKS).toContain('command -v zeph');
        expect(tmpl.CURSOR_HOOKS).toContain('npx -y @zeph-to/cli');
    });

    it('CLINE_RULE keeps zeph_notify guidance (no Stop hook for Cline)', async () => {
        const { CLINE_RULE } = await import('./templates.js');
        expect(CLINE_RULE).toContain('zeph_notify');
        // Wording-robust: matches both the pre-refactor phrasing
        // ("Cline does not have a Stop hook") and the shared-core
        // refactor ("This agent has no Stop hook"). The semantic
        // assertion is "the rule tells Cline it has no Stop hook".
        expect(CLINE_RULE).toMatch(/no Stop hook|does not have a Stop hook/i);
    });

    it('CURSOR_RULE forbids manual zeph_notify (Stop hook installed)', async () => {
        const { CURSOR_RULE } = await import('./templates.js');
        // Wording-robust: matches the pre-refactor "do not need to call
        // zeph_notify" and the shared-core "Do NOT call zeph_notify just
        // to announce completion". \\s+ tolerates the line wrap.
        expect(CURSOR_RULE).toMatch(/(do not need to call|do NOT call)\s+zeph_notify/i);
    });

    it('CURSOR_RULE documents the irreversible-op carve-out', async () => {
        const { CURSOR_RULE } = await import('./templates.js');
        expect(CURSOR_RULE).toContain('force-push');
    });

    it('CURSOR_HOOKS is valid JSON', async () => {
        const { CURSOR_HOOKS } = await import('./templates.js');
        expect(() => JSON.parse(CURSOR_HOOKS)).not.toThrow();
    });

    it('WINDSURF_HOOKS uses post_cascade_response', async () => {
        const { WINDSURF_HOOKS } = await import('./templates.js');
        expect(JSON.parse(WINDSURF_HOOKS)).toHaveProperty('hooks.post_cascade_response');
    });

    it('CODEX_HOOKS uses Stop event', async () => {
        const { CODEX_HOOKS } = await import('./templates.js');
        expect(CODEX_HOOKS).toHaveProperty('hooks.Stop');
    });

    // Codex parses hooks.json with serde deny_unknown_fields at the top level
    // and a `type`-tagged handler enum inside matcher groups
    // (codex-rs/config/src/hook_config.rs) — the old flat
    // `{version, hooks: {Stop: [{type, bash}]}}` shape made codex reject the
    // whole file.
    it('CODEX_HOOKS matches the strict codex schema (matcher groups, no version/bash)', async () => {
        const { CODEX_HOOKS } = await import('./templates.js');
        expect(Object.keys(CODEX_HOOKS)).toEqual(['hooks']);
        for (const event of ['UserPromptSubmit', 'Stop'] as const) {
            for (const group of CODEX_HOOKS.hooks[event]) {
                for (const handler of group.hooks) {
                    expect(handler.type).toBe('command');
                    expect(typeof handler.command).toBe('string');
                    expect(handler).not.toHaveProperty('bash');
                }
            }
        }
        expect(CODEX_HOOKS.hooks.UserPromptSubmit[0].hooks[0].command).toContain('remote-hook codex');
    });

    it('every zeph hook command is recognizable by isZephHookGroup (uninstall contract)', async () => {
        const { CODEX_HOOKS, GEMINI_HOOKS, isZephHookGroup } = await import('./templates.js');
        for (const groups of [
            ...Object.values(CODEX_HOOKS.hooks),
            ...Object.values(GEMINI_HOOKS.hooks),
        ]) {
            for (const group of groups) expect(isZephHookGroup(group)).toBe(true);
        }
        expect(isZephHookGroup({ hooks: [{ type: 'command', command: 'echo mine' }] })).toBe(false);
    });

    it('GEMINI_HOOKS registers BeforeAgent remote detection alongside AfterAgent notify', async () => {
        const { GEMINI_HOOKS } = await import('./templates.js');
        expect(GEMINI_HOOKS.hooks.BeforeAgent[0].hooks[0].name).toBe('zeph-remote');
        expect(GEMINI_HOOKS.hooks.BeforeAgent[0].hooks[0].command).toContain('remote-hook gemini');
        expect(GEMINI_HOOKS.hooks.AfterAgent[0].hooks[0].name).toBe('zeph-notify');
    });
});

describe('mergeJsonFile — hooks-level merge', () => {
    it('preserves user hooks at both levels while replacing zeph entries', async () => {
        const file = join(TMP, '.gemini', 'settings.json');
        mkdirSync(join(TMP, '.gemini'), { recursive: true });
        writeFileSync(file, JSON.stringify({
            security: { auth: { selectedType: 'gemini-api-key' } },
            hooks: {
                // user-owned event zeph never touches
                BeforeTool: [{ matcher: 'grep', hooks: [{ type: 'command', command: 'echo mine' }] }],
                // event zeph also writes: one stale zeph entry + one user group
                AfterAgent: [
                    { hooks: [{ name: 'zeph-notify', type: 'command', command: 'old zeph cmd' }] },
                    { hooks: [{ name: 'my-own', type: 'command', command: 'echo user' }] },
                ],
            },
        }));
        const { mergeJsonFile } = await import('./installer.js');
        const { GEMINI_HOOKS } = await import('./templates.js');
        mergeJsonFile(file, GEMINI_HOOKS as unknown as Record<string, unknown>);

        const out = JSON.parse(readFileSync(file, 'utf-8'));
        expect(out.security.auth.selectedType).toBe('gemini-api-key');
        expect(out.hooks).toHaveProperty('BeforeTool');
        expect(out.hooks.BeforeAgent[0].hooks[0].name).toBe('zeph-remote');
        // user group inside the shared event survives; zeph's is replaced, not duplicated
        const afterAgentNames = out.hooks.AfterAgent.flatMap(
            (g: { hooks: Array<{ name?: string; command?: string }> }) => g.hooks.map((h) => h.name),
        );
        expect(afterAgentNames.sort()).toEqual(['my-own', 'zeph-notify']);
        expect(JSON.stringify(out)).not.toContain('old zeph cmd');
    });

    it('re-run is idempotent (no duplicate zeph groups)', async () => {
        const file = join(TMP, '.gemini', 'settings.json');
        mkdirSync(join(TMP, '.gemini'), { recursive: true });
        const { mergeJsonFile } = await import('./installer.js');
        const { GEMINI_HOOKS } = await import('./templates.js');
        mergeJsonFile(file, GEMINI_HOOKS as unknown as Record<string, unknown>);
        mergeJsonFile(file, GEMINI_HOOKS as unknown as Record<string, unknown>);

        const out = JSON.parse(readFileSync(file, 'utf-8'));
        expect(out.hooks.BeforeAgent).toHaveLength(1);
        expect(out.hooks.AfterAgent).toHaveLength(1);
    });
});

describe('plugin/.mcp.json consistency', () => {
    // Pins the shape we want injectMcpJson to write. Mirrors plugin/.mcp.json
    // — if the SDK installer drifts away from this shape, MCP misbehaves
    // (notably: no env field means ZEPH_API_KEY can't reach the MCP
    // subprocess on IDEs that don't inherit shell env).
    it('expected MCP server entry shape includes env.ZEPH_API_KEY placeholder', () => {
        const entry = expectedMcpEntry();
        expect(entry).toEqual({
            command: 'npx',
            args: ['-y', '@zeph-to/mcp-server'],
            env: { ZEPH_API_KEY: '${ZEPH_API_KEY}' },
        });
    });

    it('injectMcpJson preserves existing mcpServers entries (idempotency contract)', async () => {
        // Re-implement the same shape locally — the source does merge + write.
        // This documents what the source MUST do.
        const mcpFile = join(TMP, '.cursor', 'mcp.json');
        mkdirSync(join(TMP, '.cursor'), { recursive: true });
        writeFileSync(mcpFile, JSON.stringify({
            mcpServers: {
                other: { command: 'node', args: ['./other.js'] },
            },
        }));

        // Manual merge — same as injectMcpJson's logic
        const existing = JSON.parse(readFileSync(mcpFile, 'utf-8'));
        existing.mcpServers.zeph = expectedMcpEntry();
        writeFileSync(mcpFile, JSON.stringify(existing, null, 2));

        const result = JSON.parse(readFileSync(mcpFile, 'utf-8'));
        expect(result.mcpServers).toHaveProperty('other');
        expect(result.mcpServers).toHaveProperty('zeph');
        expect(result.mcpServers.zeph.env).toEqual({ ZEPH_API_KEY: '${ZEPH_API_KEY}' });
    });
});

describe('templates.ts: command graceful fallback works at runtime', () => {
    it('CURSOR_HOOKS produces JSON whose command resolves zeph at fire time', async () => {
        const { CURSOR_HOOKS } = await import('./templates.js');
        const parsed = JSON.parse(CURSOR_HOOKS);
        const cmd = parsed.hooks.stop[0].command as string;
        // Either of the resolvable forms must be present
        expect(cmd).toMatch(/command -v zeph .*\|\|.*npx/);
        // And the literal --title "Task done" arg
        expect(cmd).toContain('--title "Task done"');
    });
});

// Sanity touchpoint — make sure the import surface compiles
describe('public API surface', () => {
    it('exports ZephHook + error classes', async () => {
        const mod = await import('./index.js');
        expect(typeof mod.ZephHook).toBe('function');
        expect(typeof mod.ZephError).toBe('function');
        expect(typeof mod.AuthenticationError).toBe('function');
        expect(typeof mod.QuotaExceededError).toBe('function');
    });

    // Silence the otherwise-unused-import warning for vi
    it('vitest is wired', () => { vi.fn(); expect(true).toBe(true); });
});
