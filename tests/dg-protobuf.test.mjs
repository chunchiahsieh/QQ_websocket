import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeDgPublicBean } from '../lib/dg-protobuf.ts';

test('skips unknown length-delimited field without losing the next command', () => {
  const packet = Uint8Array.from([0x12, 3, 65, 66, 67, 0x08, 1]);
  assert.equal(decodeDgPublicBean(packet.buffer).cmd, 1);
});
test('rejects truncated fields', () => {
  assert.throws(() => decodeDgPublicBean(Uint8Array.from([0x12, 10, 1]).buffer));
});
test('retains zero-valued table count and state', () => {
  const packet = Uint8Array.from([0x8a, 0x01, 6, 8, 1, 32, 0, 40, 0]);
  assert.deepEqual(decodeDgPublicBean(packet.buffer).table[0], { roads: [], tableId: '1', state: 0, countDown: 0 });
});
