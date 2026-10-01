import assert from 'node:assert/strict';
import { test } from 'node:test';
import { filterMtUpdate, synchronizeMtClocks } from '../lib/mt-table-state.ts';

const clock = { id: 'BAV01', sourceTableId: 'BAV01', shoe: '646', round: '53', countdownRound: 'game53', countdownSource: 'wait', countdownValue: 20, countdownDeadline: 21000, countdownReceivedAt: 1000, tablePhase: null };
const live = { id: 'BAV01_LIVE', sourceTableId: 'BAV01', dealer: 'DORA', videoUrl: 'https://example.test/live.flv' };

test('official table_id_t aliases share one clock without replacing presentation or guessing a suffix', () => {
  const result = synchronizeMtClocks([live, clock, { id: 'BAV02_LIVE', sourceTableId: 'BAV02' }, { id: 'BAV01_LIVE_UNKNOWN' }]);
  assert.equal(result[0].countdownDeadline, 21000);
  assert.equal(result[0].countdownValue, 20);
  assert.equal(result[0].dealer, 'DORA');
  assert.equal(result[0].videoUrl, live.videoUrl);
  assert.equal(result[2].countdownDeadline, undefined);
  assert.equal(result[3].countdownDeadline, undefined);
});

test('stale lobby snapshot cannot reset a live countdown or dealing state', () => {
  const merged = { ...clock, ...filterMtUpdate(clock, { id: clock.id, mtEvent: 'snapshot', countdownSource: 'snapshot', countdownValue: 0, countdownDeadline: 5000, countdownRound: 'game53', tablePhase: 'dealing', banker: '20' }) };
  assert.equal(merged.countdownValue, 20);
  assert.equal(merged.countdownDeadline, 21000);
  assert.equal(merged.tablePhase, null);
  assert.equal(merged.banker, '20');
});

test('same-round duplicates cannot extend a deadline; new games restart normally', () => {
  const duplicate = { ...clock, ...filterMtUpdate(clock, { ...clock, countdownReceivedAt: 3000, countdownDeadline: 23000 }) };
  assert.equal(duplicate.countdownDeadline, 21000);
  assert.equal(duplicate.countdownReceivedAt, 1000);
  const lower = { ...clock, ...filterMtUpdate(clock, { ...clock, countdownValue: 19, countdownReceivedAt: 4000, countdownDeadline: 23000 }) };
  assert.equal(lower.countdownDeadline, 21000);
  const ended = { ...clock, countdownValue: 0, countdownSource: 'end', countdownDeadline: 21000, tablePhase: 'dealing' };
  const restartSameGame = { ...ended, ...filterMtUpdate(ended, { ...clock, countdownReceivedAt: 30000, countdownDeadline: 50000 }) };
  assert.equal(restartSameGame.countdownValue, 0);
  const newGame = { ...ended, ...filterMtUpdate(ended, { ...clock, round: '54', countdownRound: 'game54', countdownDeadline: 50000 }) };
  assert.equal(newGame.countdownValue, 20);
  assert.equal(newGame.countdownDeadline, 50000);
});

test('an older source round cannot rewind roads or a clock', () => {
  const update = filterMtUpdate(clock, { id: clock.id, shoe: '646', round: '52', countdownRound: 'game52', countdownSource: 'wait', countdownValue: 7, bigRoad: 'old' });
  assert.equal(update.countdownValue, undefined);
  assert.equal(update.bigRoad, undefined);
});

test('the first positive official wait clears a previous shuffle for both presentations', () => {
  const shuffled = { ...clock, tableState: '2', countdownSource: 'snapshot', countdownValue: 0, tablePhase: null };
  const waiting = { ...shuffled, ...filterMtUpdate(shuffled, { ...clock, tableState: '0', countdownRound: 'new-shoe-game', mtEvent: 'wait' }) };
  const tables = synchronizeMtClocks([waiting, { ...live, tableState: '2' }]);
  assert.equal(tables[0].tableState, '0');
  assert.equal(tables[1].tableState, '0');
  assert.equal(tables[1].countdownValue, 20);
});
