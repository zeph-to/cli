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
import { loadConfig, resolvedEnv, resolveHookId } from './config.js';
import { agentSessionContext } from './agent-session.js';
import { clearRemoteActive, touchRemoteActive } from './gate.js';

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
    /**
     * Stable agent-session key, when this ask was raised from a tmux agent
     * pane. Both fields or neither: the phone's deep link needs the pair to
     * open the agent chat — which is where the live terminal and the key row
     * live — and falls back to the plain push screen without it. Agents with
     * no MCP (pi, codex) reach the phone only through this command, so leaving
     * them off is what made their asks land outside the chat.
     */
    agentDeviceId?: string;
    agentSessionName?: string;
    /**
     * Lets the phone offer "send and exit" on this ask. Only an agent's own
     * `zeph_ask` stand-in sets it (pi's rules pass `--accepts-exit`); an
     * approval gate has no mode to end, so it never offers the button and a
     * stray `exitRemote` on its answer is dropped.
     */
    acceptsExit?: boolean;
}

/** Injected so the poll loop is testable without a clock or a network. */
export interface AskDeps {
    fetchFn: typeof fetch;
    now: () => number;
    sleep: (ms: number) => Promise<void>;
}

export type AskOutcome =
    | { readonly answered: true; readonly actionId: string }
    | { readonly answered: true; readonly value: string; readonly exitRemote?: true }
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
    data?: { eventId?: string; response?: { actionId?: string; value?: string; exitRemote?: boolean } | null };
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
            agentDeviceId: opts.agentDeviceId,
            agentSessionName: opts.agentSessionName,
            ...(opts.acceptsExit ? { acceptsExit: true } : {}),
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
            // An exit is an answer even with no text — the web blocks an empty
            // one, the server does not.
            if (opts.acceptsExit && response?.exitRemote === true) {
                return { answered: true, value: response.value ?? '', exitRemote: true };
            }
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

/** Action ids that end a remote session, case-insensitive — mcp-server remote-state.ts SESSION_EXIT_IDS. */
const SESSION_EXIT_IDS = ['done', 'stop', 'exit'];

/**
 * What an ask outcome does to sticky REMOTE — mcp-server's
 * `remoteTransitionFor`, for the outcomes this command can produce. A
 * Done-like button or a send-and-exit answer ends it; any other answer enters
 * or refreshes it. An unanswered ask changes nothing: there is no fallback id
 * here to resolve to, and silence is not a user action.
 */
export const remoteTransition = (outcome: AskOutcome): 'enter' | 'exit' | 'keep' => {
    if (!outcome.answered) return 'keep';
    if ('actionId' in outcome) {
        return SESSION_EXIT_IDS.includes(outcome.actionId.trim().toLowerCase()) ? 'exit' : 'enter';
    }
    return outcome.exitRemote ? 'exit' : 'enter';
};

const settleRemote = (outcome: AskOutcome, dir: string): { zephState?: 'REMOTE' | 'NORMAL' } => {
    switch (remoteTransition(outcome)) {
        case 'exit':
            clearRemoteActive(dir);
            return { zephState: 'NORMAL' };
        case 'enter':
            touchRemoteActive(dir);
            return { zephState: 'REMOTE' };
        case 'keep':
            return {};
    }
};

/** Wall-clock deps for real use. */
export const liveDeps = (): AskDeps => ({
    fetchFn: fetch,
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
});

/**
 * `zeph ask --title … [--body …] [--actions id:Label,…] [--timeout 60] [--accepts-exit]`
 *
 * Prints one JSON object and nothing else, so a hook can pipe it straight into
 * `jq`. Exit code 0 means answered, 1 means not — a shell caller that only
 * wants approve/deny can read `$?` and skip the JSON entirely.
 */
export const handleAsk = async (args: Record<string, string | boolean>): Promise<number> => {
    const config = loadConfig();
    // `resolvedEnv`, not `process.env`: a hook environment can hand us a literal
    // unexpanded `${ZEPH_API_KEY}`, which is truthy and would beat the config
    // file. Auth then fails, this returns `answered: false`, and the approval
    // hook maps that to DENY — a command blocked for a reason that has nothing
    // to do with the user. Every other command in cli.ts resolves env this way.
    const apiKey = (args['api-key'] as string) || resolvedEnv('ZEPH_API_KEY') || config.apiKey;
    const hookId = (args.hook as string) || resolveHookId();
    const title = (args.title as string) || '';

    if (!apiKey || !hookId || !title) {
        const missing = [!title && '--title', !apiKey && 'an API key', !hookId && 'a hook id']
            .filter(Boolean).join(', ');
        process.stdout.write(JSON.stringify({ answered: false, error: `missing ${missing}` }) + '\n');
        return 1;
    }

    const timeoutSeconds = Number(args.timeout ?? 60);
    const acceptsExit = args['accepts-exit'] === true;
    const outcome = await requestApproval(
        {
            apiKey,
            baseUrl: (config.baseUrl ?? 'https://api.zeph.to/v1').replace(/\/$/, ''),
            hookId,
            title,
            body: args.body as string | undefined,
            actions: parseActions(args.actions as string | undefined),
            timeoutSeconds: Number.isFinite(timeoutSeconds) && timeoutSeconds > 0 ? timeoutSeconds : 60,
            ...(agentSessionContext() ?? {}),
            acceptsExit,
        },
        liveDeps(),
    );

    // The agent's own ask settles REMOTE as mcp-server's zeph_ask does and
    // reports it in the same `zephState` field; an approval gate leaves the
    // mode alone. Keyed by the cwd, the twin of the `ctx.cwd` the pi
    // extension hands `remote-hook pi` — pi's bash tool runs every command
    // there. Not detectProjectDir(): a CLAUDE_PROJECT_DIR leaked into a pi
    // launched from Claude Code would key another project's file.
    const settled = acceptsExit ? settleRemote(outcome, process.cwd()) : {};
    // `exitRemote` is the server's flag; the rules read `zephState`.
    process.stdout.write(JSON.stringify({ ...outcome, exitRemote: undefined, ...settled }) + '\n');
    return outcome.answered ? 0 : 1;
};
