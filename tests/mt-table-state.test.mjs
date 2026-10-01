import assert from 'node:assert/strict';
import { test } from 'node:test';
import { filterMtUpdate, mtMergeBase, synchronizeMtClocks } from '../lib/mt-table-state.ts';
import { baccaratRoads } from '../lib/dg-card.ts';
import { aiSources, completeAiConsensus } from '../lib/ai-consensus.ts';
import { aiObservationIdentity, aiObservationSnapshot, advanceObservedAi, restoreObservedAi } from '../lib/ai-observed-predictions.ts';
import { completeAiHistory } from '../lib/ai-complete-history.ts';
import { bettingStrategyLabels, replayBets } from '../lib/betting-strategy.ts';

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

const merge = (previous, incoming) => {
  const update = filterMtUpdate(previous, incoming);
  return { ...mtMergeBase(previous, update), ...update };
};
const roadTable = (shoe, winners, extra = {}) => ({
  ...clock, ...baccaratRoads(winners), shoe, round: String(winners.length),
  // MT supplies the full bead sequence, not DG's last-36 display window.
  beadPlate: winners.map(winner => `0${winner}`).join(''), ...extra,
});

test('a confirmed new-shoe snapshot replaces old wait/end identity and roads together', () => {
  for (const countdownSource of ['wait', 'end']) {
    const previous = roadTable('646', Array(56).fill(2), { countdownSource });
    const incoming = roadTable('647', [1, 1, 2], {
      mtEvent: 'snapshot', countdownSource: 'snapshot', countdownRound: 'shoe647-3',
      countdownValue: 15, countdownDeadline: 40000, countdownReceivedAt: 25000,
    });
    const result = merge(previous, incoming);
    assert.equal(result.shoe, '647');
    assert.equal(result.round, '3');
    assert.equal(result.bigRoad, incoming.bigRoad);
    assert.equal(result.beadPlate, incoming.beadPlate);
    assert.equal(result.countdownValue, 15);
    assert.equal(result.countdownDeadline, 40000);
    assert.equal(result.countdownSource, 'snapshot');
    assert.equal(result.banker, '1');
    assert.equal(result.player, '2');
  }
});

test('new shoe without full roads or timer never falls back to old shoe fields', () => {
  const previous = roadTable('646', Array(56).fill(2), { dealer: 'Original', tableState: '2', tablePhase: 'dealing' });
  const result = merge(previous, { id: clock.id, shoe: '647', round: '1', mtEvent: 'wait' });
  assert.equal(result.shoe, '647');
  assert.equal(result.dealer, 'Original');
  for (const key of ['banker', 'player', 'tie', 'beadPlate', 'aiOutcomes', 'bigRoad',
    'countdownValue', 'countdownDeadline', 'countdownReceivedAt', 'countdownRound', 'countdownSource', 'tableState', 'tablePhase']) {
    assert.equal(result[key], undefined, `${key} cannot be inherited from the previous shoe`);
  }
});

test('late previous-shoe packets cannot restore old roads, identity or full outcomes', () => {
  const current = roadTable('647', [1, 1, 2], { countdownRound: 'shoe647-3' });
  const stale = roadTable('646', Array(56).fill(2), { mtEvent: 'snapshot', countdownSource: 'snapshot' });
  assert.deepEqual(merge(current, stale), current);
});

test('live aliases advance with the source shoe without inheriting old roads or timer residue', () => {
  const source = { id: clock.id, shoe: '647', round: '1', mtEvent: 'snapshot' };
  const oldAlias = { ...roadTable('646', Array(56).fill(2)), ...live };
  const result = synchronizeMtClocks([source, oldAlias])[1];
  assert.equal(result.shoe, '647');
  assert.equal(result.round, '1');
  assert.equal(result.dealer, live.dealer);
  assert.equal(result.videoUrl, live.videoUrl);
  assert.equal(result.bigRoad, '');
  assert.equal(result.banker, '0');
  assert.equal(result.aiOutcomes, undefined);
  assert.equal(result.countdownDeadline, undefined);
  assert.equal(result.countdownSource, undefined);
});

test('an alias already on the new shoe is not rewound by an older source', () => {
  const source = roadTable('646', Array(56).fill(2));
  const alias = { ...roadTable('647', [1, 1, 2]), ...live };
  assert.deepEqual(synchronizeMtClocks([source, alias])[1], alias);
  const matchingSource = roadTable('647', [1, 1, 2], { countdownValue: 8 });
  const result = synchronizeMtClocks([matchingSource, alias])[1];
  assert.equal(result.bigRoad, alias.bigRoad);
  assert.equal(result.beadPlate, alias.beadPlate);
  assert.equal(result.countdownValue, 8);
});

test('all AI sources discard the previous 56-round ledger and show the exact new-shoe sequence', () => {
  const oldTable = roadTable('646', Array.from({ length: 56 }, (_, i) => [3, 2, 1, 2][i % 4]));
  const newWinners = [1, 1, 2, 1, 1, 2, 1, 2, 2, 2, 2];
  const snapshot = table => aiObservationSnapshot(table.beadPlate,
    Number(table.banker) + Number(table.player) + Number(table.tie), false,
    Number(table.banker) + Number(table.player), { road: table.bigRoad, bankerTotal: Number(table.banker) });
  for (const selected of [...aiSources.map(source => [source]), aiSources]) {
    const mode = selected.length === 1 ? selected[0] : 'ai-consensus';
    const key = table => aiObservationIdentity(table.id, table.shoe, mode, selected, 'test-feed').key;
    let ledger = advanceObservedAi(undefined, key(oldTable), snapshot(oldTable), completeAiConsensus(oldTable.bigRoad, selected), true);
    const saved = JSON.stringify(ledger);
    let table = oldTable;
    for (const count of [3, 8, 11]) {
      const incoming = roadTable('647', newWinners.slice(0, count), { mtEvent: 'snapshot', countdownSource: 'snapshot' });
      table = merge(table, incoming);
      assert.notEqual(key(table), key(oldTable), `${mode}: new shoe must not reuse its old key`);
      assert.equal(restoreObservedAi(saved, key(table)), undefined, `${mode}: old persisted ledger must not restore`);
      ledger = advanceObservedAi(ledger, key(table), snapshot(table), completeAiConsensus(table.bigRoad, selected), true);
      assert.equal(ledger.snapshot.total, count);
      assert.equal(ledger.pending.position, count + 1);
      assert.ok(ledger.decisions.every(record => record.position <= count));
      const result = completeAiHistory(ledger.snapshot.road, selected, ledger.snapshot.outcomes, ledger);
      assert.equal(result.performance.total, count);
      assert.deepEqual(result.history.map(round => round.outcome), newWinners.slice(0, count).map(String));
      assert.deepEqual(result.history.map(round => round.position), Array.from({ length: count }, (_, i) => i + 1));
      for (const strategy of Object.keys(bettingStrategyLabels)) {
        const shoeBets = replayBets(strategy, result.performance.decisions);
        assert.equal(shoeBets.bets, count, `${mode}/${strategy}: current-shoe profit must use only the new rounds`);
      }
      if (count === 3) {
        assert.equal(ledger.decisions.length, 0, 'old observed streaks must not cross the shoe boundary');
        assert.deepEqual(result.performance, completeAiHistory(incoming.bigRoad, selected, newWinners.slice(0, count).map(String)).performance);
      }
    }
  }
});
