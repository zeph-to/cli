// Test double: a worker that takes the request and never answers — the shape of
// a sweep that outlives the collect timeout on a loaded machine.
const { parentPort } = require('worker_threads');
parentPort.on('message', () => { /* never reply */ });
