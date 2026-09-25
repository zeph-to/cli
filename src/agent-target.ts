/** A subset of a `/devices` record (zeph `Device`). */
export interface AgentTargetDevice {
  deviceId: string;
  nickname?: string;
  isOnline?: boolean;
  agentSessions?: {
    name: string;
    project?: string;
    label?: string | null;
    providerSessionName?: string | null;
    parentName?: string;
  }[];
  agentSessionAliases?: Record<string, string>;
}

/** A resolved agent session: the listener's device id and its tmux name. */
export interface AgentTarget {
  deviceId: string;
  name: string;
  /** `<deviceId>:<name>` — the stable key the app groups the session's chat by. */
  key: string;
}

/**
 * The target named nothing, named more than one session, or is on a machine
 * that is offline. The message lists the keys to retry with.
 */
export class AgentTargetError extends Error {
  constructor(
    public readonly code: 'UNKNOWN_TARGET' | 'AMBIGUOUS_TARGET' | 'TARGET_OFFLINE',
    message: string,
  ) {
    super(message);
    this.name = 'AgentTargetError';
  }
}

interface Candidate extends AgentTarget {
  alias?: string;
  label?: string | null;
  /** The name the agent calls itself — what the app shows for the session. */
  providerSessionName?: string | null;
  host: string;
  /** The device says it is offline. Unknown (no `isOnline`) counts as online. */
  offline: boolean;
}

// Subagents are view-only (no input), so they are never a target.
const candidatesOf = (devices: AgentTargetDevice[]): Candidate[] =>
  devices.flatMap((d) =>
    (d.agentSessions ?? [])
      .filter((s) => !s.parentName)
      .map((s) => ({
        deviceId: d.deviceId,
        name: s.name,
        key: `${d.deviceId}:${s.name}`,
        alias: d.agentSessionAliases?.[s.name],
        label: s.label,
        providerSessionName: s.providerSessionName,
        host: d.nickname ?? d.deviceId,
        offline: d.isOnline === false,
      })),
  );

const listCandidates = (list: Candidate[]): string =>
  list.map((c) => `${c.key} (${c.alias ?? c.providerSessionName ?? c.label ?? c.name} on ${c.host})`).join(', ') || 'none';

/**
 * Resolve `target` to one live agent session.
 *
 * The key `<deviceId>:<tmuxName>` is exact. Anything else is matched against
 * the tmux name, the user's alias, the agent's own session name and the
 * listener's label, and must match exactly one session: the same tmux name on
 * two PCs is the routing bug a guess would reintroduce, so two matches are an
 * error that lists both keys. The sender's own session (`selfKey`) is left out
 * of name matching, so the same project on two PCs resolves to the other one;
 * named alone, it resolves to itself for the caller to refuse.
 *
 * A session on an offline machine is refused rather than sent to: the listener
 * takes commands over its socket only and fetches none it missed, so the
 * message would be stored and never typed.
 *
 * A copy of mcp-server/src/agent-target.ts: this package depends on that one,
 * but its entry point starts the MCP server when imported. Change both.
 */
export const resolveAgentTarget = (devices: AgentTargetDevice[], target: string, selfKey?: string): AgentTarget => {
  const all = candidatesOf(devices);
  const toTarget = ({ deviceId, name, key, host, offline }: Candidate): AgentTarget => {
    if (offline) {
      throw new AgentTargetError('TARGET_OFFLINE', `${key} is on ${host}, which is offline — the message would never be typed`);
    }
    return { deviceId, name, key };
  };

  const exact = all.find((c) => c.key === target);
  if (exact) return toTarget(exact);

  const named = (c: Candidate): boolean =>
    [c.name, c.alias, c.providerSessionName, c.label].some((n) => n === target);
  const others = all.filter((c) => c.key !== selfKey);
  const matches = others.filter(named);
  if (matches.length === 1) return toTarget(matches[0]);
  if (matches.length === 0) {
    const self = all.find((c) => c.key === selfKey && named(c));
    if (self) return toTarget(self);
  }
  if (matches.length > 1) {
    throw new AgentTargetError('AMBIGUOUS_TARGET', `ambiguous target "${target}" — use one of these keys: ${listCandidates(matches)}`);
  }
  throw new AgentTargetError('UNKNOWN_TARGET', `unknown target "${target}" — other agent sessions: ${listCandidates(others)}`);
};
