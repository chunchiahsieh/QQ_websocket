import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dgCard } from '../lib/dg-card.ts';
import { tableOverlayLabel } from '../lib/table-state.ts';

test('DG official state 8 shows shuffle without using MT state rules', () => {
  const shuffling = dgCard({ tableId: '100', state: 8, roads: [] });
  assert.equal(shuffling.tablePhase, 'shuffling');
  assert.equal(tableOverlayLabel(shuffling.id, undefined, 'DG', shuffling.tablePhase), '洗牌中');

  for (const state of [2, 3, 4]) {
    const dealing = dgCard({ tableId: '100', state, roads: [] });
    assert.equal(dealing.tablePhase, 'dealing');
    assert.equal(tableOverlayLabel(dealing.id, undefined, 'DG', dealing.tablePhase), '開牌中');
  }
  const countdown = dgCard({ tableId: '100', state: 1, roads: [] });
  assert.equal(tableOverlayLabel(countdown.id, undefined, 'DG', countdown.tablePhase), null);
});
