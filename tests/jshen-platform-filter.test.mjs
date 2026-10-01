import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePickPlatforms, pickPlatforms, selectedPlatformTables, togglePickPlatform } from '../lib/jshen-platform-filter.ts';

test('default and malformed preferences select all three platforms', () => {
  for (const stored of [null, '', '{broken', 'null', '{}', '[]', '["unknown"]']) {
    assert.deepEqual(parsePickPlatforms(stored), ['MT', 'DG', 'AB']);
  }
});

test('saved selections restore in canonical order without duplicate or unknown platforms', () => {
  for (const selected of [['MT'], ['DG'], ['AB'], ['MT', 'DG'], ['MT', 'AB'], ['DG', 'AB'], [...pickPlatforms]]) {
    assert.deepEqual(parsePickPlatforms(JSON.stringify(selected)), selected);
  }
  assert.deepEqual(parsePickPlatforms('["AB","DG","DG","unknown"]'), ['DG', 'AB']);
});

test('individual toggles support multi-select but cannot remove the last platform', () => {
  let selected = togglePickPlatform([...pickPlatforms], 'AB');
  assert.deepEqual(selected, ['MT', 'DG']);
  selected = togglePickPlatform(selected, 'MT');
  assert.deepEqual(selected, ['DG']);
  assert.deepEqual(togglePickPlatform(selected, 'DG'), ['DG']);
  assert.deepEqual(togglePickPlatform(selected, 'MT'), ['MT', 'DG']);
});

const tables = {
  MT: Array.from({ length: 8 }, (_, index) => ({ id: `MT-${index}`, score: 20 - index })),
  DG: [{ id: 'DG-1', score: 100 }, { id: 'DG-2', score: 90 }],
  AB: [{ id: 'AB-1', score: 200 }],
};
const topSix = selected => selectedPlatformTables(tables, selected).flatMap(([, values]) => values)
  .sort((a, b) => b.score - a.score).slice(0, 6);

test('filtering before top six fills all six places from the chosen platform', () => {
  assert.deepEqual(topSix(['MT']).map(table => table.id), ['MT-0', 'MT-1', 'MT-2', 'MT-3', 'MT-4', 'MT-5']);
});

test('multi-platform ranking excludes unselected higher-scoring tables', () => {
  assert.deepEqual(topSix(['MT', 'DG']).map(table => table.id), ['DG-1', 'DG-2', 'MT-0', 'MT-1', 'MT-2', 'MT-3']);
});

test('fewer than six selected candidates never backfills another platform or changes source data', () => {
  const before = structuredClone(tables);
  assert.deepEqual(topSix(['DG']).map(table => table.id), ['DG-1', 'DG-2']);
  assert.deepEqual(topSix(['AB']).map(table => table.id), ['AB-1']);
  assert.deepEqual(selectedPlatformTables(tables, ['DG']), [['DG', tables.DG]]);
  assert.deepEqual(tables, before);
});
