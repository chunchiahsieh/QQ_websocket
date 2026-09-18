// Opt-in live test: requires the local relay and dedicated DG credentials.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
const env = Object.fromEntries(fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)
  .filter(line => line.includes('=')).map(line => {
    const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1).replace(/^["']|["']$/g, '')];
  }));
const health = () => fetch('http://127.0.0.1:5091/health').then(r => r.json());
async function connect() {
  const start = Date.now();
  const response = await fetch('http://127.0.0.1:5091/api/dg/start', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Relay-Key': env.DG_RELAY_API_KEY },
    body: JSON.stringify({ directLogin: true }),
  });
  assert.equal(response.status, 200);
  const { ticket } = await response.json();
  return new Promise((resolve, reject) => {
    const ws = new WebSocket('ws://127.0.0.1:5091/ws/dg', { origin: 'http://localhost:3000' });
    const timer = setTimeout(() => { ws.close(); reject(new Error('Timed out')); }, 90000);
    ws.on('open', () => ws.send(JSON.stringify({ ticket })));
    ws.on('error', () => { clearTimeout(timer); reject(new Error('Relay socket failed')); });
    ws.on('message', bytes => {
      const message = JSON.parse(bytes);
      if (message.type === 'error') { clearTimeout(timer); ws.close(); reject(new Error(message.message)); }
      if (message.type === 'tables') {
        clearTimeout(timer);
        resolve({ ws, count: message.tables.length, elapsed: Date.now() - start });
      }
    });
  });
}
async function disconnect(ws) {
  const closed = new Promise(resolve => ws.once('close', resolve));
  ws.close(); await closed;
}
const first = await connect();
const before = await health();
await disconnect(first.ws);
const idle = await health();
assert.equal(idle.activeSessions, 1, 'Browser stays alive without subscriber');
const second = await connect();
const after = await health();
assert.equal(after.feed.generation, before.feed.generation, 'Switch must not reopen browser');
assert.equal(after.activeSessions, 1);
assert.equal(after.feed.healthy, true);
console.log(JSON.stringify({ firstTables: first.count, firstMs: first.elapsed, secondTables: second.count,
  secondMs: second.elapsed, generation: after.feed.generation, idleBrowsers: idle.activeSessions }));
await disconnect(second.ws);
