import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Regression: every stream start and screen request used to re-run the full
// inventory sweep (two tmux spawns per
// session) on the main thread. Membership now comes from the last sweep, and
// only a miss pays for a sweep.
const spawnCalls: string[][] = [];
vi.mock('child_process', async (importOriginal) => {
    const actual = await importOriginal<typeof import('child_process')>();
    return {
        ...actual,
        spawnSync: (_cmd: string, args: string[]) => {
            spawnCalls.push(args);
            if (args.includes('capture-pane')) return { status: 0, stdout: 'pane text\n', stderr: '' };
            return { status: 1, stdout: '', stderr: 'no server' };
        },
    };
});

const TMP = mkdtempSync(join(tmpdir(), 'zeph-inventory-'));
process.env.HOME = TMP;
process.env.XDG_STATE_HOME = join(TMP, 'state');

const { isInventoried, recordInventory, handleScreenRequest, computeListenerDeviceId } =
    await import('./listener.js');

// Socket discovery also runs `list-sessions` (bare); an inventory sweep is the
// one that asks for the session fields.
const sweeps = () =>
    spawnCalls.filter((args) => args.includes('list-sessions') && args.some((a) => a.includes('#{session_attached}'))).length;

describe('inventory membership from the last sweep', () => {
    beforeEach(() => {
        spawnCalls.length = 0;
        recordInventory(null);
    });

    it('sweeps when nothing has been recorded yet', () => {
        expect(isInventoried('zeph-a')).toBe(false);
        expect(sweeps()).toBeGreaterThan(0);
    });

    it('answers a hit without spawning tmux', () => {
        recordInventory([{ name: 'zeph-a' }]);
        expect(isInventoried('zeph-a')).toBe(true);
        expect(sweeps()).toBe(0);
    });

    it('still sweeps on a miss, so a session younger than one poll is not refused', () => {
        recordInventory([{ name: 'zeph-a' }]);
        expect(isInventoried('zeph-b')).toBe(false);
        expect(sweeps()).toBeGreaterThan(0);
    });

    it('serves a screen request for an inventoried session with a single capture', () => {
        recordInventory([{ name: 'zeph-a' }]);
        const snap = handleScreenRequest({
            subtype: 'agent.screen.request',
            requestId: 'r1',
            sessionName: 'zeph-a',
            targetDeviceId: computeListenerDeviceId(),
        });
        expect(snap).toMatchObject({ requestId: 'r1' });
        expect(snap).not.toHaveProperty('error');
        expect(snap?.content).toContain('pane text');
        expect(sweeps()).toBe(0);
        expect(spawnCalls.filter((args) => args.includes('capture-pane')).length).toBe(1);
    });
});
