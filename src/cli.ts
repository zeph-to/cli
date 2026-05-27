#!/usr/bin/env node

import { existsSync } from 'fs';
import { execFileSync } from 'child_process';
import { ZephHook } from './zeph-hook.js';
import { AuthenticationError, QuotaExceededError, ZephError } from './errors.js';
import { handleInstall } from './installer.js';
import { handleUninstall } from './uninstall.js';
import { handleVerify } from './verify.js';
import { handleCheckUpdate } from './check-update.js';
import { handleAgentSession } from './wrapper.js';
import { handleListener } from './listener.js';
import { loadConfig, resolvedEnv, VERSION } from './config.js';

const PROJECT_DIR_VARS = ['CLAUDE_PROJECT_DIR', 'CURSOR_PROJECT_DIR', 'WINDSURF_PROJECT_DIR'] as const;

const detectProjectDir = (): string =>
  PROJECT_DIR_VARS.reduce<string | undefined>((found, key) => found || process.env[key], undefined) ?? process.cwd();

const isMuted = (): boolean => {
  try {
    const dir = detectProjectDir();
    const raw = execFileSync('cksum', { input: dir, encoding: 'utf-8' });
    const hash = raw.split(' ')[0];
    return existsSync(`/tmp/zeph-muted-${hash}`);
  } catch {
    return false;
  }
};

const detectBranchAndProject = (): { branch?: string; project: string } => {
  const dir = detectProjectDir();
  const project = dir.split('/').filter(Boolean).pop() ?? 'project';
  let branch: string | undefined;
  try {
    branch = execFileSync('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    if (!branch || branch === 'HEAD') branch = undefined;
  } catch { /* not a git repo */ }
  return { branch, project };
};

// ── Arg Parser ──────────────────────────────────────────────────

const parseArgs = (argv: string[]): Record<string, string | boolean> => {
  const result: Record<string, string | boolean> = {};
  const positional: string[] = [];
  const args = argv.slice(2);

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }

    const key = arg.slice(2);
    const next = args[i + 1];

    if (!next || next.startsWith('--')) {
      result[key] = true;
    } else {
      result[key] = next;
      i++;
    }
  }

  result._command = positional[0] ?? '';
  result._arg1 = positional[1] ?? '';

  return result;
};

// ── Output ──────────────────────────────────────────────────────

const printUsage = () => {
  console.log(`Usage: zeph <command> [options]

Commands:
  install         One-command setup: detect agents, save config, install rules
  uninstall       Remove Zeph from all detected agents
  verify          Check installation health across detected agents
  check-update    Check whether a newer Zeph version is available
  notify          Send a push notification
  list            List recent push notifications
  dismiss <id>    Dismiss a push notification (or --all)
  test            Send a test notification to verify setup
  cc              Run 'claude' in a named tmux session ('zeph-<project>')
  codex           Run 'codex' in a named tmux session
  gemini          Run 'gemini' in a named tmux session
  listener        Resident daemon — injects phone messages into tmux sessions.
                  Send a push with body '@<tmux-session> <text>' to drive it.

Notify options:
  --title <text>     Push title
  --body <text>      Push body
  --url <url>        URL to include
  --type <type>      Push type (note|link|file|hook) [default: hook]
  --priority <p>     Priority (low|normal|high|urgent) [default: normal]
  --device <id>      Target device ID
  --session <id>     AI session ID (or set ZEPH_SESSION_ID env)

List options:
  --limit <n>        Number of pushes (1-20, default 5)
  --type <type>      Filter by push type

Dismiss options:
  --all              Dismiss all notifications

Install options:
  --key <api-key>    API key (non-interactive)
  --hook <hook-id>   Hook ID (non-interactive)
  --base-url <url>   Base URL (non-interactive)
  --only <agents>    Comma-separated agent ids to install for
                     (claude,cursor,windsurf,gemini,codex,copilot,cline,aider).
                     Skips the interactive picker.

Uninstall options:
  --dry-run          Preview what would be removed, change nothing
  --purge            Also delete ~/.zeph/config.json (kept by default)

Verify options:
  --ping             Also make a live API call to confirm the key works

Global options:
  --key <api-key>    API key (or set ZEPH_API_KEY env)
  --base-url <url>   API base URL (or set ZEPH_BASE_URL env)
  --json             Output JSON format
  --version          Show version

Environment:
  ZEPH_API_KEY       API key (fallback when --key not provided)
  ZEPH_BASE_URL      API base URL (fallback when --base-url not provided)
  ZEPH_SESSION_ID    AI session ID (fallback when --session not provided)`);
};

const printError = (message: string, isJson: boolean) => {
  if (isJson) {
    console.error(JSON.stringify({ error: message, status: 'error' }));
  } else {
    console.error(`Error: ${message}`);
  }
};

const printJson = (data: unknown) => {
  console.log(JSON.stringify(data, null, 2));
};

// ── Commands ────────────────────────────────────────────────────

const createHook = (args: Record<string, string | boolean>): ZephHook | null => {
  const config = loadConfig();
  const apiKey = (args.key as string) || resolvedEnv('ZEPH_API_KEY') || config.apiKey;
  const isJson = args.json === true;

  if (!apiKey) {
    printError('API key required. Run "zeph install" or set ZEPH_API_KEY', isJson);
    return null;
  }

  const baseUrl = (args['base-url'] as string) || resolvedEnv('ZEPH_BASE_URL') || config.baseUrl;

  return new ZephHook({
    apiKey,
    ...(baseUrl && { baseUrl }),
  });
};

const handleNotify = async (args: Record<string, string | boolean>): Promise<number> => {
  const isJson = args.json === true;
  if (isMuted()) return 0;
  const hook = createHook(args);
  if (!hook) return 3;

  try {
    const sessionId = (args.session as string | undefined) || resolvedEnv('ZEPH_SESSION_ID') || undefined;

    // When body isn't supplied (common case for hook-driven invocations like
    // `zeph notify --title "Task done"`), auto-fill with branch + project so
    // the user can tell which session finished without opening the app.
    let title = args.title as string | undefined;
    let body = args.body as string | undefined;
    if (!body) {
      const { branch, project } = detectBranchAndProject();
      body = branch ? `${project} · ${branch}` : project;
    }
    if (!title) title = 'Task done';

    const result = await hook.notify({
      title,
      body,
      url: args.url as string | undefined,
      type: (args.type as 'note' | 'link' | 'file' | 'hook') || 'hook',
      priority: (args.priority as 'low' | 'normal' | 'high' | 'urgent') || undefined,
      targetDeviceId: args.device as string | undefined,
      sessionId,
    });

    if (isJson) {
      printJson({ pushId: result.pushId, status: 'ok' });
    } else {
      console.log(`Push sent: ${result.pushId}`);
    }
    return 0;
  } catch (err) {
    return handleError(err, isJson);
  }
};

const handleList = async (args: Record<string, string | boolean>): Promise<number> => {
  const isJson = args.json === true;
  const hook = createHook(args);
  if (!hook) return 3;

  try {
    const limit = args.limit ? Number(args.limit) : undefined;
    const result = await hook.list({
      limit,
      type: args.type as 'note' | 'link' | 'file' | 'clipboard' | 'hook' | undefined,
    });

    if (isJson) {
      printJson(result);
    } else {
      if (result.pushes.length === 0) {
        console.log('No pushes found.');
      } else {
        for (const p of result.pushes) {
          const title = p.title ?? '(no title)';
          const time = new Date(p.createdAt).toLocaleString();
          console.log(`  ${p.pushId}  [${p.type}]  ${title}  (${time})`);
        }
        if (result.hasMore) console.log(`  ... more available (use --limit to increase)`);
      }
    }
    return 0;
  } catch (err) {
    return handleError(err, isJson);
  }
};

const handleDismiss = async (args: Record<string, string | boolean>): Promise<number> => {
  const isJson = args.json === true;
  const hook = createHook(args);
  if (!hook) return 3;

  try {
    if (args.all === true) {
      const result = await hook.dismissAll();
      if (isJson) {
        printJson({ dismissed: result.dismissed, status: 'ok' });
      } else {
        console.log(`Dismissed ${result.dismissed} pushes.`);
      }
    } else {
      const pushId = args._arg1 as string;
      if (!pushId) {
        printError('Push ID required. Usage: zeph dismiss <push-id> or zeph dismiss --all', isJson);
        return 1;
      }
      await hook.dismiss(pushId);
      if (isJson) {
        printJson({ dismissed: true, pushId, status: 'ok' });
      } else {
        console.log(`Dismissed: ${pushId}`);
      }
    }
    return 0;
  } catch (err) {
    return handleError(err, isJson);
  }
};

const handleTest = async (args: Record<string, string | boolean>): Promise<number> => {
  const isJson = args.json === true;
  const hook = createHook(args);
  if (!hook) return 3;

  try {
    const result = await hook.notify({
      title: 'Zeph Test',
      body: `CLI connected successfully (v${VERSION})`,
    });

    if (isJson) {
      printJson({ pushId: result.pushId, status: 'ok', message: 'Test notification sent' });
    } else {
      console.log(`Test notification sent: ${result.pushId}`);
    }
    return 0;
  } catch (err) {
    return handleError(err, isJson);
  }
};

// ── Error Handler ───────────────────────────────────────────────

const handleError = (err: unknown, isJson: boolean): number => {
  if (err instanceof QuotaExceededError) {
    printError(err.message, isJson);
    return 2;
  }
  if (err instanceof AuthenticationError) {
    printError(err.message, isJson);
    return 3;
  }
  if (err instanceof ZephError) {
    printError(err.message, isJson);
    return 1;
  }
  printError(err instanceof Error ? err.message : 'Unknown error', isJson);
  return 1;
};

// ── Main ────────────────────────────────────────────────────────

const main = async (): Promise<number> => {
  const args = parseArgs(process.argv);
  const command = args._command as string;

  if (args.version === true) {
    console.log(VERSION);
    return 0;
  }

  if (!command || command === 'help') {
    printUsage();
    return 0;
  }

  switch (command) {
    case 'install':
    case 'setup':
      return handleInstall(args);
    case 'uninstall':
      return handleUninstall(args);
    case 'verify':
      return handleVerify(args);
    case 'check-update':
      return handleCheckUpdate(args);
    case 'notify':
      return handleNotify(args);
    case 'list':
      return handleList(args);
    case 'dismiss':
      return handleDismiss(args);
    case 'test':
      return handleTest(args);
    case 'cc':
      return handleAgentSession('claude');
    case 'codex':
      return handleAgentSession('codex');
    case 'gemini':
      return handleAgentSession('gemini');
    case 'listener':
      return handleListener(args);
    default:
      printError(`Unknown command: ${command}`, args.json === true);
      printUsage();
      return 1;
  }
};

main().then((code) => process.exit(code));
