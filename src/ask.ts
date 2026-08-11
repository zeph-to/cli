/**
 * `zeph ask` — put a question on the user's phone and block until they answer.
 *
 * Why this lives in the CLI at all: hooks are shell scripts, and a shell script
 * cannot call an MCP tool. `zeph_ask` (mcp-server) already does this for the
 * model; a hook that needs to wait for a person — an approval gate in front of
 * a dangerous command — has no way to reach it. This is that path.
 *
 * It returns ONE shape for every outcome, including failure. A hook standing in
 * front of `rm -rf` cannot handle an exception, and an approval gate that
 * throws has stopped being a gate: unreachable server, bad key, and silence all
 * come back as `answered: false` so the caller makes the same decision it would
 * have made on a refusal.
 *
 * No WebSocket fast path, unlike mcp-server's poll. A hook run is seconds long
 * and dies with the tool call, so a socket would cost a handshake it cannot
 * amortise; plain polling is the whole protocol here.
 */
import { loadConfig } from './config.js';

/** Server-side hook trigger + event read. Kept narrow on purpose — this
 *  module needs two routes, not an API client. */
const TRIGGER_PATH = (hookId: string) => `/hooks/${hookId}/trigger`;
const EVENT_PATH = (hookId: string, eventId: string) => `/hooks/${hookId}/events/${eventId}`;

/** Poll cadence. Fast enough that a tap feels immediate, slow enough that a
 *  10-minute wait is not thousands of requests. */
const POLL_INTERVAL_MS = 1_000;
/** Per-request bound, well under any sane overall deadline. */
const REQUEST_TIMEOUT_MS = 10_000;

export interface AskAction {
    id: string;
    label: string;
}

export interface AskOptions {
    apiKey: string;
    baseUrl: string;
    hookId: string;
    title: string;
    body?: string;
    actions?: AskAction[];
    timeoutSeconds: number;
}

/** Injected so the poll loop is testable without a clock or a network. */
export interface AskDeps {
    fetchFn: typeof fetch;
    now: () => number;
    sleep: (ms: number) => Promise<void>;
}

export type AskOutcome =
    | { readonly answered: true; readonly actionId: string }
    | { readonly answered: true; readonly value: string }
    | { readonly answered: false; readonly error?: string };

/**
 * `id:Label` pairs, comma separated. The label may contain colons — only the
 * first one separates, so `go:Deploy: prod` keeps its punctuation. A bare
 * segment becomes its own label, which is what someone typing `--actions ok`
 * means.
 */
export const parseActions = (spec?: string): AskAction[] => {
    if (!spec) return [];
    return spec
        .split(',')
        .map((seg) => seg.trim())
        .filter((seg) => seg.length > 0)
        .map((seg) => {
            const idx = seg.indexOf(':');
            if (idx === -1) return { id: seg, label: seg };
            const id = seg.slice(0, idx).trim();
            const label = seg.slice(idx + 1).trim();
            return { id, label: label || id };
        })
        .filter((a) => a.id.length > 0);
};

const errorMessage = (err: unknown): string =>
    err instanceof Error ? err.message : String(err);

interface ApiShape {
    data?: { eventId?: string; response?: { actionId?: string; value?: string } | null };
    error?: { message?: string };
}

const callApi = async (
    deps: AskDeps,
    opts: AskOptions,
    method: string,
    path: string,
    body?: unknown,
): Promise<ApiShape> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
        const headers: Record<string, string> = { 'X-API-Key': opts.apiKey };
        if (body) headers['Content-Type'] = 'application/json';
        const res = await deps.fetchFn(`${opts.baseUrl}${path}`, {
            method,
            headers,
            body: body ? JSON.stringify(body) : undefined,
            signal: controller.signal,
        });
        const json = (await res.json()) as ApiShape;
        if (!res.ok) throw new Error(json.error?.message ?? `HTTP ${res.status}`);
        return json;
    } finally {
        clearTimeout(timer);
    }
};

/**
 * Ask, then wait. Resolves when the user answers or the deadline passes —
 * never rejects.
 */
export const requestApproval = async (opts: AskOptions, deps: AskDeps): Promise<AskOutcome> => {
    const deadline = deps.now() + opts.timeoutSeconds * 1000;

    let eventId: string;
    try {
        const trigger = await callApi(deps, opts, 'POST', TRIGGER_PATH(opts.hookId), {
            title: opts.title,
            body: opts.body,
            actions: opts.actions,
            timeout: opts.timeoutSeconds,
            hookType: 'combo',
        });
        const id = trigger.data?.eventId;
        if (!id) return { answered: false, error: 'no eventId in trigger response' };
        eventId = id;
    } catch (err) {
        // The question never reached the phone; there is nothing to wait for.
        return { answered: false, error: errorMessage(err) };
    }

    while (deps.now() < deadline) {
        try {
            const event = await callApi(deps, opts, 'GET', EVENT_PATH(opts.hookId, eventId));
            const response = event.data?.response;
            if (response?.actionId) return { answered: true, actionId: response.actionId };
            if (response?.value) return { answered: true, value: response.value };
        } catch {
            // One failed poll is not an answer and not a refusal — the user may
            // still be reaching for their phone. Keep waiting; the deadline is
            // what ends this loop.
        }
        await deps.sleep(POLL_INTERVAL_MS);
    }

    return { answered: false };
};

/** Wall-clock deps for real use. */
export const liveDeps = (): AskDeps => ({
    fetchFn: fetch,
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
});

/**
 * `zeph ask --title … [--body …] [--actions id:Label,…] [--timeout 60]`
 *
 * Prints one JSON object and nothing else, so a hook can pipe it straight into
 * `jq`. Exit code 0 means answered, 1 means not — a shell caller that only
 * wants approve/deny can read `$?` and skip the JSON entirely.
 */
export const handleAsk = async (args: Record<string, string | boolean>): Promise<number> => {
    const config = loadConfig();
    const apiKey = (args['api-key'] as string) || process.env.ZEPH_API_KEY || config.apiKey;
    const hookId = (args.hook as string) || process.env.ZEPH_HOOK_ID || config.hookId;
    const title = (args.title as string) || '';

    if (!apiKey || !hookId || !title) {
        const missing = [!title && '--title', !apiKey && 'an API key', !hookId && 'a hook id']
            .filter(Boolean).join(', ');
        process.stdout.write(JSON.stringify({ answered: false, error: `missing ${missing}` }) + '\n');
        return 1;
    }

    const timeoutSeconds = Number(args.timeout ?? 60);
    const outcome = await requestApproval(
        {
            apiKey,
            baseUrl: (config.baseUrl ?? 'https://api.zeph.to/v1').replace(/\/$/, ''),
            hookId,
            title,
            body: args.body as string | undefined,
            actions: parseActions(args.actions as string | undefined),
            timeoutSeconds: Number.isFinite(timeoutSeconds) && timeoutSeconds > 0 ? timeoutSeconds : 60,
        },
        liveDeps(),
    );

    process.stdout.write(JSON.stringify(outcome) + '\n');
    return outcome.answered ? 0 : 1;
};
