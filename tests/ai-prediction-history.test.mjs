import test from 'node:test';
import assert from 'node:assert/strict';
import { aiPredictionHistory } from '../lib/ai-prediction-history.ts';
import { advanceObservedAi, aiObservationSnapshot } from '../lib/ai-observed-predictions.ts';

const key = 'prediction-history-test';
const replay = (outcomes, predictions) => outcomes.filter(outcome => outcome !== '3')
  .map((outcome, index) => ({ outcome, prediction: predictions ? predictions[index] : outcome }));
const savedLedger = (outcomes, records = [], pending) => ({
  version: 2,
  key,
  snapshot: {
    total: outcomes.length,
    nonTieTotal: outcomes.filter(outcome => outcome !== '3').length,
    bankerTotal: outcomes.filter(outcome => outcome === '2').length,
    outcomes: [...outcomes],
    shuffling: false,
  },
  decisions: records.map(record => ({
    outcome: outcomes[record.position - 1],
    agreement: 1,
    activeVotes: 1,
    votes: [{ source: 'deepseek', side: record.prediction }],
    ...record,
  })),
  pending: pending && { agreement: 1, activeVotes: 1, votes: [], ...pending },
});

test('observed banker miss and player hit override contrary replay without rewriting either input', () => {
  const outcomes = ['1', '1'];
  const decisions = replay(outcomes, ['1', '2']);
  const ledger = savedLedger(outcomes, [
    { position: 1, prediction: '2' }, { position: 2, prediction: '1' },
  ]);
  const original = JSON.stringify({ decisions, ledger });
  assert.deepEqual(aiPredictionHistory(decisions, outcomes, ledger), [
    { position: 1, prediction: '2', outcome: '1', origin: 'observed', result: '錯誤' },
    { position: 2, prediction: '1', outcome: '1', origin: 'observed', result: '命中' },
  ]);
  assert.equal(JSON.stringify({ decisions, ledger }), original);
});

test('full round positions include ties without shifting the next non-tie decision', () => {
  const outcomes = ['1', '3', '2', '3', '1'];
  const ledger = savedLedger(outcomes, [
    { position: 3, prediction: '1' }, { position: 4, prediction: '2' },
  ]);
  assert.deepEqual(aiPredictionHistory(replay(outcomes), outcomes, ledger), [
    { position: 1, prediction: '1', outcome: '1', origin: 'replayed', result: '命中' },
    { position: 2, prediction: undefined, outcome: '3', origin: 'unrecorded', result: '和局' },
    { position: 3, prediction: '1', outcome: '2', origin: 'observed', result: '錯誤' },
    { position: 4, prediction: '2', outcome: '3', origin: 'observed', result: '和局' },
    { position: 5, prediction: '1', outcome: '1', origin: 'replayed', result: '命中' },
  ]);
});

test('observed and replayed no-signals stay no-signal instead of being replaced by a hit', () => {
  const outcomes = ['2', '1'];
  const ledger = savedLedger(outcomes, [{ position: 1, prediction: undefined }]);
  assert.deepEqual(aiPredictionHistory(replay(outcomes, ['2', undefined]), outcomes, ledger), [
    { position: 1, prediction: undefined, outcome: '2', origin: 'observed', result: '無訊號' },
    { position: 2, prediction: undefined, outcome: '1', origin: 'replayed', result: '無訊號' },
  ]);
});

test('pending is opt-in and is never mixed with settled outcomes', () => {
  const outcomes = ['2', '1'];
  const ledger = savedLedger(outcomes, [], { position: 3, prediction: '1' });
  const settled = aiPredictionHistory(replay(outcomes), outcomes, ledger);
  const withPending = aiPredictionHistory(replay(outcomes), outcomes, ledger, true);
  assert.equal(settled.length, 2);
  assert.deepEqual(withPending.slice(0, -1), settled);
  assert.deepEqual(withPending.at(-1), {
    position: 3, prediction: '1', origin: 'pending', result: '待開獎',
  });
  assert.equal(Object.hasOwn(withPending.at(-1), 'outcome'), false);
});

test('a pending abstention is retained as a waiting round', () => {
  const ledger = savedLedger([], [], { position: 1, prediction: undefined });
  assert.deepEqual(aiPredictionHistory([], [], ledger, true), [
    { position: 1, prediction: undefined, origin: 'pending', result: '待開獎' },
  ]);
});

test('pending cannot be taken from an older snapshot, wrong round or shuffling snapshot', () => {
  const outcomes = ['2', '1'];
  const old = savedLedger(['2'], [], { position: 2, prediction: '1' });
  const wrong = savedLedger(outcomes, [], { position: 4, prediction: '1' });
  const shuffling = savedLedger(outcomes, [], { position: 3, prediction: '1' });
  shuffling.snapshot.shuffling = true;
  for (const ledger of [old, wrong, shuffling]) {
    assert.equal(aiPredictionHistory(replay(outcomes), outcomes, ledger, true).length, 2);
  }
});

test('a conflicting old shoe is rejected as a whole even if the latest outcome agrees', () => {
  const outcomes = ['1', '1'];
  const oldShoe = savedLedger(['2', '1'], [{ position: 2, prediction: '2' }],
    { position: 3, prediction: '2' });
  assert.deepEqual(aiPredictionHistory(replay(outcomes), outcomes, oldShoe, true),
    aiPredictionHistory(replay(outcomes), outcomes));
});

test('a contradictory saved decision rejects all observations, not only that one row', () => {
  const outcomes = ['1', '2'];
  const ledger = savedLedger(outcomes, [
    { position: 1, prediction: '2', outcome: '2' },
    { position: 2, prediction: '1' },
  ], { position: 3, prediction: '2' });
  assert.deepEqual(aiPredictionHistory(replay(outcomes), outcomes, ledger, true),
    aiPredictionHistory(replay(outcomes), outcomes));
});

test('older compatible observations retain their provenance without claiming later replay was observed', () => {
  const outcomes = ['2', '1', '2', '1'];
  const ledger = savedLedger(['2', '1'], [{ position: 2, prediction: '1' }]);
  const history = aiPredictionHistory(replay(outcomes), outcomes, ledger, true);
  assert.deepEqual(history.map(round => round.origin), ['replayed', 'observed', 'replayed', 'replayed']);
  assert.equal(history.length, outcomes.length);
});

test('partial, contradictory or tie-indexed replay is unavailable rather than fabricated history', () => {
  assert.equal(aiPredictionHistory([{ prediction: '2', outcome: '2' }], ['2', '1']), undefined);
  assert.equal(aiPredictionHistory([{ prediction: '2', outcome: '1' }], ['2']), undefined);
  assert.equal(aiPredictionHistory([{ prediction: '2', outcome: '3' }], ['3']), undefined);
});

test('empty and unobserved all-tie shoes do not invent prediction sides', () => {
  assert.deepEqual(aiPredictionHistory([], []), []);
  assert.deepEqual(aiPredictionHistory([], ['3', '3']), [
    { position: 1, prediction: undefined, outcome: '3', origin: 'unrecorded', result: '和局' },
    { position: 2, prediction: undefined, outcome: '3', origin: 'unrecorded', result: '和局' },
  ]);
});

test('a same-round recalculation cannot replace the displayed pending vote or its later verdict', () => {
  const candidate = side => ({ side, votes: [{ source: 'deepseek', side }], active: 1, required: 1 });
  const snapshot = outcomes => aiObservationSnapshot(outcomes.map(side => `0${side}`).join(''),
    outcomes.length, false, outcomes.filter(side => side !== '3').length);
  let ledger = advanceObservedAi(undefined, key, snapshot(['2']), candidate('1'));
  ledger = advanceObservedAi(ledger, key, snapshot(['2']), candidate('2'));
  assert.equal(aiPredictionHistory(replay(['2']), ['2'], ledger, true).at(-1).prediction, '1');
  ledger = advanceObservedAi(ledger, key, snapshot(['2', '1']), candidate('2'));
  const history = aiPredictionHistory(replay(['2', '1'], ['2', '2']), ['2', '1'], ledger, true);
  assert.deepEqual(history[1], {
    position: 2, prediction: '1', outcome: '1', origin: 'observed', result: '命中',
  });
  assert.deepEqual(history[2], {
    position: 3, prediction: '2', origin: 'pending', result: '待開獎',
  });
});
