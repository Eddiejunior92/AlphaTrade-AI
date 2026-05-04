// Tiny in-process pub/sub used to push backend events (audit rows, trades)
// out to WebSocket clients in real time. Decoupled from server.js so any
// service can fire events without circular imports.
const { EventEmitter } = require('events');
const bus = new EventEmitter();
bus.setMaxListeners(50);
module.exports = bus;
