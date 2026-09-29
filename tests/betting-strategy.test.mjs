import test from 'node:test';
import assert from 'node:assert/strict';
import { initialBettingLedger, replayBets, settleBet } from '../lib/betting-strategy.ts';

test('fixed stake ignores no-signal and ties, and applies banker commission', () => {
  const initial = initialBettingLedger();
  assert.deepEqual(settleBet('flat', initial, undefined, '2'), initial);
  assert.deepEqual(settleBet('flat', initial, '2', '3'), initial);
  const won = settleBet('flat', initial, '2', '2');
  assert.equal(won.profit, 0.95);
  assert.equal(won.wins, 1);
  assert.equal(won.nextStake, 1);
});

test('1-3-2-6 advances on wins and resets on a loss', () => {
  let ledger = initialBettingLedger();
  ledger = settleBet('1326', ledger, '1', '1');
  assert.equal(ledger.nextStake, 3);
  ledger = settleBet('1326', ledger, '1', '1');
  assert.equal(ledger.nextStake, 2);
  ledger = settleBet('1326', ledger, '1', '2');
  assert.equal(ledger.nextStake, 1);
});

test('d Alembert raises after loss and lowers after win', () => {
  let ledger = initialBettingLedger();
  ledger = settleBet('dalembert', ledger, '1', '2');
  assert.equal(ledger.nextStake, 2);
  ledger = settleBet('dalembert', ledger, '1', '1');
  assert.equal(ledger.nextStake, 1);
  assert.equal(ledger.bets, 2);
});

test('Martingale doubles after losses and resets after a win', () => {
  let ledger = initialBettingLedger();
  ledger = settleBet('martingale', ledger, '1', '2');
  assert.equal(ledger.nextStake, 2);
  ledger = settleBet('martingale', ledger, '1', '2');
  assert.equal(ledger.nextStake, 4);
  ledger = settleBet('martingale', ledger, '1', '1');
  assert.equal(ledger.nextStake, 1);
  assert.equal(ledger.bets, 3);
});

test('shoe history can be replayed independently from a reset ledger', () => {
  const history = [
    { prediction: '1', outcome: '1' },
    { prediction: undefined, outcome: '2' },
    { prediction: '2', outcome: '2' },
  ];
  const shoe = replayBets('flat', history);
  assert.equal(shoe.bets, 2);
  assert.equal(shoe.wins, 2);
  assert.equal(shoe.profit, 1.95);
  assert.deepEqual(initialBettingLedger(), { step: 0, nextStake: 1, profit: 0, bets: 0, wins: 0, losses: 0 });
});
