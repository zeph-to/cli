// Test double: answers only while the file named by ZEPH_TEST_MARKER exists,
// and hangs otherwise. Lets a test drive a timeout / success / timeout sequence
// across worker restarts, which a per-worker counter could not survive.
const { parentPort } = require('worker_threads');
const { existsSync } = require('fs');
parentPort.on('message', (id) => {
    if (!existsSync(process.env.ZEPH_TEST_MARKER || '')) return; // hang
    parentPort.postMessage({ id, result: { sessions: [{ name: 'zeph-from-worker' }], rejected: [] } });
});
