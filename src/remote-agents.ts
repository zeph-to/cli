/**
 * Remote-control agent registry — the single table behind `zeph cc` /
 * `zeph codex` / `zeph gemini`, the listener's pane matching, and the
 * per-agent session-id enrichment. Adding a remote-controllable agent is
 * one row here (plus, for a genuinely new kind, backend/phone support:
 * `kind` is a wire contract — AgentSession.agentKind flows to the server
 * and the phone picker, which may validate the enum).
 *
 * This is deliberately NOT merged into `agents.ts`: that table drives
 * install/uninstall/verify detection (8 agents, incl. Cursor/Windsurf
 * which can never be driven via tmux), and the two tables carry different
 * name axes — install id vs subcommand alias vs pane binary.
 */
import { readdirSync, statSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

export interface RemoteAgent {
    /** Wire value for AgentSession.agentKind (server/phone contract). */
    kind: string;
    /** Human name for --help text. */
    displayName: string;
    /** Binary launched in the tmux pane; also the primary pane-match token. */
    binary: string;
    /** `zeph <subcommand>` aliases that launch this agent. */
    subcommands: readonly string[];
    /** Extra pane_command basenames accepted as this agent (beyond binary). */
    paneMatchAliases?: readonly string[];
    /**
     * Resolve the agent's own session id from the pane's cwd.
     * EXTENSION POINT: omitted for codex/gemini until their session-file
     * formats are confirmed — the listener then reports agentSessionId: null.
     */
    resolveSessionId?: (paneCwd: string) => string | null;
}

// ── Claude Code session resolver ─────────────────────────────────

const CLAUDE_PROJECTS_DIR = join(homedir(), '.claude', 'projects');

/**
 * Cache for detectClaudeSessionId. The function walks every jsonl file
 * in `~/.claude/projects/<hash>/` on each call — after weeks of CC use
 * that directory holds hundreds of session files, and we were calling
 * this per tmux session per 5-second report cycle. Heavy disk I/O
 * compounded with multiple sessions caused the report cycle to spike
 * CPU and starve the host shell.
 *
 * The current-session UUID only changes when a new CC session starts
 * in that directory (rare, on the order of hours), so a 60-second TTL
 * is safe and cuts the per-cycle stat count by ~12×.
 */
const claudeSessionCache = new Map<string, { sessionId: string | null; expiresAt: number }>();
const CLAUDE_SESSION_CACHE_TTL_MS = 60_000;

const doDetectClaudeSessionId = (cwd: string): string | null => {
    try {
        const projectHash = cwd.replace(/\//g, '-');
        const sessionsDir = join(CLAUDE_PROJECTS_DIR, projectHash);
        let latest: { name: string; mtime: number } | undefined;
        for (const entry of readdirSync(sessionsDir)) {
            const m = entry.match(/^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/);
            if (!m) continue;
            const stat = statSync(join(sessionsDir, entry));
            if (!stat.isFile()) continue;
            if (!latest || stat.mtimeMs > latest.mtime) {
                latest = { name: m[1], mtime: stat.mtimeMs };
            }
        }
        return latest?.name ?? null;
    } catch {
        return null;
    }
};

/**
 * Locate the most recent Claude Code session UUID for the working
 * directory of a tmux pane. Mirrors `mcp-server/config.ts`'s
 * detectClaudeSessionId: CC writes per-session jsonl files at
 * `~/.claude/projects/<projectHash>/<UUID>.jsonl` where the hash is
 * the cwd with `/` replaced by `-`. Cached for 60s — see
 * claudeSessionCache.
 */
export const detectClaudeSessionId = (cwd: string): string | null => {
    const now = Date.now();
    const cached = claudeSessionCache.get(cwd);
    if (cached && cached.expiresAt > now) return cached.sessionId;

    // Cap cache size so a long-lived listener that's seen many cwds
    // doesn't grow unbounded. 64 is plenty for any realistic setup.
    if (claudeSessionCache.size >= 64) {
        // Evict the oldest-expiring entry — Map iteration order is
        // insertion order, so the first key we hit is the oldest.
        const firstKey = claudeSessionCache.keys().next().value;
        if (firstKey !== undefined) claudeSessionCache.delete(firstKey);
    }

    const sessionId = doDetectClaudeSessionId(cwd);
    claudeSessionCache.set(cwd, { sessionId, expiresAt: now + CLAUDE_SESSION_CACHE_TTL_MS });
    return sessionId;
};

// ── The registry ─────────────────────────────────────────────────

const REMOTE_AGENT_TABLE = [
    {
        kind: 'claude',
        displayName: 'Claude Code',
        binary: 'claude',
        subcommands: ['cc', 'claude'],
        resolveSessionId: detectClaudeSessionId,
    },
    {
        kind: 'codex',
        displayName: 'Codex CLI',
        binary: 'codex',
        subcommands: ['codex'],
    },
    {
        kind: 'gemini',
        displayName: 'Gemini CLI',
        binary: 'gemini',
        subcommands: ['gemini'],
    },
] as const satisfies readonly RemoteAgent[];

/** Closed union of remote-controllable agent kinds ('claude' | 'codex' | 'gemini'). */
export type AgentKind = (typeof REMOTE_AGENT_TABLE)[number]['kind'];

/** A registry row: the uniform RemoteAgent shape with `kind` narrowed to the closed union. */
export type RegisteredRemoteAgent = RemoteAgent & { kind: AgentKind };

export const REMOTE_AGENTS: readonly RegisteredRemoteAgent[] = REMOTE_AGENT_TABLE;

export const findAgentBySubcommand = (cmd: string): RegisteredRemoteAgent | undefined =>
    REMOTE_AGENTS.find((a) => a.subcommands.includes(cmd));

export const matchAgentByPaneCommand = (base: string): RegisteredRemoteAgent | undefined => {
    if (!base) return undefined;
    return REMOTE_AGENTS.find((a) => a.binary === base || (a.paneMatchAliases ?? []).includes(base));
};
