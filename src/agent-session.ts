import { execFileSync } from 'node:child_process';
import { listenerDeviceId } from './listener-device-id.js';

/**
 * Stable agent-session grouping when running inside a tmux agent session, so a
 * push or hook event files under the same session key as the listener's own
 * pushes — surviving Claude session-UUID rotation, and letting the phone open
 * the agent chat (with its live terminal and key row) instead of a bare push
 * screen: `buildNotificationDeepLink` needs BOTH fields
 * (apps/mobile/src/navigation/linking.ts).
 *
 * The device id MUST equal the listener's `computeListenerDeviceId`, so it's
 * resolved the same way (machine-id hash → sticky file → hostname) via the
 * shared read-only helper — NOT a bare hostname hash, which drifts from the
 * listener's id when a machine id is readable and files the push under a
 * non-matching session key.
 *
 * One definition for every sender in this package: `zeph notify` (zeph-hook.ts)
 * and `zeph ask` (ask.ts). The MCP server has its own copy of the same rule
 * (mcp-server/src/config.ts) because it is a separate package.
 */
export const agentSessionContext = (): { agentDeviceId: string; agentSessionName: string } | null => {
    if (!process.env.TMUX) return null;
    // A pi subagent pane carries its own wire name (<#S>.<pane> — the
    // listener's naming) in this env, set by the extension for its notify
    // children. It wins over #S, which would file the push under the parent.
    const fromEnv = process.env.ZEPH_AGENT_SESSION_NAME?.trim();
    if (fromEnv) return { agentDeviceId: listenerDeviceId(), agentSessionName: fromEnv };
    let name: string;
    try {
        name = execFileSync('tmux', ['display-message', '-p', '#S'], { encoding: 'utf-8' }).trim();
    } catch {
        return null;
    }
    if (!name) return null;
    return { agentDeviceId: listenerDeviceId(), agentSessionName: name };
};
