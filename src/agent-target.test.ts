import { describe, it, expect } from 'vitest';
import { AgentTargetError, resolveAgentTarget } from './agent-target.js';
import type { AgentTargetDevice } from './agent-target.js';

// `zeph-brain` runs on both machines — the case a bare name must not guess at.
const devices: AgentTargetDevice[] = [
    {
        deviceId: 'dev_mac',
        nickname: 'takPC',
        agentSessions: [
            { name: 'zeph-proj', project: 'proj' },
            { name: 'zeph-brain', project: 'brain' },
            { name: 'zeph-proj.3', project: 'proj', parentName: 'zeph-proj' },
        ],
        agentSessionAliases: { 'zeph-proj': 'deploy' },
    },
    {
        deviceId: 'dev_linux',
        nickname: 'louis-lemon',
        agentSessions: [{ name: 'zeph-brain', project: 'brain', label: 'brain · Pi', providerSessionName: 'brain-95' }],
    },
];

const errorOf = (target: string): AgentTargetError => {
    try {
        resolveAgentTarget(devices, target);
    } catch (err) {
        if (err instanceof AgentTargetError) return err;
        throw err;
    }
    throw new Error(`"${target}" resolved`);
};

describe('resolveAgentTarget', () => {
    it('takes a device-qualified key as is', () => {
        expect(resolveAgentTarget(devices, 'dev_linux:zeph-brain')).toEqual({
            deviceId: 'dev_linux',
            name: 'zeph-brain',
            key: 'dev_linux:zeph-brain',
        });
    });

    it('takes a tmux name, alias or label that names one session', () => {
        expect(resolveAgentTarget(devices, 'zeph-proj').key).toBe('dev_mac:zeph-proj');
        expect(resolveAgentTarget(devices, 'deploy').key).toBe('dev_mac:zeph-proj');
        expect(resolveAgentTarget(devices, 'brain · Pi').key).toBe('dev_linux:zeph-brain');
    });

    it('refuses a name two machines share, and lists both keys', () => {
        const err = errorOf('zeph-brain');

        expect(err.code).toBe('AMBIGUOUS_TARGET');
        expect(err.message).toContain('dev_mac:zeph-brain');
        expect(err.message).toContain('dev_linux:zeph-brain');
    });

    it('refuses an unknown name and lists the live sessions', () => {
        const err = errorOf('nothing-like-this');

        expect(err.code).toBe('UNKNOWN_TARGET');
        expect(err.message).toContain('dev_mac:zeph-proj (deploy on takPC)');
    });

    it('refuses a key whose device is known but whose session is not', () => {
        expect(errorOf('dev_linux:zeph-gone').code).toBe('UNKNOWN_TARGET');
    });

    // The listener takes commands over its socket only: one sent while it is away is never typed.
    it('refuses a session on an offline machine, by key or by name', () => {
        const away = devices.map((d) => (d.deviceId === 'dev_linux' ? { ...d, isOnline: false } : d));
        const offlineError = (target: string) => {
            try {
                resolveAgentTarget(away, target);
            } catch (err) {
                if (err instanceof AgentTargetError) return err;
            }
            throw new Error(`"${target}" resolved`);
        };

        expect(offlineError('dev_linux:zeph-brain').code).toBe('TARGET_OFFLINE');
        expect(offlineError('brain · Pi').message).toContain('louis-lemon');
        expect(resolveAgentTarget(away, 'deploy').key).toBe('dev_mac:zeph-proj');
    });

    // Subagents are view-only: they take no input.
    it('never resolves to a subagent', () => {
        expect(errorOf('dev_mac:zeph-proj.3').code).toBe('UNKNOWN_TARGET');
        const listed = errorOf('zeph-proj.3').message;
        expect(listed).toContain('dev_mac:zeph-proj (');
        expect(listed).not.toContain('zeph-proj.3 (');
    });

    // The app shows a session by the name the agent gives it.
    it('takes the name the agent calls its session', () => {
        expect(resolveAgentTarget(devices, 'brain-95').key).toBe('dev_linux:zeph-brain');
    });

    it('leaves the sender out of name matching, so a shared name means the other machine', () => {
        expect(resolveAgentTarget(devices, 'zeph-brain', 'dev_mac:zeph-brain').key).toBe('dev_linux:zeph-brain');
    });

    it('resolves the sender named alone to itself, for the caller to refuse', () => {
        expect(resolveAgentTarget(devices, 'deploy', 'dev_mac:zeph-proj').key).toBe('dev_mac:zeph-proj');
    });

    it('does not offer the sender among the candidates of an unknown name', () => {
        const err = (() => {
            try {
                resolveAgentTarget(devices, 'nothing', 'dev_mac:zeph-proj');
            } catch (e) {
                return e;
            }
        })();
        expect(err).toBeInstanceOf(AgentTargetError);
        expect(String(err)).toContain('dev_linux:zeph-brain (');
        expect(String(err)).not.toContain('dev_mac:zeph-proj ');
    });
});
