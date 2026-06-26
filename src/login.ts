import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { spawn } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { loadConfig, saveConfig } from './config.js';

const DEFAULT_WEB_URL = 'https://app.zeph.to';
const DEFAULT_TIMEOUT_SEC = 300;

/** Credentials returned by a completed login. apiKey is guaranteed present
 *  (parseCallback rejects a missing key with 400). Shared by handleLogin and
 *  handleInstall via runLoginFlow. */
export type LoginFlowResult = {
  apiKey: string;
  hookId?: string;
  baseUrl?: string;
  wsUrl?: string;
};

type CallbackResult =
  | { ok: true; config: LoginFlowResult }
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

export const persistConfig = (next: LoginFlowResult): void => {
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

// The callback page is served from a loopback server with no network access,
// so it inlines all styles and a single load-time animation — no external
// fonts or assets. It's on screen for only a few seconds before the user
// returns to the terminal, so its whole job is to confirm state and point back.

const esc = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string
  ));

type PageVariant = 'ok' | 'error';

// Glyph drawn inside a 56×56 ring. `ok` = check, `error` = exclamation
// (the trailing `h0.01` path renders as a dot via the round line cap).
const GLYPH: Record<PageVariant, string> = {
  ok: '<path d="M17 29l7.5 7.5L39 19"/>',
  error: '<path d="M28 15v17"/><path d="M28 40h0.01"/>',
};

const PAGE_STYLE = `*{box-sizing:border-box;margin:0}
:root{--bg:#0A0C12;--text:#EAEEF8;--muted:#79829A;--primary:#8B9BFF;
--ok:#5FE3B3;--warn:#FF8C7A;--card:rgba(255,255,255,.03);--line:rgba(255,255,255,.09);--accent:var(--primary)}
body.ok{--accent:var(--ok)}body.error{--accent:var(--warn)}
@media(prefers-color-scheme:light){:root{--bg:#F4F6FB;--text:#171A22;--muted:#5C6478;
--card:rgba(10,12,18,.025);--line:rgba(10,12,18,.09)}}
html,body{height:100%}
body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;background:var(--bg);color:var(--text);
display:grid;place-items:center;padding:2rem;position:relative;overflow:hidden}
body::before{content:"";position:fixed;inset:0;z-index:0;opacity:0;animation:glow 1.1s ease forwards;
background:radial-gradient(60% 48% at 50% 14%,color-mix(in oklab,var(--accent) 24%,transparent),transparent 70%)}
.card{position:relative;z-index:1;text-align:center;max-width:30rem;
display:flex;flex-direction:column;align-items:center;gap:.85rem}
.glyph{width:72px;height:72px;margin-bottom:.3rem}
.glyph .ring,.glyph .mark>*{fill:none;stroke:var(--accent);stroke-width:3;stroke-linecap:round;stroke-linejoin:round}
.glyph .ring{stroke:color-mix(in oklab,var(--accent) 38%,transparent);
stroke-dasharray:151;stroke-dashoffset:151;animation:draw .7s ease forwards}
.glyph .mark>*{stroke-dasharray:44;stroke-dashoffset:44;animation:draw .5s .45s ease forwards}
h1{font-size:clamp(1.55rem,5vw,2.05rem);font-weight:700;letter-spacing:-.03em;line-height:1.06;animation:rise .6s .15s both}
p{color:var(--muted);font-size:1.02rem;line-height:1.5;max-width:23rem;animation:rise .6s .25s both}
.chip{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.82rem;color:var(--text);
background:var(--card);border:1px solid var(--line);border-radius:.55rem;padding:.45rem .7rem;
margin-top:.35rem;animation:rise .6s .35s both}
.brand{position:fixed;bottom:1.4rem;left:0;right:0;z-index:1;text-align:center;
font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.72rem;letter-spacing:.4em;
text-transform:lowercase;color:var(--muted);opacity:.55}
@keyframes glow{to{opacity:1}}
@keyframes draw{to{stroke-dashoffset:0}}
@keyframes rise{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
@media(prefers-reduced-motion:reduce){*{animation-duration:.001s!important;animation-delay:0s!important}
body::before{opacity:1}.glyph .ring,.glyph .mark>*{stroke-dashoffset:0}}`;

const renderPage = (
  variant: PageVariant,
  title: string,
  message: string,
  hint?: string,
): string =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
  `<meta name="viewport" content="width=device-width,initial-scale=1">` +
  `<title>Zeph</title><style>${PAGE_STYLE}</style></head>` +
  `<body class="${variant}"><main class="card">` +
  `<svg class="glyph" viewBox="0 0 56 56" aria-hidden="true">` +
  `<circle class="ring" cx="28" cy="28" r="24"/><g class="mark">${GLYPH[variant]}</g></svg>` +
  `<h1>${esc(title)}</h1><p>${esc(message)}</p>` +
  (hint ? `<code class="chip">${esc(hint)}</code>` : '') +
  `</main><footer class="brand">zeph</footer></body></html>`;

// Turn an internal callback failure reason into end-user guidance: name what
// happened and how to recover, in the interface's voice — never an apology.
const errorPage = (reason: string): string => {
  const copy: Record<string, [string, string]> = {
    'state mismatch': [
      "Sign-in didn't match",
      "This link didn't match the request that started it. Return to your terminal and run login again.",
    ],
    'missing key': [
      'No key came back',
      'The sign-in finished without a key. Return to your terminal and run login again.',
    ],
    'not found': [
      'Nothing to see here',
      'This page only handles the Zeph login callback.',
    ],
  };
  const [title, message] = copy[reason] ?? ['Something went wrong', reason];
  return renderPage('error', title, message);
};

const respond = (res: ServerResponse, status: number, body: string): void => {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
  res.end(body);
};

interface ServerHandle {
  port: number;
  /** Resolves with the validated config once the browser hits /cb. */
  done: Promise<LoginFlowResult>;
  close: () => void;
}

const startLoopbackServer = (state: string): Promise<ServerHandle> => {
  let settle!: (config: LoginFlowResult) => void;
  let fail!: (err: Error) => void;
  const done = new Promise<LoginFlowResult>((res, rej) => {
    settle = res;
    fail = rej;
  });

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const result = parseCallback(req.url ?? '/', state);
    if (!result.ok) {
      respond(res, result.status, errorPage(result.reason));
      if (result.status === 403) fail(new Error('state mismatch — refused'));
      return;
    }
    persistConfig(result.config);
    respond(res, 200, renderPage(
      'ok',
      "You're connected",
      'Close this tab and head back to your terminal.',
      'zeph is ready',
    ));
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
  console.error('    npx @zeph-to/cli install --key ak_… --hook hook_…');
  console.error('  Or open this URL in a browser on THIS computer:');
  console.error(`    ${bridgeUrl}\n`);
};

export const resolveWebUrl = (raw: string | boolean | undefined): string =>
  typeof raw === 'string' ? raw : DEFAULT_WEB_URL;

export const resolveTimeoutSec = (raw: string | boolean | undefined): number => {
  if (typeof raw !== 'string') return DEFAULT_TIMEOUT_SEC;
  const n = Number(raw);
  // Reject NaN / non-positive — a bad --timeout must not fire setTimeout instantly.
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TIMEOUT_SEC;
};

/**
 * Core login flow shared by `handleLogin` (CLI command) and `handleInstall`
 * (auto-trigger on missing credentials). Returns the issued credentials, or
 * null when the browser can't open (headless) or the callback never arrives.
 * `deps.open` is injectable for tests; defaults to the real browser launcher.
 */
export const runLoginFlow = async (
  opts: { webUrl: string; timeoutSec: number },
  deps: { open?: (url: string) => boolean } = {},
): Promise<LoginFlowResult | null> => {
  const open = deps.open ?? openBrowser;
  const state = randomBytes(16).toString('hex');

  let handle: ServerHandle;
  try {
    handle = await startLoopbackServer(state);
  } catch (err) {
    console.error(`  Error: could not start local server (${err instanceof Error ? err.message : 'unknown'})`);
    return null;
  }

  const bridgeUrl = buildBridgeUrl(opts.webUrl, handle.port, state, hostname());
  console.log(`\n  Opening browser to sign in...\n    ${bridgeUrl}\n`);

  if (!open(bridgeUrl)) {
    headlessHint(bridgeUrl);
    handle.close();
    return null;
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('timed out waiting for browser')), opts.timeoutSec * 1000);
    timer.unref();
  });

  try {
    return await Promise.race([handle.done, timeout]);
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
    handle.close();
  }
};

export const handleLogin = async (args: Record<string, string | boolean>): Promise<number> => {
  const webUrl = resolveWebUrl(args['web-url']);
  const timeoutSec = resolveTimeoutSec(args.timeout);

  const result = await runLoginFlow({ webUrl, timeoutSec });
  if (!result) {
    console.error('\n  Error: login did not complete\n');
    return 1;
  }

  console.log(`  + Config saved. API key: ${result.apiKey.slice(0, 12)}…`);
  if (result.hookId) console.log(`  + Hook: ${result.hookId}`);
  console.log('\n  Done! Restart your agents.\n');
  return 0;
};
