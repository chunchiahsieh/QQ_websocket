import test from 'node:test';
import assert from 'node:assert/strict';
import { aiPredictionHistory } from '../lib/ai-prediction-history.ts';
import { summarizeAiShoe } from '../lib/ai-shoe-performance.ts';
import { advanceObservedAi, aiObservationSnapshot, restoreObservedAi } from '../lib/ai-observed-predictions.ts';

const key = 'prediction-history-test';
const candidate = side => ({ side, votes: [{ source: 'deepseek', side }], active: side ? 1 : 0, required: 1 });
const snapshot = outcomes => aiObservationSnapshot(outcomes.map(side => `0${side}`).join(''),
  outcomes.length, false, outcomes.filter(side => side !== '3').length);
const reopen = ledger => {
  const restored = restoreObservedAi(JSON.stringify(ledger), key);
  assert.ok(restored, 'the serialized ledger must survive the real restore validation');
  return restored;
};
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

for (const [saved, recalculated, result, correct, streak, missStreak] of [
  ['1', '2', '命中', 2, 2, 0],
  ['2', '1', '錯誤', 1, 0, 1],
]) test(`restored ${saved === '1' ? 'player hit' : 'banker miss'} overrides contrary replay in history and shoe totals`, () => {
  const pending = advanceObservedAi(undefined, key, snapshot(['2']), candidate(saved));
  const outcomes = ['2', '1'];
  const settled = advanceObservedAi(reopen(pending), key, snapshot(outcomes), candidate(recalculated));
  const reopened = reopen(settled);
  const decisions = replay(outcomes, ['2', recalculated]);
  assert.deepEqual(aiPredictionHistory(decisions, outcomes, reopened)[1], {
    position: 2, prediction: saved, outcome: '1', origin: 'observed', result,
  });
  const performance = summarizeAiShoe(decisions, outcomes, reopened);
  assert.equal(performance.decisions[1].prediction, saved);
  assert.equal(performance.correct, correct);
  assert.equal(performance.streak, streak);
  assert.equal(performance.missStreak, missStreak);
  assert.equal(performance.lastResult, result);
  assert.notEqual(performance.correct, summarizeAiShoe(decisions, outcomes).correct);
  assert.equal(decisions[1].prediction, recalculated, 'replay remains unmodified');
});

test('restored observations retain whole-shoe positions across a tie and the following settlements', () => {
  let ledger = advanceObservedAi(undefined, key, snapshot(['2']), candidate('1'));
  ledger = advanceObservedAi(reopen(ledger), key, snapshot(['2', '3']), candidate('2'));
  ledger = advanceObservedAi(reopen(ledger), key, snapshot(['2', '3', '1']), candidate('1'));
  const outcomes = ['2', '3', '1', '1'];
  ledger = reopen(advanceObservedAi(reopen(ledger), key, snapshot(outcomes), candidate('2')));
  const decisions = replay(outcomes, ['2', '1', '2']);
  assert.deepEqual(aiPredictionHistory(decisions, outcomes, ledger), [
    { position: 1, prediction: '2', outcome: '2', origin: 'replayed', result: '命中' },
    { position: 2, prediction: '1', outcome: '3', origin: 'observed', result: '和局' },
    { position: 3, prediction: '2', outcome: '1', origin: 'observed', result: '錯誤' },
    { position: 4, prediction: '1', outcome: '1', origin: 'observed', result: '命中' },
  ]);
  assert.deepEqual(ledger.decisions.map(record => [record.position, record.nonTiePosition]), [[2, 2], [3, 2], [4, 3]]);
  const performance = summarizeAiShoe(decisions, outcomes, ledger);
  assert.deepEqual(performance.decisions.map(record => record.prediction), ['2', '2', '1']);
  assert.equal(performance.correct, 2);
  assert.equal(performance.ties, 1);
  assert.equal(performance.streak, 1);
  assert.equal(performance.missStreak, 0);
  assert.equal(performance.noSignal, 0);
});

test('a serialized abstention remains observed no-signal after reopening and settlement', () => {
  const pending = advanceObservedAi(undefined, key, snapshot(['2']), candidate(undefined));
  const restored = reopen(pending);
  assert.deepEqual(aiPredictionHistory(replay(['2']), ['2'], restored, true).at(-1), {
    position: 2, prediction: undefined, origin: 'pending', result: '待開獎',
  });
  const outcomes = ['2', '1'];
  const settled = reopen(advanceObservedAi(restored, key, snapshot(outcomes), candidate('1')));
  const decisions = replay(outcomes, ['2', '1']);
  assert.deepEqual(aiPredictionHistory(decisions, outcomes, settled)[1], {
    position: 2, prediction: undefined, outcome: '1', origin: 'observed', result: '無訊號',
  });
  const performance = summarizeAiShoe(decisions, outcomes, settled);
  assert.equal(performance.decisions[1].prediction, undefined);
  assert.equal(performance.correct, 1);
  assert.equal(performance.noSignal, 1);
  assert.equal(performance.lastResult, '無訊號');
  assert.equal(summarizeAiShoe(decisions, outcomes).correct, 2);
});

test('a reopened pending prediction settles once across repeated updates and another reopening', () => {
  const pending = advanceObservedAi(undefined, key, snapshot(['2']), candidate('1'));
  const restored = reopen(pending);
  const unchanged = advanceObservedAi(restored, key, snapshot(['2']), candidate('2'));
  assert.equal(unchanged, restored);
  assert.equal(unchanged.pending.prediction, '1');
  const outcomes = ['2', '1'];
  const settled = advanceObservedAi(unchanged, key, snapshot(outcomes), candidate('2'));
  assert.equal(settled.decisions.length, 1);
  assert.equal(advanceObservedAi(settled, key, snapshot(outcomes), candidate('1')), settled);
  const reopened = reopen(settled);
  assert.equal(advanceObservedAi(reopened, key, snapshot(outcomes), candidate('1')), reopened);
  assert.equal(reopened.decisions.length, 1);
  const decisions = replay(outcomes, ['2', '2']);
  const history = aiPredictionHistory(decisions, outcomes, reopened, true);
  assert.deepEqual(history.map(round => round.position), [1, 2, 3]);
  assert.equal(history.filter(round => round.origin === 'observed').length, 1);
  assert.deepEqual(history.at(-1), { position: 3, prediction: '2', origin: 'pending', result: '待開獎' });
  assert.deepEqual(summarizeAiShoe(decisions, outcomes, reopened), summarizeAiShoe(decisions, outcomes, settled));
  assert.equal(summarizeAiShoe(decisions, outcomes, reopened).correct, 2);
});

test('unrecorded intervening ties do not change hits, misses or no-signal counts', () => {
  for (const predictions of [['2', '1'], ['1', '2'], [undefined, undefined]]) {
    const outcomes = ['2', '1'];
    const tiedOutcomes = ['2', '3', '1'];
    const decisions = replay(outcomes, predictions);
    const before = summarizeAiShoe(decisions, outcomes);
    const after = summarizeAiShoe(decisions, tiedOutcomes);
    for (const metric of ['correct', 'streak', 'missStreak', 'maxStreak', 'maxMissStreak', 'noSignal'])
      assert.equal(after[metric], before[metric], metric);
    assert.equal(after.total, 3);
    assert.equal(after.ties, 1);
    assert.equal(after.accuracy, after.correct / after.total * 100);
  }
});
