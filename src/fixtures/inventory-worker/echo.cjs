// Test double for inventory-worker.js: answers every request with a fixed sweep.
const { parentPort } = require('worker_threads');
parentPort.on('message', (id) => parentPort.postMessage({ id, result: { sessions: [{ name: 'zeph-from-worker' }], rejected: [] } }));
