import { describe, expect, it, vi } from 'vitest';
import { handleMcp } from './mcp.js';

/**
 * `handleMcp` deliberately never settles, so every assertion here has to be a
 * race against a timer — awaiting it directly would hang the suite.
 * Returns 'pending' when the promise is still unsettled after `ms`.
 */
const raceSettle = (promise: Promise<number>, ms: number): Promise<number | 'pending'> =>
    Promise.race([
        promise,
        new Promise<'pending'>((resolve) => { setTimeout(() => resolve('pending'), ms); }),
    ]);

describe('handleMcp', () => {
    // handleMcp runs synchronously up to `await load()`, so the loader has
    // already been called by the time the (never-settling) promise comes back.
    it('starts the MCP server exactly once', () => {
        const load = vi.fn(async () => ({}));
        void handleMcp(load);
        expect(load).toHaveBeenCalledTimes(1);
    });

    // cli.ts ends with `main().then((code) => process.exit(code))`. The loader
    // resolves the instant the server is wired to stdio, so any numeric return
    // here would exit the process out from under the server it just started.
    it('never settles while the server owns the process', async () => {
        const outcome = await raceSettle(handleMcp(async () => ({})), 50);
        expect(outcome).toBe('pending');
    });

    it('reports a broken install with a non-zero exit code instead of hanging', async () => {
        const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
        const outcome = await raceSettle(
            handleMcp(async () => { throw new Error("Cannot find module '@zeph-to/mcp-server'"); }),
            50,
        );
        expect(outcome).toBe(1);
        expect(stderr.mock.calls.flat().join('\n')).toContain('@zeph-to/mcp-server');
        stderr.mockRestore();
    });
});
