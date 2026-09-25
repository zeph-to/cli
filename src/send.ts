import { hostname } from 'node:os';
import { agentSessionContext } from './agent-session.js';
import { resolveAgentTarget, type AgentTargetDevice } from './agent-target.js';

export interface SendDeps {
    listDevices: () => Promise<AgentTargetDevice[]>;
    sendAgentCommand: (payload: { targetDeviceId: string; agentSessionName: string; body: string }) => Promise<{ pushId: string }>;
    /** This process's own agent session, or null outside tmux. */
    context: () => { agentDeviceId: string; agentSessionName: string } | null;
    hostname: () => string;
    out: (line: string) => void;
    err: (line: string) => void;
}

export const USAGE = 'Usage: zeph [--key …] [--base-url …] send <deviceId:session | name> <message… | - (read stdin)>';

// A CLI flag after `send`. Everything there is message text, so `--key ak_…`
// would be typed into the other session in plaintext: refuse it instead. A
// message quoted as one argument that mentions `--key` is not a flag.
const MISPLACED_FLAG = /^--(key|base-url)(=|$)/;

/**
 * `-` as the whole message: read it from stdin. An agent writes a summary on a
 * quoted heredoc (`zeph send <key> - <<'EOF'`), where the shell expands nothing;
 * inside double quotes its backticks or `$(…)` would run. Only on `-`: a bare
 * target with an open, empty stdin would wait forever.
 */
export const sendReadsStdin = (argv: string[]): boolean => argv.length === 2 && argv[1] === '-';

/** The target and the message `zeph send` got, or the usage error to exit 2 with. */
export const parseSendArgs = (argv: string[], stdin?: string): { target: string; message: string } | { error: string } => {
    const flag = argv.find((word) => MISPLACED_FLAG.test(word));
    if (flag) {
        return { error: `zeph send: ${flag.split('=')[0]} goes before 'send' — after it, it is message text\n${USAGE}` };
    }
    const [target, ...words] = argv;
    const message = (sendReadsStdin(argv) ? (stdin ?? '') : words.join(' ')).trim();
    return target && message ? { target, message } : { error: USAGE };
};

/**
 * The header the receiver reads first. It matches the MCP tool's
 * (mcp-server/src/tools/agent-send.ts `senderHeader`); the web app is to parse
 * the same shape to caption the bubble. The reply key is offered only for a
 * session the listener reports, and never for a subagent: `resolveAgentTarget`
 * takes neither, so the reply would not resolve.
 */
const senderHeader = (devices: AgentTargetDevice[], deps: SendDeps): { header: string; ownKey?: string } => {
    const ctx = deps.context();
    const own = ctx ? devices.find((d) => d.deviceId === ctx.agentDeviceId) : undefined;
    const host = own?.nickname ?? deps.hostname();
    const listed = !!ctx && !!own?.agentSessions?.some((s) => s.name === ctx.agentSessionName && !s.parentName);
    if (!ctx || !listed) return { header: `[from ${ctx?.agentSessionName ?? 'cli'}@${host}]` };
    const ownKey = `${ctx.agentDeviceId}:${ctx.agentSessionName}`;
    const label = own?.agentSessionAliases?.[ctx.agentSessionName] ?? ctx.agentSessionName;
    return { header: `[from ${label}@${host} · reply: ${ownKey}]`, ownKey };
};

/**
 * `zeph send <target> <message…>` — type a message into another agent session,
 * the CLI twin of the MCP `zeph_agent_send` for agents without MCP (pi).
 * Takes what `parseSendArgs` read. Exit 0 sent · 1 anything else.
 */
export const runSend = async ({ target, message }: { target: string; message: string }, deps: SendDeps): Promise<number> => {
    try {
        const devices = await deps.listDevices();
        const { header, ownKey } = senderHeader(devices, deps);
        const resolved = resolveAgentTarget(devices, target, ownKey);
        if (resolved.key === ownKey) {
            deps.err('zeph send: the target is this session itself — pick another agent');
            return 1;
        }
        await deps.sendAgentCommand({
            targetDeviceId: resolved.deviceId,
            agentSessionName: resolved.name,
            body: `${header} ${message}`,
        });
        deps.out(`sent → ${resolved.key}`);
        return 0;
    } catch (err) {
        deps.err(`zeph send: ${err instanceof Error ? err.message : String(err)}`);
        return 1;
    }
};

export const liveSendDeps = (hook: {
    listDevices: SendDeps['listDevices'];
    sendAgentCommand: SendDeps['sendAgentCommand'];
}): SendDeps => ({
    listDevices: () => hook.listDevices(),
    sendAgentCommand: (payload) => hook.sendAgentCommand(payload),
    context: agentSessionContext,
    hostname,
    out: (line) => console.log(line),
    err: (line) => console.error(line),
});
