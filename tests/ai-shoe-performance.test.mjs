import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeAiShoe } from '../lib/ai-shoe-performance.ts';
import { aiObservationKey } from '../lib/ai-observed-predictions.ts';

const key = aiObservationKey('MT:001', 'shoe-1', 'deepseek', ['deepseek']);
const replay = (outcomes, predictions) => outcomes.filter(side => side !== '3').map((outcome, index) => ({
  prediction: predictions?.[index] ?? outcome,
  outcome,
  agreement: 1,
  activeVotes: 1,
}));
const savedLedger = (outcomes, records = []) => ({
  version: 2,
  key,
  snapshot: {
    total: outcomes.length,
    nonTieTotal: outcomes.filter(side => side !== '3').length,
    bankerTotal: outcomes.filter(side => side === '2').length,
    outcomes,
    shuffling: false,
  },
  decisions: records.map(record => ({
    nonTiePosition: outcomes.slice(0, record.position).filter(side => side !== '3').length,
    outcome: outcomes[record.position - 1],
    agreement: 1,
    activeVotes: 1,
    votes: [{ source: 'deepseek', side: record.prediction }],
    ...record,
  })),
});

test('whole-shoe counters include history before the card opened and separate current from maximum runs', () => {
  const outcomes = Array(10).fill('2');
  const simulated = replay(outcomes, ['2', '2', '1', '1', '2', '2', '2', '1', '1', '1']);
  const performance = summarizeAiShoe(simulated, outcomes);
  assert.ok(performance);
  assert.equal(performance.total, 10);
  assert.equal(performance.correct, 5);
  assert.equal(performance.accuracy, 50);
  assert.equal(performance.streak, 0);
  assert.equal(performance.missStreak, 3);
  assert.equal(performance.maxStreak, 3);
  assert.equal(performance.maxMissStreak, 3);
  assert.equal(performance.lastResult, '錯誤');

  const hit = summarizeAiShoe([...simulated, { prediction: '1', outcome: '1' }], [...outcomes, '1']);
  assert.equal(hit.streak, 1);
  assert.equal(hit.missStreak, 0);
  assert.equal(hit.maxStreak, 3);
  assert.equal(hit.maxMissStreak, 3);
});

test('ties do not increment or reset hit/miss runs, including a trailing tie', () => {
  const outcomes = ['2', '3', '2', '1', '3', '1', '3'];
  const simulated = replay(outcomes, ['2', '2', '2', '2']);
  const performance = summarizeAiShoe(simulated, outcomes);
  assert.ok(performance);
  assert.equal(performance.total, 7);
  assert.equal(performance.ties, 3);
  assert.equal(performance.correct, 2);
  assert.equal(performance.accuracy, 2 / 7 * 100);
  assert.equal(performance.streak, 0);
  assert.equal(performance.missStreak, 2);
  assert.equal(performance.maxStreak, 2);
  assert.equal(performance.maxMissStreak, 2);
  assert.equal(performance.lastResult, '和局');
  assert.deepEqual(performance.decisions, simulated, 'betting replay stays indexed by non-tie results');
});

test('full-shoe totals do not collapse to the last 36 displayed beads', () => {
  const outcomes = [...Array(42).fill('2'), '1'];
  const simulated = replay(outcomes, Array(43).fill('2'));
  const performance = summarizeAiShoe(simulated, outcomes);
  assert.ok(performance);
  assert.equal(performance.total, 43);
  assert.equal(performance.correct, 42);
  assert.equal(performance.maxStreak, 42);
  assert.equal(performance.streak, 0);
  assert.equal(performance.missStreak, 1);
});

test('saved failed predictions override replayed hits using full positions across ties and recompute maxima', () => {
  const outcomes = ['2', '3', '2', '2', '3', '2', '2'];
  const simulated = replay(outcomes);
  const ledger = savedLedger(outcomes, [{ position: 4, prediction: '1' }, { position: 7, prediction: '1' }]);
  const performance = summarizeAiShoe(simulated, outcomes, ledger);
  assert.ok(performance);
  assert.equal(performance.correct, 3);
  assert.equal(performance.streak, 0);
  assert.equal(performance.missStreak, 1);
  assert.equal(performance.maxStreak, 2, 'the historical maximum must be recalculated after locked failures are applied');
  assert.equal(performance.maxMissStreak, 1);
  assert.equal(performance.lastResult, '錯誤');
  assert.deepEqual(performance.decisions.map(decision => decision.prediction), ['2', '2', '1', '2', '1']);
  assert.deepEqual(simulated.map(decision => decision.prediction), Array(5).fill('2'), 'the shared replay input is immutable');
  assert.deepEqual(summarizeAiShoe(simulated, outcomes, JSON.parse(JSON.stringify(ledger))), performance,
    'restoring the same saved ledger cannot change counters');
});

test('saved no-signal is kept as no-signal instead of being replaced by a retroactive hit', () => {
  const outcomes = ['2', '2', '3', '2'];
  const ledger = savedLedger(outcomes, [{ position: 2, prediction: undefined }]);
  const performance = summarizeAiShoe(replay(outcomes), outcomes, ledger);
  assert.ok(performance);
  assert.equal(performance.correct, 2);
  assert.equal(performance.noSignal, 1);
  assert.equal(performance.accuracy, 50, 'the denominator is all completed shoe rounds');
  assert.equal(performance.decisions[1].prediction, undefined);
  assert.equal(performance.streak, 2, 'no-signal is neither a win nor a loss');
});

test('individual source counters use the recorded source vote, not its consensus vote', () => {
  const outcomes = ['2', '3', '1'];
  const ledger = savedLedger(outcomes, [{
    position: 3,
    prediction: '1',
    votes: [{ source: 'deepseek', side: '2' }, { source: 'claude', side: '1' }],
    activeVotes: 2,
  }]);
  const performance = summarizeAiShoe(replay(outcomes), outcomes, ledger, 'deepseek');
  assert.ok(performance);
  assert.equal(performance.correct, 1);
  assert.equal(performance.lastResult, '錯誤');
  assert.equal(performance.decisions[1].prediction, '2');
});

test('a source absent from a saved consensus vote leaves that source replay unchanged', () => {
  const outcomes = ['2', '1'];
  const simulated = replay(outcomes);
  const ledger = savedLedger(outcomes, [{ position: 2, prediction: '2', votes: [{ source: 'claude', side: '2' }] }]);
  const performance = summarizeAiShoe(simulated, outcomes, ledger, 'deepseek');
  assert.ok(performance);
  assert.equal(performance.correct, 2);
  assert.equal(performance.streak, 2);
  assert.deepEqual(performance.decisions, simulated);
});

test('a recorded source abstention is distinct from an absent source and overrides replay', () => {
  const outcomes = ['2', '1'];
  const ledger = savedLedger(outcomes, [{ position: 2, prediction: '1', votes: [{ source: 'deepseek', side: undefined }] }]);
  const performance = summarizeAiShoe(replay(outcomes), outcomes, ledger, 'deepseek');
  assert.ok(performance);
  assert.equal(performance.correct, 1);
  assert.equal(performance.noSignal, 1);
  assert.equal(performance.lastResult, '無訊號');
});

test('partial or contradictory replay evidence is unavailable rather than an apparently valid zero', () => {
  assert.equal(summarizeAiShoe([{ prediction: '2', outcome: '2' }], ['2', '1']), undefined);
  assert.equal(summarizeAiShoe([{ prediction: '2', outcome: '1' }], ['2']), undefined);
  assert.equal(summarizeAiShoe([{ prediction: '2', outcome: '3' }], ['3']), undefined);
});

test('a conflicting saved shoe is ignored as a whole, even when its last outcome coincides', () => {
  const outcomes = ['2', '2', '1'];
  const simulated = replay(outcomes);
  const otherShoe = savedLedger(['1', '2', '1'], [{ position: 3, prediction: '2' }]);
  const performance = summarizeAiShoe(simulated, outcomes, otherShoe);
  assert.ok(performance);
  assert.equal(performance.correct, 3);
  assert.equal(performance.streak, 3);
  assert.deepEqual(performance.decisions, simulated);
});

test('empty and all-tie shoes do not invent wins or losses', () => {
  const empty = summarizeAiShoe([], []);
  assert.ok(empty);
  assert.equal(empty.total, 0);
  assert.equal(empty.accuracy, null);
  assert.equal(empty.streak, 0);
  assert.equal(empty.missStreak, 0);
  assert.equal(empty.lastResult, '等待');
  const tied = summarizeAiShoe([], ['3', '3']);
  assert.ok(tied);
  assert.equal(tied.total, 2);
  assert.equal(tied.ties, 2);
  assert.equal(tied.correct, 0);
  assert.equal(tied.noSignal, 0);
  assert.equal(tied.accuracy, 0);
  assert.equal(tied.maxStreak, 0);
  assert.equal(tied.maxMissStreak, 0);
  assert.equal(tied.lastResult, '和局');
});
