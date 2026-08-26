/**
 * Runs the tmux session inventory on a worker thread so the daemon's event
 * loop stays free while `tmux` child processes are waited on.
 *
 * Why a thread and not async spawns: the inventory is a chain of synchronous
 * `spawnSync` calls — one `list-sessions` plus `display-message` and
 * `capture-pane` per session — and with 15 sessions a single sweep was measured
 * at 3s on the main thread (57% of daemon wall time, measured 2026-08-26).
 * Every one of those seconds the WebSocket was neither read nor written, so
 * stream subscribes arrived late, frames left late, pongs were missed and leases
 * lapsed. Moving the same synchronous code onto a worker keeps every tmux call
 * exactly as it was — including the tests that stub `spawnSync` — and only
 * changes which thread waits.
 *
 * The worker is optional. A worker that fails before it has ever answered
 * (missing file, module error, immediate exit) is given up on: pending and
 * future sweeps run in-thread as before, so a broken worker degrades to the old
 * behaviour instead of an empty session list. A worker that dies after having
 * worked is treated as transient — that sweep fails (the caller skips the
 * cycle) and the next `collect()` starts a fresh one.
 */
import { join } from 'path';
import { Worker } from 'worker_threads';
import type { CollectResult } from './listener.js';

export interface InventoryReply {
    id: number;
    result?: CollectResult;
    error?: string;
}

export interface InventoryOffload {
    /** Resolve one inventory sweep. Rejects when a working worker fails mid-sweep. */
    collect: () => Promise<CollectResult>;
    /** Stop the worker. Safe to call more than once. */
    close: () => void;
}

/** Longer than any sane sweep (measured ~3s at 15 sessions), shorter than the
 *  run of cycles a stuck worker would otherwise cost: the caller gates sweeps
 *  one-at-a-time, so this bounds how long a hang can hold the inventory. */
export const COLLECT_TIMEOUT_MS = 20_000;

interface Pending {
    resolve: (v: CollectResult) => void;
    reject: (e: Error) => void;
    timer: NodeJS.Timeout;
}

export const startInventoryOffload = (
    inThread: () => CollectResult,
    log: (msg: string) => void,
    workerPath: string = join(__dirname, 'inventory-worker.js'),
): InventoryOffload => {
    let worker: Worker | null = null;
    let closed = false;
    /** Set once a worker has answered; a failure before that is not transient. */
    let everReplied = false;
    /** Set when the worker is given up on — sweeps run in-thread from then on. */
    let inThreadOnly = false;
    let nextId = 0;
    const pending = new Map<number, Pending>();

    const settleAll = (outcome: (p: Pending) => void): void => {
        for (const [id, p] of pending) {
            clearTimeout(p.timer);
            pending.delete(id);
            outcome(p);
        }
    };

    const onFailure = (what: string): void => {
        if (closed) return settleAll((p) => p.reject(new Error('inventory offload closed')));
        if (everReplied) return settleAll((p) => p.reject(new Error(what)));
        inThreadOnly = true;
        log(`! ${what} before its first sweep — running the inventory in-thread from now on`);
        settleAll((p) => {
            try {
                p.resolve(inThread());
            } catch (err) {
                p.reject(err instanceof Error ? err : new Error(String(err)));
            }
        });
    };

    const spawn = (): Worker => {
        const w = new Worker(workerPath);
        // Never keep the process alive on the worker's account: the daemon's
        // own socket and timers decide when it exits.
        w.unref();
        w.on('message', (msg: InventoryReply) => {
            const p = pending.get(msg.id);
            if (!p) return;
            pending.delete(msg.id);
            clearTimeout(p.timer);
            everReplied = true;
            if (msg.error !== undefined) p.reject(new Error(msg.error));
            else p.resolve(msg.result as CollectResult);
        });
        w.on('error', (err) => {
            if (worker === w) worker = null;
            onFailure(`inventory worker error (${err instanceof Error ? err.message : String(err)})`);
        });
        w.on('exit', (code) => {
            if (worker === w) worker = null;
            // A worker we terminated (timeout, close) has already been settled.
            if (pending.size > 0) onFailure(`inventory worker exited (${code})`);
        });
        return w;
    };

    const collect = (): Promise<CollectResult> => {
        if (closed || inThreadOnly) return Promise.resolve(inThread());
        worker ??= spawn();
        const w = worker;
        const id = ++nextId;
        return new Promise<CollectResult>((resolve, reject) => {
            const timer = setTimeout(() => {
                pending.delete(id);
                reject(new Error(`inventory sweep exceeded ${COLLECT_TIMEOUT_MS / 1000}s`));
                // A stuck worker is not coming back; the next call spawns a fresh one.
                if (worker === w) worker = null;
                void w.terminate();
            }, COLLECT_TIMEOUT_MS);
            timer.unref();
            pending.set(id, { resolve, reject, timer });
            w.postMessage(id);
        });
    };

    const close = (): void => {
        closed = true;
        settleAll((p) => p.reject(new Error('inventory offload closed')));
        const w = worker;
        worker = null;
        if (w) void w.terminate();
    };

    return { collect, close };
};
