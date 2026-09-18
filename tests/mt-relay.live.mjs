// Explicit live smoke test; reads only server relay key, never prints credentials or payloads.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
const config = Object.fromEntries(readFileSync('.env.local', 'utf8').split(/\r?\n/).filter(line => line.includes('=')).map(line => {
  const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1).replace(/^['"]|['"]$/g, '')];
}));
const base = 'http://127.0.0.1:5091';
assert.equal((await fetch(base + '/api/mt/start', { method: 'POST' })).status, 401);
const response = await fetch(base + '/api/mt/start', { method: 'POST', headers: {
  'Content-Type': 'application/json', 'X-Relay-Key': config.DG_RELAY_API_KEY,
}, body: JSON.stringify({ directLogin: true }) });
assert.equal(response.status, 200);
const { ticket } = await response.json();
let snapshots = 0;
await new Promise((resolve, reject) => {
  const ws = new WebSocket('ws://127.0.0.1:5091/ws/mt', { origin: 'http://localhost:3000' });
  const timer = setTimeout(() => { ws.close(); reject(new Error('No MT table snapshots within 55 seconds')); }, 55000);
  ws.on('open', () => ws.send(JSON.stringify({ ticket })));
  ws.on('error', () => { clearTimeout(timer); reject(new Error('Relay WebSocket failed')); });
  ws.on('message', raw => {
    const message = JSON.parse(raw.toString());
    if (message.type === 'error') { clearTimeout(timer); ws.close(); reject(new Error('MT authorization failed')); }
    if (message.type === 'tables' && message.tables.length) {
      assert.ok(message.tables.every(table => table.payload.table_id != null));
      if (++snapshots === 2) {
        console.log(JSON.stringify({ snapshots, tables: message.tables.length, authenticatedRelay: true }));
        clearTimeout(timer); ws.close(); resolve();
      }
    }
  });
});
console.log('MT relay live test passed');
