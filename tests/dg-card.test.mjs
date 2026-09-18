import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dgRoads, dgCard } from '../lib/dg-card.ts';
test('DG history is chronological top-to-bottom with independent totals', () => {
  const roads = dgRoads(['4#5', '3#9', '2#1', '1#2']);
  assert.equal(roads.beadPlate, '02020301');
  assert.equal(roads.banker, '2'); assert.equal(roads.player, '1'); assert.equal(roads.tie, '1');
  assert.equal(roads.bigRoad, '0?02,1?02,,,,#0?01,,,,,');
});
test('long streak turns right on bottom row instead of overflowing', () => {
  const roads = dgRoads(Array.from({length:8}, (_, i) => `${8-i}#1`));
  const cols = roads.bigRoad.split('#');
  assert.equal(cols.length, 3);
  assert.equal(cols[1].split(',')[5], '0?02');
  assert.equal(cols[2].split(',')[5], '0?02');
});
test('bead window has at most six columns and ignores invalid results', () => {
  const r = dgRoads(['invalid', '1#99', ...Array.from({length:50}, (_, i) => `${i}#5`)]);
  assert.equal(r.beadPlate.split('#').length, 6);
  assert.equal(r.player, '50');
});
test('empty table does not invent scores or shuffling state', () => {
  const card = dgCard({tableId:'1', state:2, onlineCount:0, roads:[]});
  assert.equal(card.id, 'DG:1'); assert.equal(card.players, '0');
  assert.equal(card.bigRoad, ''); assert.equal(card.tableState, undefined);
});
