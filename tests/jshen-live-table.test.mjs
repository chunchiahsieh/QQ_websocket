import test from 'node:test';
import assert from 'node:assert/strict';
import { findLivePickTable } from '../lib/jshen-live-table.ts';

test('ranked cards resolve current results and clocks without changing the frozen ranking record', () => {
  const ranked = { id: 'BAV01', shoe: 'shoe-1', round: '20', bigRoad: 'old-road', countdownValue: 15 };
  const live = { ...ranked, round: '21', bigRoad: 'current-road', countdownValue: 9 };
  const resolved = findLivePickTable({ MT: [live] }, 'MT', ranked.id);
  assert.equal(resolved, live);
  assert.equal(resolved.round, '21');
  assert.equal(resolved.countdownValue, 9);
  assert.equal(ranked.round, '20');
});

test('international and live-hall IDs remain exact and are never substituted', () => {
  const international = { id: 'BAV01', dealer: 'international' };
  const liveHall = { id: 'BAV01_LIVE', dealer: 'live-hall' };
  const tables = { MT: [liveHall, international] };
  assert.equal(findLivePickTable(tables, 'MT', 'BAV01'), international);
  assert.equal(findLivePickTable(tables, 'MT', 'BAV01_LIVE'), liveHall);
  assert.equal(findLivePickTable({ MT: [international] }, 'MT', 'BAV01_LIVE'), undefined);
  assert.equal(findLivePickTable({ MT: [liveHall] }, 'MT', 'BAV01'), undefined);
});

test('same IDs from another platform cannot supply a ranked card', () => {
  const mt = { id: '001', shoe: 'mt-shoe' };
  const dg = { id: '001', shoe: 'dg-shoe' };
  assert.equal(findLivePickTable({ MT: [mt], DG: [dg] }, 'DG', '001'), dg);
  assert.equal(findLivePickTable({ MT: [mt] }, 'DG', '001'), undefined);
});

test('new shoes use the live record and missing tables never return the old ranked shoe', () => {
  const ranked = { id: 'BAV01', shoe: 'old-shoe', round: '60' };
  const live = { id: 'BAV01', shoe: 'new-shoe', round: '1' };
  assert.equal(findLivePickTable({ MT: [live] }, 'MT', ranked.id), live);
  assert.equal(findLivePickTable({ MT: [] }, 'MT', ranked.id), undefined);
  assert.equal(findLivePickTable({}, 'MT', ranked.id), undefined);
});
