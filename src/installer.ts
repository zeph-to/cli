import { execSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { createInterface } from 'readline';
import { ZephHook } from './zeph-hook.js';
import { loadConfig, saveConfig, CONFIG_FILE, VERSION } from './config.js';
import type { ZephConfig } from './config.js';

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

// ── Agent Detection ──────────────────────────────────────────────

const detectAgents = (): Agent[] => [
  { name: 'Claude Code', id: 'claude', detected: hasCommand('claude') },
  { name: 'Cursor', id: 'cursor', detected: existsSync(join(HOME, '.cursor')) },
  { name: 'Windsurf', id: 'windsurf', detected: existsSync(join(HOME, '.codeium')) },
  { name: 'Gemini CLI', id: 'gemini', detected: hasCommand('gemini') },
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
    ok('MCP server added to ~/.cursor/mcp.json');
  } catch {
    fail('MCP injection failed. Manual: add zeph to ~/.cursor/mcp.json');
  }
};

const installWindsurf = (): void => {
  try {
    injectMcpJson(join(HOME, '.codeium', 'windsurf', 'mcp_config.json'));
    ok('MCP server added to ~/.codeium/windsurf/mcp_config.json');
  } catch {
    fail('MCP injection failed. Manual: add zeph to windsurf mcp_config.json');
  }
};

const installGemini = (): void => {
  try {
    execSync('gemini mcp add zeph -- npx -y @zeph-to/mcp-server', { stdio: 'pipe' });
    ok('MCP server added');
  } catch {
    fail('MCP add failed. Manual: gemini mcp add zeph -- npx -y @zeph-to/mcp-server');
  }
};

const AGENT_INSTALLERS: Record<string, () => void> = {
  claude: installClaude,
  cursor: installCursor,
  windsurf: installWindsurf,
  gemini: installGemini,
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
    apiKey = installArgs.key || process.env.ZEPH_API_KEY || existing.apiKey;
    hookId = installArgs.hook === 'none' ? undefined : (installArgs.hook || process.env.ZEPH_HOOK_ID || existing.hookId);
    baseUrl = installArgs['base-url'] || process.env.ZEPH_BASE_URL || existing.baseUrl;
  } else {
    console.log('');
    const currentKey = process.env.ZEPH_API_KEY || existing.apiKey;
    if (currentKey) {
      console.log(`  Current API Key: ${currentKey.slice(0, 12)}...`);
    }
    const keyInput = await promptInput(
      currentKey ? '  New API Key (Enter to keep): ' : '  API Key (from app > Settings > API Keys): ',
    );
    apiKey = keyInput || currentKey;

    const currentHook = process.env.ZEPH_HOOK_ID || existing.hookId;
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
        cursor: 'Add MCP server to ~/.cursor/mcp.json',
        windsurf: 'Add MCP server to windsurf mcp_config.json',
        gemini: 'Add MCP server to Gemini CLI',
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
