/**
 * Worker-thread entry for the tmux session inventory (see inventory-offload.ts).
 * One sweep per request; the sweep itself is the unchanged synchronous
 * `collectSessionsVerbose` — it only runs on this thread now.
 */
import { parentPort } from 'worker_threads';
import { syncManifestFromCache } from './agent-rules-fetch.js';
import { collectSessionsVerbose } from './listener.js';
import type { InventoryReply } from './inventory-offload.js';

const port = parentPort;
if (!port) throw new Error('inventory-worker must be started as a worker thread');

port.on('message', (id: number) => {
    // Own module instance: pick up the OTA rules the main thread cached, else
    // every non-claude session reports `unknown` (see syncManifestFromCache).
    syncManifestFromCache();
    let reply: InventoryReply;
    try {
        reply = { id, result: collectSessionsVerbose() };
    } catch (err) {
        reply = { id, error: err instanceof Error ? err.message : String(err) };
    }
    port.postMessage(reply);
});
