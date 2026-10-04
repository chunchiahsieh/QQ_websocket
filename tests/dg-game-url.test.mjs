import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dgGameUrlForTable } from '../lib/dg-game-url.ts';

test('DG card ID opens the official numeric table ID without changing authorization', () => {
  const original = 'https://dg.example/ddnewpc/index.html?token=secret&type=5&return=dggw.vip';
  const selected = new URL(dgGameUrlForTable(original, 'DG:280614'));
  assert.equal(selected.searchParams.get('tableId'), '280614');
  assert.equal(selected.searchParams.get('token'), 'secret');
  assert.equal(selected.searchParams.get('type'), '5');
  assert.equal(dgGameUrlForTable(original, 'DG:RB01'), original);
});
