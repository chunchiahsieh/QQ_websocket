import test from 'node:test';
import assert from 'node:assert/strict';
import { initialBettingLedger, settleBet } from '../lib/betting-strategy.ts';
import { baccaratRoads } from '../lib/dg-card.ts';
import { advanceLiveBetting, liveBettingSnapshot } from '../lib/live-betting.ts';

const snapshot = winners => liveBettingSnapshot(baccaratRoads(winners));
const state = (round, side = '1', ledger = initialBettingLedger()) => ({
  shoe: 'shoe-1', lastSettledRound: round, pendingPrediction: { round, side }, ledger,
});
const threeUnits = () => {
  let ledger = initialBettingLedger();
  ledger = settleBet('dalembert', ledger, '1', '2');
  return settleBet('dalembert', ledger, '1', '2');
};

test('DG settlement continues from round 36 through round 47 while the bead window stays at 36', () => {
  const winners = Array(36).fill(1);
  let current = state(36, '1', threeUnits());
  for (let round = 37; round <= 47; round++) {
    winners.push(2);
    const table = baccaratRoads(winners);
    assert.equal(table.beadPlate.split('#').join('').length / 2, 36);
    const nextSnapshot = liveBettingSnapshot(table);
    assert.equal(nextSnapshot.total, round);
    assert.equal(nextSnapshot.outcomes.length, round);
    current = advanceLiveBetting(current, 'dalembert', 'shoe-1', nextSnapshot);
    assert.equal(current.ledger.nextStake, 3 + round - 36);
    assert.equal(current.lastSettledRound, round);
    current = { ...current, pendingPrediction: { round, side: '1' } };
  }
  assert.equal(current.ledger.bets, 13);
});

test('a displayed three-unit d Alembert stake becomes four after a loss and three after a win', () => {
  let current = state(2, '1', threeUnits());
  current = advanceLiveBetting(current, 'dalembert', 'shoe-1', snapshot([2, 2, 2]));
  assert.equal(current.ledger.nextStake, 4);
  current = { ...current, pendingPrediction: { round: 3, side: '1' } };
  current = advanceLiveBetting(current, 'dalembert', 'shoe-1', snapshot([2, 2, 2, 1]));
  assert.equal(current.ledger.nextStake, 3);
  assert.equal(current.ledger.bets, 4);
});

test('child prediction callbacks settle the old direction before capturing the next one, then the parent is idempotent', () => {
  const incoming = snapshot([1, 2]);
  let current = state(1, '1', threeUnits());
  current = advanceLiveBetting(current, 'dalembert', 'shoe-1', incoming);
  current = { ...current, pendingPrediction: { round: 2, side: '2' } };
  assert.equal(current.ledger.nextStake, 4, 'round 2 loses the previously displayed player bet');
  const afterParent = advanceLiveBetting(current, 'dalembert', 'shoe-1', incoming);
  assert.equal(afterParent, current, 'the later parent effect cannot settle a second time');
  current = advanceLiveBetting(afterParent, 'dalembert', 'shoe-1', snapshot([1, 2, 2]));
  assert.equal(current.ledger.nextStake, 3, 'round 3 wins the newly captured banker bet');
  assert.equal(current.ledger.bets, 4);
});

test('ties and abstentions advance the completed-round cursor without changing the stake or ledger', () => {
  for (const [side, outcome] of [['1', 3], [undefined, 2]]) {
    const before = { ...state(1, side, threeUnits()), pendingPrediction: { round: 1, side } };
    const next = advanceLiveBetting(before, 'dalembert', 'shoe-1', snapshot([1, outcome]));
    assert.equal(next.lastSettledRound, 2);
    assert.equal(next.ledger, before.ledger);
    assert.equal(next.ledger.nextStake, 3);
  }
});

test('reconnecting across several results settles only the one recorded pending prediction at its actual position', () => {
  const before = state(2, '1', threeUnits());
  const incoming = snapshot([2, 2, 2, 1, 1, 1]);
  const next = advanceLiveBetting(before, 'dalembert', 'shoe-1', incoming);
  assert.equal(next.lastSettledRound, 6);
  assert.equal(next.ledger.nextStake, 4, 'the locked round 3 loss must not be replaced by the latest round 6 win');
  assert.equal(next.ledger.bets, before.ledger.bets + 1);
  assert.equal(advanceLiveBetting(next, 'dalembert', 'shoe-1', incoming), next);
});

test('a 36-result tail without full outcomes resolves pending bets using absolute round positions', () => {
  const winners = [...Array(40).fill(1), 2, ...Array(6).fill(1)];
  const table = baccaratRoads(winners);
  delete table.aiOutcomes;
  const incoming = liveBettingSnapshot(table);
  assert.equal(incoming.total, 47);
  assert.equal(incoming.outcomes.length, 36);
  const before = state(40, '1', threeUnits());
  const next = advanceLiveBetting(before, 'dalembert', 'shoe-1', incoming);
  assert.equal(next.ledger.nextStake, 4, 'settle round 41, not the latest result or tail-relative position');
  assert.equal(next.ledger.bets, before.ledger.bets + 1);
});

test('a reconnect whose tail no longer includes the pending outcome does not invent a bet', () => {
  const table = baccaratRoads(Array(47).fill(2));
  delete table.aiOutcomes;
  const before = state(1, '1', threeUnits());
  const next = advanceLiveBetting(before, 'dalembert', 'shoe-1', liveBettingSnapshot(table));
  assert.equal(next.lastSettledRound, 47);
  assert.equal(next.ledger, before.ledger);
});

test('partial or inconsistent table updates do not advance settlement or discard the pending prediction', () => {
  const before = state(2, '1', threeUnits());
  const partial = baccaratRoads([1, 2]);
  partial.banker = '2';
  const incoming = liveBettingSnapshot(partial);
  assert.equal(incoming, undefined);
  assert.equal(advanceLiveBetting(before, 'dalembert', 'shoe-1', incoming), before);
  assert.equal(advanceLiveBetting(before, 'dalembert', 'shoe-1', undefined), before);

  const mismatched = baccaratRoads([1, 2]);
  mismatched.bigRoad = baccaratRoads([2, 1]).bigRoad;
  assert.equal(liveBettingSnapshot(mismatched), undefined);
});

test('duplicate and older snapshots cannot double-settle or rewind the live ledger', () => {
  const before = state(3, '1', threeUnits());
  for (const incoming of [snapshot([1, 2, 1]), snapshot([1, 2])]) {
    assert.equal(advanceLiveBetting(before, 'dalembert', 'shoe-1', incoming), before);
  }
});

test('a new shoe discards the prior pending bet, rebases the cursor, and preserves the ledger since reset', () => {
  const before = state(47, '1', threeUnits());
  const rebased = advanceLiveBetting(before, 'dalembert', 'shoe-2', snapshot([2]));
  assert.equal(rebased.shoe, 'shoe-2');
  assert.equal(rebased.lastSettledRound, 1);
  assert.deepEqual(rebased.pendingPrediction, { round: 1 });
  assert.equal(rebased.ledger, before.ledger);

  const captured = { ...rebased, pendingPrediction: { round: 1, side: '2' } };
  const next = advanceLiveBetting(captured, 'dalembert', 'shoe-2', snapshot([2, 2]));
  assert.equal(next.ledger.nextStake, 2);
  assert.equal(next.ledger.bets, before.ledger.bets + 1);
});

test('manual reset remains effective when subsequent callbacks settle the next round', () => {
  const resetLedger = initialBettingLedger();
  const resetState = state(40, '1', resetLedger);
  const winners = [...Array(40).fill(1), 2];
  const next = advanceLiveBetting(resetState, 'dalembert', 'shoe-1', snapshot(winners));
  assert.equal(next.ledger.nextStake, 2);
  assert.equal(next.ledger.bets, 1);
  assert.equal(next.ledger.profit, -1);
});
