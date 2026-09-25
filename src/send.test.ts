import { describe, expect, it, vi } from 'vitest';
import { parseSendArgs, runSend, sendReadsStdin, USAGE, type SendDeps } from './send.js';
import type { AgentTargetDevice } from './agent-target.js';
import { QuotaExceededError } from './errors.js';

const devices: AgentTargetDevice[] = [
    {
        deviceId: 'dev_mac',
        nickname: 'takPC',
        agentSessions: [{ name: 'zeph-proj' }, { name: 'pi-brain' }],
        agentSessionAliases: { 'pi-brain': 'brain' },
    },
    { deviceId: 'dev_linux', nickname: 'louis-lemon', agentSessions: [{ name: 'zeph-api' }] },
];

const deps = (over: Partial<SendDeps> = {}) => {
    const d = {
        listDevices: vi.fn(async () => devices),
        sendAgentCommand: vi.fn(async (_payload: { targetDeviceId: string; agentSessionName: string; body: string }) => ({
            pushId: 'push_1',
        })),
        context: vi.fn(() => ({ agentDeviceId: 'dev_mac', agentSessionName: 'pi-brain' })),
        hostname: () => 'tak-mbp.local',
        out: vi.fn(),
        err: vi.fn(),
        ...over,
    };
    return d;
};

describe('zeph send', () => {
    it('types the message into the target, headed by who sent it and the key to reply on', async () => {
        const d = deps();

        const code = await runSend({ target: 'dev_linux:zeph-api', message: '빌드 로그 확인해줘' }, d);

        expect(code).toBe(0);
        expect(d.sendAgentCommand).toHaveBeenCalledWith({
            targetDeviceId: 'dev_linux',
            agentSessionName: 'zeph-api',
            body: '[from brain@takPC · reply: dev_mac:pi-brain] 빌드 로그 확인해줘',
        });
        expect(d.out).toHaveBeenCalledWith('sent → dev_linux:zeph-api');
    });

    it('outside tmux, signs as the CLI on this host and offers no reply key', async () => {
        const d = deps({ context: () => null });

        await runSend({ target: 'zeph-api', message: 'hi' }, d);

        expect(d.sendAgentCommand.mock.calls[0][0].body).toBe('[from cli@tak-mbp.local] hi');
    });

    it('exits 1 and lists both keys when two machines share the name', async () => {
        const twice = [...devices, { deviceId: 'dev_win', nickname: 'win', agentSessions: [{ name: 'zeph-api' }] }];
        const d = deps({ listDevices: async () => twice });

        expect(await runSend({ target: 'zeph-api', message: 'hi' }, d)).toBe(1);
        expect(d.err.mock.calls[0][0]).toContain('dev_linux:zeph-api');
        expect(d.err.mock.calls[0][0]).toContain('dev_win:zeph-api');
        expect(d.sendAgentCommand).not.toHaveBeenCalled();
    });

    it('refuses to send to its own session', async () => {
        const d = deps();

        expect(await runSend({ target: 'brain', message: 'hi' }, d)).toBe(1);
        expect(d.sendAgentCommand).not.toHaveBeenCalled();
    });

    it('exits 1 when the API refuses, e.g. over the daily push quota', async () => {
        const d = deps({
            sendAgentCommand: vi.fn(async () => {
                throw new QuotaExceededError('Daily push limit reached');
            }),
        });

        expect(await runSend({ target: 'zeph-api', message: 'hi' }, d)).toBe(1);
        expect(d.err.mock.calls[0][0]).toContain('Daily push limit reached');
    });

    it('exits 1 on an unknown name, listing the other sessions', async () => {
        const d = deps();

        expect(await runSend({ target: 'nothing-like-this', message: 'hi' }, d)).toBe(1);
        expect(d.err.mock.calls[0][0]).toContain('dev_linux:zeph-api');
        expect(d.sendAgentCommand).not.toHaveBeenCalled();
    });

    // A tmux session the listener does not report has no key anyone could answer on.
    it('offers no reply key from a session the listener does not report', async () => {
        const d = deps({ context: () => ({ agentDeviceId: 'dev_mac', agentSessionName: 'scratch' }) });

        await runSend({ target: 'zeph-api', message: 'hi' }, d);

        expect(d.sendAgentCommand.mock.calls[0][0].body).toBe('[from scratch@takPC] hi');
    });

    // A pi subagent pane names itself `<#S>.<pane>`; replies only resolve to top-level sessions.
    it('offers no reply key from a subagent', async () => {
        const withSubagent = [
            { ...devices[0], agentSessions: [...(devices[0].agentSessions ?? []), { name: 'pi-brain.2', parentName: 'pi-brain' }] },
            devices[1],
        ];
        const d = deps({
            listDevices: async () => withSubagent,
            context: () => ({ agentDeviceId: 'dev_mac', agentSessionName: 'pi-brain.2' }),
        });

        await runSend({ target: 'zeph-api', message: 'hi' }, d);

        expect(d.sendAgentCommand.mock.calls[0][0].body).toBe('[from pi-brain.2@takPC] hi');
    });
});

describe('parseSendArgs', () => {
    it('takes the first word as the target and joins the rest into the message', () => {
        expect(parseSendArgs(['dev_linux:zeph-api', '빌드', '로그', '확인해줘'])).toEqual({
            target: 'dev_linux:zeph-api',
            message: '빌드 로그 확인해줘',
        });
    });

    it('is a usage error when the target or the message is missing', () => {
        for (const argv of [[], ['zeph-api'], ['zeph-api', '  ']]) {
            expect(parseSendArgs(argv)).toEqual({ error: USAGE });
        }
    });

    // Everything after `send` is message text: a key placed there would reach the other session in plaintext.
    it('refuses --key or --base-url after send without echoing the key', () => {
        for (const argv of [
            ['zeph-api', 'run', '--key', 'ak_secret'],
            ['--key', 'ak_secret', 'zeph-api', 'run'],
            ['zeph-api', 'run', '--key=ak_secret'],
            ['zeph-api', 'run', '--base-url', 'http://elsewhere'],
        ]) {
            const parsed = parseSendArgs(argv);
            expect('error' in parsed && parsed.error).toContain(USAGE);
            expect(JSON.stringify(parsed)).not.toContain('ak_secret');
        }
    });

    // The heredoc form an agent writes: nothing in the message is expanded by the shell.
    it('reads the message from stdin on -, keeping its lines and backticks', () => {
        expect(parseSendArgs(['zeph-api', '-'], 'Build is green.\n`npm test` passed.\n')).toEqual({
            target: 'zeph-api',
            message: 'Build is green.\n`npm test` passed.',
        });
        expect(parseSendArgs(['zeph-api', '-'], '  \n')).toEqual({ error: USAGE });
    });

    it('reads stdin only on - alone, so a bare target never waits on it', () => {
        expect(sendReadsStdin(['zeph-api', '-'])).toBe(true);
        expect(sendReadsStdin(['zeph-api'])).toBe(false);
        expect(sendReadsStdin(['zeph-api', '-', 'x'])).toBe(false);
        expect(parseSendArgs(['zeph-api', 'a', '-'], 'ignored')).toEqual({ target: 'zeph-api', message: 'a -' });
    });

    it('sends a message quoted as one argument that only mentions --key', () => {
        expect(parseSendArgs(['zeph-api', 'what does --key do'])).toEqual({ target: 'zeph-api', message: 'what does --key do' });
    });
});
