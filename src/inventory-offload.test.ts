import { join } from 'path';
import { describe, expect, it, vi } from 'vitest';
import { startInventoryOffload } from './inventory-offload.js';

const FIXTURES = join(__dirname, 'fixtures', 'inventory-worker');
const IN_THREAD = { sessions: [{ name: 'zeph-in-thread' }], rejected: [] };
const inThread = () => IN_THREAD as never;

describe('inventory offload', () => {
    it('answers from the worker when it works', async () => {
        const log = vi.fn();
        const offload = startInventoryOffload(inThread, log, join(FIXTURES, 'echo.cjs'));
        try {
            const result = await offload.collect();
            expect(result.sessions.map((s) => s.name)).toEqual(['zeph-from-worker']);
            expect(log).not.toHaveBeenCalled();
        } finally {
            offload.close();
        }
    });

    it('falls back in-thread for good when the worker file cannot be loaded', async () => {
        const log = vi.fn();
        const offload = startInventoryOffload(inThread, log, join(FIXTURES, 'missing.cjs'));
        try {
            expect(await offload.collect()).toBe(IN_THREAD);
            // The pending sweep was served, the failure logged once, and no
            // second worker is attempted — the daemon must keep reporting.
            expect(await offload.collect()).toBe(IN_THREAD);
            expect(log).toHaveBeenCalledTimes(1);
            expect(log.mock.calls[0][0]).toMatch(/in-thread from now on/);
        } finally {
            offload.close();
        }
    });

    it('falls back in-thread for good when the worker dies before answering', async () => {
        const log = vi.fn();
        const offload = startInventoryOffload(inThread, log, join(FIXTURES, 'dies.cjs'));
        try {
            expect(await offload.collect()).toBe(IN_THREAD);
            expect(await offload.collect()).toBe(IN_THREAD);
            expect(log).toHaveBeenCalledTimes(1);
        } finally {
            offload.close();
        }
    });

    it('rejects pending sweeps on close and serves later ones in-thread', async () => {
        const offload = startInventoryOffload(inThread, vi.fn(), join(FIXTURES, 'echo.cjs'));
        await offload.collect();
        offload.close();
        expect(await offload.collect()).toBe(IN_THREAD);
    });
});
