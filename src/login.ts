import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { spawn } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { loadConfig, saveConfig } from './config.js';
import type { ZephConfig } from './config.js';

const DEFAULT_WEB_URL = 'https://app.zeph.to';
const DEFAULT_TIMEOUT_SEC = 300;

type CallbackConfig = Pick<ZephConfig, 'apiKey' | 'hookId' | 'baseUrl' | 'wsUrl'>;

type CallbackResult =
  | { ok: true; config: CallbackConfig }
  | { ok: false; status: number; reason: string };

// ── Pure helpers (unit-tested) ───────────────────────────────────

export const stripUndefined = <T extends Record<string, unknown>>(obj: T): Partial<T> => {
  const out: Partial<T> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) out[key as keyof T] = value as T[keyof T];
  }
  return out;
};

export const buildBridgeUrl = (webUrl: string, port: number, state: string, host: string): string => {
  const base = webUrl.replace(/\/+$/, '');
  const params = new URLSearchParams({ port: String(port), state, host });
  return `${base}/auth/cli-bridge?${params.toString()}`;
};

export const persistConfig = (next: CallbackConfig): void => {
  const existing = loadConfig();
  saveConfig({ ...existing, ...stripUndefined(next) });
};

export const parseCallback = (reqUrl: string, expectedState: string): CallbackResult => {
  const url = new URL(reqUrl, 'http://127.0.0.1');
  if (url.pathname !== '/cb') return { ok: false, status: 404, reason: 'not found' };

  const state = url.searchParams.get('state');
  if (state !== expectedState) return { ok: false, status: 403, reason: 'state mismatch' };

  const apiKey = url.searchParams.get('key') ?? undefined;
  if (!apiKey) return { ok: false, status: 400, reason: 'missing key' };

  return {
    ok: true,
    config: {
      apiKey,
      hookId: url.searchParams.get('hook') ?? undefined,
      baseUrl: url.searchParams.get('baseUrl') ?? undefined,
      wsUrl: url.searchParams.get('wsUrl') ?? undefined,
    },
  };
};

// ── Browser launch ───────────────────────────────────────────────

const browserCommand = (): { cmd: string; prefixArgs: string[] } => {
  if (process.platform === 'darwin') return { cmd: 'open', prefixArgs: [] };
  if (process.platform === 'win32') return { cmd: 'cmd', prefixArgs: ['/c', 'start', ''] };
  return { cmd: 'xdg-open', prefixArgs: [] };
};

const openBrowser = (url: string): boolean => {
  try {
    const { cmd, prefixArgs } = browserCommand();
    const child = spawn(cmd, [...prefixArgs, url], { stdio: 'ignore', detached: true });
    child.on('error', () => { /* surfaced via return false on throw only */ });
    child.unref();
    return true;
  } catch {
    return false;
  }
};

// ── Loopback server ──────────────────────────────────────────────

const DONE_HTML =
  '<!doctype html><meta charset="utf-8"><title>Zeph</title>' +
  '<body style="font-family:system-ui;text-align:center;padding:3rem">' +
  '<h2>Connected</h2><p>You can close this tab and return to the terminal.</p></body>';

const respond = (res: ServerResponse, status: number, body: string): void => {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
  res.end(body);
};

interface ServerHandle {
  port: number;
  /** Resolves with the validated config once the browser hits /cb. */
  done: Promise<CallbackConfig>;
  close: () => void;
}

const startLoopbackServer = (state: string): Promise<ServerHandle> => {
  let settle!: (config: CallbackConfig) => void;
  let fail!: (err: Error) => void;
  const done = new Promise<CallbackConfig>((res, rej) => {
    settle = res;
    fail = rej;
  });

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const result = parseCallback(req.url ?? '/', state);
    if (!result.ok) {
      respond(res, result.status, `<p>${result.reason}</p>`);
      if (result.status === 403) fail(new Error('state mismatch — refused'));
      return;
    }
    persistConfig(result.config);
    respond(res, 200, DONE_HTML);
    settle(result.config);
  });

  return new Promise((resolveHandle, rejectHandle) => {
    server.once('error', rejectHandle);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolveHandle({ port, done, close: () => server.close() });
    });
  });
};

// ── Command ──────────────────────────────────────────────────────

const headlessHint = (bridgeUrl: string): void => {
  console.error('\n  Could not open a browser.');
  console.error('  If this machine has no local browser, use the manual flow:');
  console.error('    npx @zeph-to/hook-sdk install --key ak_… --hook hook_…');
  console.error('  Or open this URL in a browser on THIS computer:');
  console.error(`    ${bridgeUrl}\n`);
};

export const handleLogin = async (args: Record<string, string | boolean>): Promise<number> => {
  // parseArgs yields `true` for a value-less flag (e.g. bare `--web-url`);
  // guard so it can't slip through as a malformed URL or a 1-second timeout.
  const rawWebUrl = args['web-url'];
  const webUrl = typeof rawWebUrl === 'string' ? rawWebUrl : DEFAULT_WEB_URL;
  const rawTimeout = args.timeout;
  const timeoutSec = typeof rawTimeout === 'string' ? Number(rawTimeout) : DEFAULT_TIMEOUT_SEC;
  const state = randomBytes(16).toString('hex');

  let handle: ServerHandle;
  try {
    handle = await startLoopbackServer(state);
  } catch (err) {
    console.error(`  Error: could not start local server (${err instanceof Error ? err.message : 'unknown'})`);
    return 1;
  }

  const bridgeUrl = buildBridgeUrl(webUrl, handle.port, state, hostname());
  console.log(`\n  Opening browser to sign in...\n    ${bridgeUrl}\n`);

  if (!openBrowser(bridgeUrl)) headlessHint(bridgeUrl);

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('timed out waiting for browser')), timeoutSec * 1000);
    timer.unref();
  });

  try {
    const config = await Promise.race([handle.done, timeout]);
    console.log(`  + Config saved. API key: ${config.apiKey?.slice(0, 12)}…`);
    if (config.hookId) console.log(`  + Hook: ${config.hookId}`);
    console.log('\n  Done! Restart your agents.\n');
    return 0;
  } catch (err) {
    console.error(`\n  Error: ${err instanceof Error ? err.message : 'login failed'}\n`);
    return 1;
  } finally {
    if (timer) clearTimeout(timer);
    handle.close();
  }
};
