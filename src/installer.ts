import { execSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { createInterface } from 'readline';
import { ZephHook } from './zeph-hook.js';
import { loadConfig, resolvedEnv, saveConfig, CONFIG_FILE, VERSION } from './config.js';
import type { ZephConfig } from './config.js';
import {
  CURSOR_HOOKS, CURSOR_RULE,
  WINDSURF_HOOKS,
  GEMINI_HOOKS,
  CODEX_HOOKS,
  COPILOT_HOOKS,
  CLINE_RULE,
} from './templates.js';

const HOME = process.env.HOME ?? '~';

// ── Types ────────────────────────────────────────────────────────

interface Agent {
  name: string;
  id: string;
  detected: boolean;
}

interface InstallArgs {
  key?: string;
  hook?: string;
  'base-url'?: string;
}

// ── Helpers ──────────────────────────────────────────────────────

const ok = (msg: string) => console.log(`    + ${msg}`);
const fail = (msg: string) => console.log(`    - ${msg}`);

const promptInput = (question: string): Promise<string> => {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer: string) => {
      rl.close();
      resolve(answer.trim());
    });
  });
};

const hasCommand = (cmd: string): boolean => {
  try {
    execSync(`which ${cmd}`, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
};

const writeFile = (filePath: string, content: string): void => {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content + '\n');
};

const mergeJsonFile = (filePath: string, patch: Record<string, unknown>): void => {
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
  } catch { /* new file */ }
  const merged = { ...data, ...patch };
  writeFile(filePath, JSON.stringify(merged, null, 2));
};

// ── Agent Detection ──────────────────────────────────────────────

const detectAgents = (): Agent[] => [
  { name: 'Claude Code', id: 'claude', detected: hasCommand('claude') },
  { name: 'Cursor', id: 'cursor', detected: existsSync(join(HOME, '.cursor')) },
  { name: 'Windsurf', id: 'windsurf', detected: existsSync(join(HOME, '.codeium')) },
  { name: 'Gemini CLI', id: 'gemini', detected: hasCommand('gemini') },
  { name: 'Codex CLI', id: 'codex', detected: hasCommand('codex') },
  { name: 'Copilot CLI', id: 'copilot', detected: existsSync(join(HOME, '.copilot')) },
  { name: 'Cline', id: 'cline', detected: existsSync(join(HOME, '.cline')) },
];

// ── Per-Agent Installers ─────────────────────────────────────────

const injectMcpJson = (filePath: string): void => {
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
  } catch { /* new file */ }
  if (!data.mcpServers) data.mcpServers = {};
  (data.mcpServers as Record<string, unknown>).zeph = {
    command: 'npx',
    args: ['-y', '@zeph-to/mcp-server'],
  };
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
};

const installClaude = (): void => {
  try {
    execSync('claude plugin marketplace add zeph-to/plugin', { stdio: 'pipe' });
    execSync('claude plugin install zeph@zeph', { stdio: 'pipe' });
    ok('Plugin installed');
  } catch {
    fail('Plugin install failed. Manual:');
    console.log('      claude plugin marketplace add zeph-to/plugin');
    console.log('      claude plugin install zeph@zeph');
  }
};

const installCursor = (): void => {
  try {
    injectMcpJson(join(HOME, '.cursor', 'mcp.json'));
    ok('MCP server added');
  } catch {
    fail('MCP injection failed. Manual: add zeph to ~/.cursor/mcp.json');
  }
  try {
    writeFile(join(HOME, '.cursor', 'hooks.json'), CURSOR_HOOKS);
    ok('Stop hook added');
  } catch {
    fail('Hook install failed');
  }
  try {
    writeFile(join(HOME, '.cursor', 'rules', 'zeph.mdc'), CURSOR_RULE);
    ok('Rule file added');
  } catch {
    fail('Rule install failed');
  }
};

const installWindsurf = (): void => {
  try {
    injectMcpJson(join(HOME, '.codeium', 'windsurf', 'mcp_config.json'));
    ok('MCP server added');
  } catch {
    fail('MCP injection failed. Manual: add zeph to windsurf mcp_config.json');
  }
  try {
    writeFile(join(HOME, '.codeium', 'windsurf', 'hooks.json'), WINDSURF_HOOKS);
    ok('Response hook added');
  } catch {
    fail('Hook install failed');
  }
};

const installGemini = (): void => {
  try {
    execSync('gemini mcp add zeph -- npx -y @zeph-to/mcp-server', { stdio: 'pipe' });
    ok('MCP server added');
  } catch {
    fail('MCP add failed. Manual: gemini mcp add zeph -- npx -y @zeph-to/mcp-server');
  }
  try {
    mergeJsonFile(join(HOME, '.gemini', 'settings.json'), GEMINI_HOOKS);
    ok('AfterAgent hook added');
  } catch {
    fail('Hook install failed');
  }
};

const installCodex = (): void => {
  try {
    writeFile(join(HOME, '.codex', 'hooks.json'), CODEX_HOOKS);
    ok('Stop hook added');
  } catch {
    fail('Hook install failed. Manual: add zeph to ~/.codex/hooks.json');
  }
};

const installCopilot = (): void => {
  try {
    writeFile(join(HOME, '.copilot', 'hooks', 'zeph.json'), COPILOT_HOOKS);
    ok('Session end hook added');
  } catch {
    fail('Hook install failed. Manual: add zeph to ~/.copilot/hooks/');
  }
};

const installCline = (): void => {
  try {
    writeFile(join(HOME, '.cline', 'rules', 'zeph.md'), CLINE_RULE);
    ok('Rule file added');
  } catch {
    fail('Rule install failed. Manual: add zeph to ~/.cline/rules/');
  }
};

const AGENT_INSTALLERS: Record<string, () => void> = {
  claude: installClaude,
  cursor: installCursor,
  windsurf: installWindsurf,
  gemini: installGemini,
  codex: installCodex,
  copilot: installCopilot,
  cline: installCline,
};

// ── Test Connection ──────────────────────────────────────────────

const testConnection = async (apiKey: string, baseUrl?: string): Promise<boolean> => {
  try {
    const hook = new ZephHook({ apiKey, ...(baseUrl && { baseUrl }) });
    const result = await hook.notify({
      title: 'Zeph Setup',
      body: `Connected successfully (v${VERSION})`,
    });
    ok(`Test push sent: ${result.pushId}`);
    return true;
  } catch (err) {
    fail(`Test failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
    return false;
  }
};

// ── Main Install Flow ────────────────────────────────────────────

export const handleInstall = async (args: Record<string, string | boolean>): Promise<number> => {
  const installArgs: InstallArgs = {
    key: args.key as string | undefined,
    hook: args.hook as string | undefined,
    'base-url': args['base-url'] as string | undefined,
  };
  const nonInteractive = !!(installArgs.key || installArgs.hook || installArgs['base-url']);

  console.log(`\n  Zeph v${VERSION}\n`);

  // 1. Detect agents
  console.log('  Detecting agents...');
  const agents = detectAgents();
  const detected = agents.filter((a) => a.detected);

  for (const agent of agents) {
    if (agent.detected) {
      ok(agent.name);
    } else {
      fail(`${agent.name} (not found)`);
    }
  }

  if (detected.length === 0) {
    console.log('\n  No supported agents found. Config will still be saved.\n');
  }

  // 2. Collect credentials
  const existing = loadConfig();
  let apiKey: string | undefined;
  let hookId: string | undefined;
  let baseUrl: string | undefined;

  if (nonInteractive) {
    apiKey = installArgs.key || resolvedEnv('ZEPH_API_KEY') || existing.apiKey;
    hookId = installArgs.hook === 'none' ? undefined : (installArgs.hook || resolvedEnv('ZEPH_HOOK_ID') || existing.hookId);
    baseUrl = installArgs['base-url'] || resolvedEnv('ZEPH_BASE_URL') || existing.baseUrl;
  } else {
    console.log('');
    const currentKey = resolvedEnv('ZEPH_API_KEY') || existing.apiKey;
    if (currentKey) {
      console.log(`  Current API Key: ${currentKey.slice(0, 12)}...`);
    }
    const keyInput = await promptInput(
      currentKey ? '  New API Key (Enter to keep): ' : '  API Key (from app > Settings > API Keys): ',
    );
    apiKey = keyInput || currentKey;

    const currentHook = resolvedEnv('ZEPH_HOOK_ID') || existing.hookId;
    if (currentHook) {
      console.log(`  Current Hook ID: ${currentHook}`);
    }
    const hookInput = await promptInput(
      currentHook ? '  New Hook ID (Enter to keep, "none" to remove): ' : '  Hook ID (optional, for prompt/input): ',
    );
    hookId = hookInput === 'none' ? undefined : (hookInput || currentHook);

    baseUrl = existing.baseUrl;
  }

  if (!apiKey) {
    console.error('\n  Error: API key is required.\n');
    return 1;
  }

  // 3. Confirmation (interactive only)
  if (!nonInteractive) {
    console.log('\n  Will do:');
    console.log('    1. Save config to ~/.zeph/config.json');
    let step = 2;
    for (const agent of detected) {
      const labels: Record<string, string> = {
        claude: 'Install Claude Code plugin',
        cursor: 'Setup Cursor (MCP + hooks + rules)',
        windsurf: 'Setup Windsurf (MCP + hooks)',
        gemini: 'Setup Gemini CLI (MCP + hooks)',
        codex: 'Setup Codex CLI (hooks)',
        copilot: 'Setup Copilot CLI (hooks)',
        cline: 'Setup Cline (rules)',
      };
      console.log(`    ${step}. ${labels[agent.id] ?? `Install for ${agent.name}`}`);
      step++;
    }
    console.log(`    ${step}. Test connection`);

    const confirm = await promptInput('  Continue? [Y/n] ');
    if (confirm.toLowerCase() === 'n') {
      console.log('\n  Cancelled.\n');
      return 0;
    }
  }

  // 4. Save config
  console.log('');
  const config: ZephConfig = {
    apiKey,
    ...(hookId && { hookId }),
    ...(baseUrl && { baseUrl }),
  };
  saveConfig(config);
  ok(`Config saved to ${CONFIG_FILE}`);

  // 5. Install per-agent
  for (const agent of detected) {
    console.log(`\n  Installing for ${agent.name}...`);
    const installer = AGENT_INSTALLERS[agent.id];
    if (installer) installer();
  }

  // 6. Test connection
  console.log('\n  Testing connection...');
  await testConnection(apiKey, baseUrl);

  console.log('\n  Done! Restart your agents.\n');
  return 0;
};
