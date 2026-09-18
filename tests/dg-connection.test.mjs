import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connectDgLines, DG_LINES } from '../lib/dg-connection.ts';
const endpoint = base => `${base}/?sign=test-secret`;
test('tries default then Taiwan after rejected handshake', async () => {
  const calls = [];
  let accepted = false;
  const ws = { accept() { accepted = true; }, close() {} };
  const result = await connectDgLines(endpoint, new AbortController().signal, async url => {
    calls.push(url.hostname);
    return calls.length === 1 ? new Response(null, { status: 403 }) : { status: 101, webSocket: ws };
  });
  assert.deepEqual(calls, DG_LINES.map(line => new URL(line.url).hostname));
  assert.equal(result, ws); assert.equal(accepted, true);
});
test('successful first line does not open second socket', async () => {
  let count = 0;
  await connectDgLines(endpoint, new AbortController().signal, async () => { count++; return { status: 101, webSocket: { accept() {}, close() {} } }; });
  assert.equal(count, 1);
});
test('reports both failures without signed URL', async () => {
  await assert.rejects(connectDgLines(endpoint, new AbortController().signal, async () => new Response(null, { status: 403 })), error => {
    assert.match(error.message, /預設線 HTTP 403；台灣線 HTTP 403/);
    assert.ok(!error.message.includes('test-secret')); return true;
  });
});
test('cancelled tab does not start fallback', async () => {
  const abort = new AbortController(); let count = 0;
  await assert.rejects(connectDgLines(endpoint, abort.signal, async () => { count++; abort.abort(); throw new Error('cancelled'); }));
  assert.equal(count, 1);
});
