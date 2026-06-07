import { execSync } from 'child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';
import { createInterface } from 'readline';
import { ZephHook } from './zeph-hook.js';
import { loadConfig, resolvedEnv, saveConfig, CONFIG_FILE, VERSION } from './config.js';
import type { ZephConfig } from './config.js';
import { runLoginFlow, resolveWebUrl, resolveTimeoutSec } from './login.js';
import { detectAgents } from './agents.js';
import type { Agent } from './agents.js';
import {
  CURSOR_HOOKS, CURSOR_RULE,
  WINDSURF_HOOKS, WINDSURF_RULE,
  GEMINI_HOOKS, GEMINI_RULE,
  CODEX_HOOKS, CODEX_RULE,
  COPILOT_HOOKS, COPILOT_RULE,
  CLINE_RULE,
  AIDER_RULE,
  upsertManagedBlock,
} from './templates.js';

const HOME = homedir();

// ── Types ────────────────────────────────────────────────────────

interface InstallArgs {
  key?: string;
  hook?: string;
  'base-url'?: string;
}

// ── Helpers ──────────────────────────────────────────────────────

const ok = (msg: string) => console.log(`    + ${msg}`);
const fail = (msg: string) => console.log(`    - ${msg}`);

/**
 * True when install should auto-open browser login (ADR 0002): interactive
 * context with no existing credential (--key/env/config all absent).
 */
export const shouldTriggerLogin = (nonInteractive: boolean, currentKey: string | undefined): boolean =>
  !nonInteractive && !currentKey;

const promptInput = (question: string): Promise<string> => {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer: string) => {
      rl.close();
      resolve(answer.trim());
    });
  });
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

/**
 * Write a Zeph rule into a SHARED agent rule file (Windsurf global_rules.md,
 * Gemini GEMINI.md, Codex AGENTS.md) without clobbering the user's own
 * content. The rule lands inside <!-- ZEPH:START/END --> markers; a re-run
 * replaces just that block.
 */
const writeManagedRule = (filePath: string, rule: string): void => {
  let existing = '';
  try {
    existing = readFileSync(filePath, 'utf-8');
  } catch { /* new file */ }
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, upsertManagedBlock(existing, rule));
};

/**
 * Add a `read:` entry to ~/.aider.conf.yml so Aider always loads the Zeph
 * conventions file. Idempotent — skips if the path is already referenced.
 * Aider's config is YAML; we do a minimal text-level append to avoid
 * pulling in a YAML dependency (the SDK is zero-dep by design).
 */
const addAiderReadDirective = (confPath: string, conventionsPath: string): void => {
  let conf = '';
  try {
    conf = readFileSync(confPath, 'utf-8');
  } catch { /* new file */ }
  if (conf.includes(conventionsPath)) return; // already wired up
  const marker = '# Added by Zeph';
  const line = `${marker}\nread: ${conventionsPath}\n`;
  const base = conf.replace(/\n*$/, '');
  mkdirSync(dirname(confPath), { recursive: true });
  writeFileSync(confPath, (base ? `${base}\n\n` : '') + line);
};

// ── Per-Agent Installers ─────────────────────────────────────────

const injectMcpJson = (filePath: string): void => {
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
  } catch { /* new file */ }
  if (!data.mcpServers) data.mcpServers = {};
  // Pass through env explicitly so the MCP server doesn't have to rely on
  // process-env inheritance (which behaves differently per IDE — Cursor and
  // Windsurf spawn the MCP from a graphical context that may not inherit
  // shell env). Mirrors plugin/.mcp.json.
  (data.mcpServers as Record<string, unknown>).zeph = {
    command: 'npx',
    args: ['-y', '@zeph-to/mcp-server'],
    env: { ZEPH_API_KEY: '${ZEPH_API_KEY}' },
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
  try {
    // Windsurf reads ~/.codeium/windsurf/memories/global_rules.md as always-on
    // global rules. Managed-block append preserves the user's own rules.
    writeManagedRule(join(HOME, '.codeium', 'windsurf', 'memories', 'global_rules.md'), WINDSURF_RULE);
    ok('Rules added to global_rules.md');
  } catch {
    fail('Rule install failed. Manual: add zeph rules to ~/.codeium/windsurf/memories/global_rules.md');
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
  try {
    // Gemini CLI loads ~/.gemini/GEMINI.md as global context every prompt.
    writeManagedRule(join(HOME, '.gemini', 'GEMINI.md'), GEMINI_RULE);
    ok('Rules added to GEMINI.md');
  } catch {
    fail('Rule install failed. Manual: add zeph rules to ~/.gemini/GEMINI.md');
  }
};

const installCodex = (): void => {
  try {
    writeFile(join(HOME, '.codex', 'hooks.json'), CODEX_HOOKS);
    ok('Stop hook added');
  } catch {
    fail('Hook install failed. Manual: add zeph to ~/.codex/hooks.json');
  }
  try {
    // Codex CLI loads ~/.codex/AGENTS.md as global instructions.
    writeManagedRule(join(HOME, '.codex', 'AGENTS.md'), CODEX_RULE);
    ok('Rules added to AGENTS.md');
  } catch {
    fail('Rule install failed. Manual: add zeph rules to ~/.codex/AGENTS.md');
  }
};

const installCopilot = (): void => {
  try {
    writeFile(join(HOME, '.copilot', 'hooks', 'zeph.json'), COPILOT_HOOKS);
    ok('Session end hook added');
  } catch {
    fail('Hook install failed. Manual: add zeph to ~/.copilot/hooks/');
  }
  try {
    // Copilot CLI loads ~/.copilot/instructions/*.instructions.md globally.
    // A dedicated file means no merge needed — overwrite is safe.
    writeFile(join(HOME, '.copilot', 'instructions', 'zeph.instructions.md'), COPILOT_RULE);
    ok('Rule file added');
  } catch {
    fail('Rule install failed. Manual: add zeph rules to ~/.copilot/instructions/');
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

const installAider = (): void => {
  // Aider has no hooks; rules reach it via a conventions file loaded by the
  // `read:` directive in ~/.aider.conf.yml. We keep the conventions file in
  // ~/.zeph/ (our own dir — no conflict) and just wire the read directive.
  const conventionsPath = join(HOME, '.zeph', 'aider-conventions.md');
  try {
    writeFile(conventionsPath, AIDER_RULE);
    ok('Conventions file added');
  } catch {
    fail('Conventions install failed. Manual: save zeph rules somewhere readable');
    return;
  }
  try {
    addAiderReadDirective(join(HOME, '.aider.conf.yml'), conventionsPath);
    ok('read: directive added to ~/.aider.conf.yml');
  } catch {
    fail(`Config wiring failed. Manual: add "read: ${conventionsPath}" to ~/.aider.conf.yml`);
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
  aider: installAider,
};

// One-line summary of what each agent's installer does — shown in the
// interactive plan before anything is written.
const AGENT_PLAN_LABELS: Record<string, string> = {
  claude: 'Claude Code — install plugin',
  cursor: 'Cursor — MCP + hooks + rules',
  windsurf: 'Windsurf — MCP + hooks + rules',
  gemini: 'Gemini CLI — MCP + hooks + rules',
  codex: 'Codex CLI — hooks + rules',
  copilot: 'Copilot CLI — hooks + rules',
  cline: 'Cline — rules',
  aider: 'Aider — conventions',
};

// ── Agent selection ──────────────────────────────────────────────

/**
 * Interactive agent picker — an @inquirer/prompts checkbox (arrow keys
 * to move, space to toggle, enter to confirm). Every agent starts
 * checked, so a bare Enter installs for all. Returns the chosen Agent[].
 *
 * Dynamic import keeps @inquirer/prompts (ESM) loadable from this
 * CommonJS build, and means the dependency is only touched on the
 * interactive path — `notify` / `list` / scripted `install --only`
 * never load it.
 */
const pickAgentsInteractive = async (detected: Agent[]): Promise<Agent[]> => {
  const { checkbox } = await import('@inquirer/prompts');
  const picked = await checkbox<string>({
    message: 'Install Zeph for which agents? (space to toggle, enter to confirm)',
    choices: detected.map((agent) => ({
      name: AGENT_PLAN_LABELS[agent.id] ?? agent.name,
      value: agent.id,
      checked: true,
    })),
    loop: false,
  });
  return detected.filter((a) => picked.includes(a.id));
};

/**
 * Resolve agents from a non-interactive `--only cursor,gemini` flag.
 * Matches on agent id; unknown ids are silently dropped. Exported for
 * unit testing.
 */
export const filterAgentsByIds = (detected: Agent[], only: string): Agent[] => {
  const ids = new Set(
    only.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
  );
  return detected.filter((a) => ids.has(a.id));
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

// ── Credential Resolution ────────────────────────────────────────

interface ResolvedCredentials {
  apiKey?: string;
  hookId?: string;
  baseUrl?: string;
}

/** Interactive path when a credential already exists: prompt to keep/replace. */
const promptExistingCredentials = async (
  currentKey: string | undefined,
  existing: ZephConfig,
): Promise<ResolvedCredentials> => {
  if (currentKey) console.log(`  Current API Key: ${currentKey.slice(0, 12)}...`);
  const keyInput = await promptInput(
    currentKey ? '  New API Key (Enter to keep): ' : '  API Key (from app > Settings > API Keys): ',
  );

  const currentHook = resolvedEnv('ZEPH_HOOK_ID') || existing.hookId;
  if (currentHook) console.log(`  Current Hook ID: ${currentHook}`);
  const hookInput = await promptInput(
    currentHook ? '  New Hook ID (Enter to keep, "none" to remove): ' : '  Hook ID (optional, for prompt/input): ',
  );

  return {
    apiKey: keyInput || currentKey,
    hookId: hookInput === 'none' ? undefined : (hookInput || currentHook),
    baseUrl: existing.baseUrl,
  };
};

/**
 * Resolve API key + hook for install. Priority: --key/env/config (non-interactive
 * or "keep existing") → brand-new interactive opens browser login (ADR 0002),
 * falling back to manual paste when headless. wsUrl/deviceId from a login are
 * persisted by runLoginFlow and re-read at config-save time.
 */
const collectCredentials = async (
  args: Record<string, string | boolean>,
  installArgs: InstallArgs,
  nonInteractive: boolean,
  existing: ZephConfig,
): Promise<ResolvedCredentials> => {
  if (nonInteractive) {
    return {
      apiKey: installArgs.key || resolvedEnv('ZEPH_API_KEY') || existing.apiKey,
      hookId: installArgs.hook === 'none' ? undefined : (installArgs.hook || resolvedEnv('ZEPH_HOOK_ID') || existing.hookId),
      baseUrl: installArgs['base-url'] || resolvedEnv('ZEPH_BASE_URL') || existing.baseUrl,
    };
  }

  console.log('');
  const currentKey = resolvedEnv('ZEPH_API_KEY') || existing.apiKey;
  if (!shouldTriggerLogin(nonInteractive, currentKey)) {
    return promptExistingCredentials(currentKey, existing);
  }

  const result = await runLoginFlow({
    webUrl: resolveWebUrl(args['web-url']),
    timeoutSec: resolveTimeoutSec(args.timeout),
  });
  if (result) {
    return { apiKey: result.apiKey, hookId: result.hookId, baseUrl: result.baseUrl };
  }

  // headless / timeout → manual paste
  const apiKey = (await promptInput('  API Key (from app > Settings > API Keys): ')) || undefined;
  const hookInput = await promptInput('  Hook ID (optional, for prompt/input): ');
  return { apiKey, hookId: hookInput || undefined, baseUrl: existing.baseUrl };
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

  // 2. Choose which agents to install for — asked up front so the user
  //    sees the choice before being walked through credential prompts.
  let selected: Agent[] = detected;
  const onlyArg = (args.only as string | undefined)?.trim();
  if (detected.length > 0) {
    if (onlyArg) {
      // Non-interactive or scripted: --only cursor,gemini
      selected = filterAgentsByIds(detected, onlyArg);
      console.log(`\n  --only ${onlyArg} → ${selected.map((a) => a.name).join(', ') || '(no match)'}`);
    } else if (nonInteractive) {
      // Scripted run with no --only: keep the all-detected default
      selected = detected;
    } else {
      try {
        selected = await pickAgentsInteractive(detected);
      } catch {
        // Ctrl-C in the picker (or no TTY) — treat as a clean cancel.
        console.log('\n  Cancelled.\n');
        return 0;
      }
    }
  }

  // 3. Collect credentials (browser login auto-triggers for brand-new installs)
  const existing = loadConfig();
  const { apiKey, hookId, baseUrl } = await collectCredentials(args, installArgs, nonInteractive, existing);

  if (!apiKey) {
    console.error('\n  Error: API key is required.\n');
    return 1;
  }

  // 4. Show the resolved plan before touching anything (interactive only).
  if (!nonInteractive) {
    console.log('\n  Will do:');
    console.log(`    - Save config to ${CONFIG_FILE}`);
    for (const agent of selected) {
      console.log(`    - ${AGENT_PLAN_LABELS[agent.id] ?? `Install for ${agent.name}`}`);
    }
    if (selected.length === 0) {
      console.log('    (no agents selected — only the config file will be saved)');
    }
    console.log('    - Test connection');
  }

  // 5. Save config — merge over the latest on-disk config (re-read, since a
  //    login in step 3 may have written wsUrl/deviceId). hookId set or cleared.
  console.log('');
  const config: ZephConfig = {
    ...loadConfig(),
    apiKey,
    ...(baseUrl && { baseUrl }),
  };
  if (hookId) config.hookId = hookId;
  else delete config.hookId;
  saveConfig(config);
  ok(`Config saved to ${CONFIG_FILE}`);

  // 6. Install for the selected agents only
  for (const agent of selected) {
    console.log(`\n  Installing for ${agent.name}...`);
    const installer = AGENT_INSTALLERS[agent.id];
    if (installer) installer();
  }

  // 7. Test connection
  console.log('\n  Testing connection...');
  await testConnection(apiKey, baseUrl);

  console.log('\n  Done! Restart your agents.\n');
  return 0;
};
