import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleAsk } from './ask.js';

/**
 * Repro for: an ask raised from a tmux agent pane (pi, codex — anything with no
 * zeph MCP) reaches the phone with no agent-session key, so the notification
 * deep-links to the plain push screen instead of the agent chat that carries
 * the live terminal and the key row (apps/mobile/src/navigation/linking.ts:56).
 */
describe('zeph ask inside a tmux agent pane', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
        vi.unstubAllGlobals();
    });

    it('files the ask under the agent session so the push opens the agent chat', async () => {
        vi.stubEnv('TMUX', '/tmp/tmux-501/default,1234,0');
        // The pane's own wire name, so the helper answers without shelling out
        // to tmux — a machine with no tmux binary must still run this test.
        vi.stubEnv('ZEPH_AGENT_SESSION_NAME', 'zeph-pi-config');
        vi.stubEnv('ZEPH_API_KEY', 'k');
        vi.stubEnv('ZEPH_HOOK_ID', 'hook_1');

        const bodies: unknown[] = [];
        vi.stubGlobal('fetch', (async (url: string, init?: RequestInit) => {
            if (String(url).endsWith('/trigger')) {
                bodies.push(init?.body ? JSON.parse(String(init.body)) : undefined);
                return { ok: true, status: 200, json: async () => ({ data: { eventId: 'evt_1' } }) } as unknown as Response;
            }
            return {
                ok: true,
                status: 200,
                json: async () => ({ data: { response: { actionId: 'ok' } } }),
            } as unknown as Response;
        }) as unknown as typeof fetch);

        await handleAsk({ title: 'ready?', actions: 'ok:OK', timeout: '5' });

        expect(bodies).toHaveLength(1);
        expect(bodies[0]).toMatchObject({
            agentSessionName: 'zeph-pi-config',
            agentDeviceId: expect.stringMatching(/^dev_listener_/),
        });
    });
});
