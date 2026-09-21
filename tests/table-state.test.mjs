import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isTableShuffling } from '../lib/table-state.ts';

test('DG state 2 never uses the MT shuffling overlay', () => {
  assert.equal(isTableShuffling('DG:RB01', '2', 'DG'), false);
  assert.equal(isTableShuffling('DG:RB01', '2'), false);
  assert.equal(isTableShuffling('table-without-prefix', '2', 'DG'), false);
});

test('MT and AB still show their mapped shuffling state', () => {
  assert.equal(isTableShuffling('MT:B01', '2', 'MT'), true);
  assert.equal(isTableShuffling('AB:B01', '2', '歐博'), true);
  assert.equal(isTableShuffling('MT:B01', '1', 'MT'), false);
});
