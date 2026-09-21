import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeDgPublicBean, DgTableAccumulator } from '../lib/dg-protobuf.ts';

const varint = value => {
  const bytes = [];
  while (value >= 128) { bytes.push((value & 127) | 128); value = Math.floor(value / 128); }
  return [...bytes, value];
};
const scalar = (field, value) => [...varint(field << 3), ...varint(value)];
const nested = (field, value) => [...varint((field << 3) | 2), ...varint(value.length), ...value];
const packet = (...fields) => Uint8Array.from(fields.flat()).buffer;

test('skips unknown length-delimited field without losing the next command', () => {
  const packet = Uint8Array.from([0x12, 3, 65, 66, 67, 0x08, 1]);
  assert.equal(decodeDgPublicBean(packet.buffer).cmd, 1);
});
test('rejects truncated fields', () => {
  assert.throws(() => decodeDgPublicBean(Uint8Array.from([0x12, 10, 1]).buffer));
});
test('retains zero-valued table count and state', () => {
  const packet = Uint8Array.from([0x8a, 0x01, 6, 8, 1, 32, 0, 40, 0]);
  assert.deepEqual(decodeDgPublicBean(packet.buffer).table[0], { tableId: '1', state: 0, countDown: 0 });
});

test('decodes lobby push count 739 and explicit zero from PublicBean field 16', () => {
  const lobby739 = nested(16, [...scalar(1, 100), ...scalar(2, 739)]);
  const lobbyZero = nested(16, [...scalar(1, 100), ...scalar(2, 0)]);
  assert.deepEqual(decodeDgPublicBean(packet(scalar(1, 207), lobby739)).lobbyPush, [{ tableId: '100', onlineCount: 739 }]);
  assert.deepEqual(decodeDgPublicBean(packet(scalar(1, 207), lobbyZero)).lobbyPush, [{ tableId: '100', onlineCount: 0 }]);
});

test('merges lobby count into complete known table without count regressions', () => {
  const state = new DgTableAccumulator();
  const table = nested(17, [...scalar(1, 100), ...scalar(2, 7), ...nested(10, [49, 35, 53]), ...scalar(16, 0)]);
  const lobby739 = nested(16, [...scalar(1, 100), ...scalar(2, 739)]);
  const initial = state.accept(decodeDgPublicBean(packet(scalar(1, 207), lobby739, table)));
  assert.equal(initial.length, 1);
  assert.deepEqual(initial[0], { tableId: '100', shoeId: '7', roads: ['1#5'], onlineCount: 739 });
  const staleTable = state.accept(decodeDgPublicBean(packet(nested(17, [...scalar(1, 100), ...scalar(16, 0)]))));
  assert.equal(staleTable[0].onlineCount, 739);
  assert.deepEqual(staleTable[0].roads, ['1#5']);
  assert.deepEqual(state.accept(decodeDgPublicBean(packet(scalar(1, 207), nested(16, [...scalar(1, 999), ...scalar(2, 20)])))), []);
  const lateTable = state.accept(decodeDgPublicBean(packet(nested(17, scalar(1, 999)))));
  assert.deepEqual(lateTable, [{ tableId: '999', onlineCount: 20 }]);
  assert.deepEqual(state.accept(decodeDgPublicBean(packet(scalar(1, 207), nested(16, scalar(1, 100))))), []);
  const zero = state.accept(decodeDgPublicBean(packet(scalar(1, 207), nested(16, [...scalar(1, 100), ...scalar(2, 0)]))));
  assert.equal(zero[0].onlineCount, 0);
  assert.deepEqual(zero[0].roads, ['1#5']);
  assert.equal(state.accept(decodeDgPublicBean(packet(nested(17, [...scalar(1, 100), ...scalar(16, 739)]))))[0].onlineCount, 0);
});
