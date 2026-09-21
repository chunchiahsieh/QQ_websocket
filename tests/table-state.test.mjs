import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isTableShuffling, tableOverlayLabel } from '../lib/table-state.ts';

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

test('explicit dealing phase reuses the overlay with opening text', () => {
  assert.equal(tableOverlayLabel('DG:RB01', undefined, 'DG', 'dealing'), '開牌中');
  assert.equal(tableOverlayLabel('MT:B01', '2', 'MT', 'dealing'), '開牌中');
  assert.equal(tableOverlayLabel('AB:B201', undefined, '歐博', 'dealing'), '開牌中');
  assert.equal(tableOverlayLabel('DG:RB01', undefined, 'DG', null), null);
});

test('verified shuffling remains separate from dealing', () => {
  assert.equal(tableOverlayLabel('MT:B01', '2', 'MT'), '洗牌中');
  assert.equal(tableOverlayLabel('AB:B201', '2', '歐博'), '洗牌中');
  assert.equal(tableOverlayLabel('DG:RB01', '2', 'DG'), null);
  assert.equal(tableOverlayLabel('DG:RB01', undefined, 'DG', 'shuffling'), '洗牌中');
});
