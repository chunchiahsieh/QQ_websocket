import test from 'node:test';
import assert from 'node:assert/strict';
import { aiConsensus, canonicalAiRoad } from '../lib/ai-consensus.ts';
import { predictionPerformance } from '../lib/ai-prediction-performance.ts';
import { appendAiPrediction, chronologicalAiRoad, encodeAiRoad } from '../lib/ai-road-history.ts';
import { advanceObservedAi, aiObservationIdentity, aiObservationKey, aiObservationSnapshot, observedAiPerformance, restoreObservedAi, withObservedAiDecisions } from '../lib/ai-observed-predictions.ts';
import { baccaratRoads } from '../lib/dg-card.ts';

const key = aiObservationKey('MT:001', 'shoe-1', 'deepseek', ['deepseek']);
const candidate = side => ({ side, votes: [{ source: 'deepseek', side }], active: side ? 1 : 0, required: 1 });
const snapshot = (outcomes, shuffling = false) => aiObservationSnapshot(
  outcomes.slice(-36).map(side => `0${side}`).join(''), outcomes.length, shuffling, outcomes.filter(side => side !== '3').length, { tailWindow: 36 },
);
const observe = (previous, outcomes, side = '2', customKey = key) => advanceObservedAi(previous, customKey, snapshot(outcomes), candidate(side));

test('complete snapshots reject a road with the same number of results but a different winner', () => {
  assert.equal(aiObservationSnapshot('01', 1, false, 1, {
    fullOutcomes: ['1'], road: '0902', bankerTotal: 0,
  }), undefined);
  assert.equal(aiObservationSnapshot('02', 1, false, 1, {
    fullOutcomes: ['2'], road: '0901', bankerTotal: 1,
  }), undefined);
});

test('complete snapshots reject differently ordered roads even when banker and player counts agree', () => {
  const outcomes = ['1', '2', '1', '2'];
  const mismatched = baccaratRoads([2, 1, 2, 1]).bigRoad;
  assert.equal(aiObservationSnapshot(outcomes.map(side => `0${side}`).join(''), outcomes.length, false, 4, {
    fullOutcomes: outcomes, road: mismatched, bankerTotal: 2,
  }), undefined);
  const coherent = baccaratRoads(outcomes.map(Number)).bigRoad;
  assert.ok(aiObservationSnapshot(outcomes.map(side => `0${side}`).join(''), outcomes.length, false, 4, {
    fullOutcomes: outcomes, road: coherent, bankerTotal: 2,
  }));
});

test('road chronology validation also applies to complete bead history without a separate full-outcome field', () => {
  assert.equal(aiObservationSnapshot('0102', 2, false, 2, {
    road: baccaratRoads([2, 1]).bigRoad, bankerTotal: 1,
  }), undefined);
  assert.ok(aiObservationSnapshot('0102', 2, false, 2, {
    road: baccaratRoads([1, 2]).bigRoad, bankerTotal: 1,
  }));
});

test('empty, tied and interleaved dragon-tail histories remain valid when their roads agree', () => {
  const histories = [[], ['3', '3'], ['1', '3', '2', '3', '1'],
    [...Array(8).fill('2'), '1', '2', ...Array(7).fill('1'), '2', '3']];
  for (const outcomes of histories) {
    const nonTies = outcomes.filter(side => side !== '3').length;
    const coherent = baccaratRoads(outcomes.map(Number)).bigRoad;
    const value = aiObservationSnapshot(outcomes.map(side => `0${side}`).join(''), outcomes.length, false, nonTies, {
      fullOutcomes: outcomes, road: coherent, bankerTotal: outcomes.filter(side => side === '2').length,
    });
    assert.ok(value, `coherent history ${outcomes.join('')}`);
    assert.deepEqual(value.outcomes, outcomes);
  }
});

test('live banker prediction followed by player resets a real hit streak even if a recalculated vote says player', () => {
  let ledger = observe(undefined, ['2']);
  assert.equal(ledger.decisions.length, 0, 'opening a card must not fabricate old displayed predictions');
  ledger = observe(ledger, ['2', '2']);
  assert.equal(observedAiPerformance(ledger).streak, 1);
  const displayed = ledger.pending.prediction;
  assert.equal(displayed, '2');
  ledger = observe(ledger, ['2', '2'], '1');
  assert.equal(ledger.pending.prediction, displayed, 'same-round input updates cannot replace the displayed vote');
  ledger = observe(ledger, ['2', '2', '1'], '1');
  assert.equal(ledger.decisions.at(-1).prediction, displayed);
  assert.equal(ledger.decisions.at(-1).outcome, '1');
  assert.equal(observedAiPerformance(ledger).lastResult, '錯誤');
  assert.equal(observedAiPerformance(ledger).streak, 0);
  assert.equal(observedAiPerformance(ledger).missStreak, 1);
});

test('real DeepSeek padded-road vote is persisted and settled exactly once after refresh', () => {
  const before = Array.from({ length: 10 }, (_, point) => `0${point}02,,,,,`).find(raw => aiConsensus(raw, ['deepseek']).side === '2');
  assert.ok(before);
  const ledger = advanceObservedAi(undefined, key, snapshot(['2']), aiConsensus(before, ['deepseek']));
  const restored = restoreObservedAi(JSON.stringify(ledger), key);
  const after = `${before}#0101,,,,,`;
  const settled = advanceObservedAi(restored, key, snapshot(['2', '1']), aiConsensus(after, ['deepseek']));
  assert.equal(observedAiPerformance(settled).lastResult, '錯誤');
  assert.equal(settled.decisions[0].prediction, '2');
  assert.equal(advanceObservedAi(settled, key, snapshot(['2', '1']), candidate('1')), settled);
  assert.equal(settled.decisions.length, 1);
});

test('ties settle as a push and neither increment nor reset hit/miss streaks', () => {
  let ledger = observe(undefined, ['2']);
  ledger = observe(ledger, ['2', '2']);
  ledger = observe(ledger, ['2', '2', '3']);
  let performance = observedAiPerformance(ledger);
  assert.equal(performance.lastResult, '和局');
  assert.equal(performance.streak, 1);
  assert.equal(performance.missStreak, 0);
  assert.equal(performance.accuracy, 100);
  assert.equal(performance.total, 1);
  ledger = observe(ledger, ['2', '2', '3', '1']);
  performance = observedAiPerformance(ledger);
  assert.equal(performance.streak, 0);
  assert.equal(performance.missStreak, 1);
  assert.equal(performance.accuracy, 50);
});

test('official totals settle the next position when the bead window stays at 36 cells', () => {
  const outcomes = Array(42).fill('2');
  const ledger = observe(undefined, outcomes);
  assert.equal(ledger.pending.position, 43);
  const settled = observe(ledger, [...outcomes, '1']);
  assert.equal(settled.snapshot.outcomes.length, 36);
  assert.equal(settled.decisions[0].position, 43);
  assert.equal(observedAiPerformance(settled).lastResult, '錯誤');
});

test('reconnect settles only the saved next prediction and leaves unobserved intervening rounds unknown', () => {
  let ledger = observe(undefined, ['2']);
  ledger = observe(ledger, ['2', '2']);
  ledger = observe(ledger, ['2', '2', '2', '1', '2']);
  assert.deepEqual(ledger.decisions.map(item => item.position), [2, 3]);
  assert.equal(observedAiPerformance(ledger).correct, 2);
  assert.equal(observedAiPerformance(ledger).streak, 0);
  assert.equal(observedAiPerformance(ledger).lastResult, '等待');
  ledger = observe(ledger, ['2', '2', '2', '1', '2', '2']);
  assert.equal(observedAiPerformance(ledger).streak, 1, 'a gap starts a new observed streak');
});

test('an outcome that has rolled out of the official bead window cannot be guessed', () => {
  const ledger = observe(undefined, ['2']);
  const after = observe(ledger, ['2', ...Array(50).fill('1')]);
  assert.equal(after.decisions.length, 0);
  assert.equal(after.pending.position, 52);
});

test('table, shoe, card and exact source selection each isolate the saved observation history', () => {
  let ledger = observe(undefined, ['2']);
  ledger = observe(ledger, ['2', '2']);
  const contexts = [
    aiObservationKey('MT:002', 'shoe-1', 'deepseek', ['deepseek']),
    aiObservationKey('MT:001', 'shoe-2', 'deepseek', ['deepseek']),
    aiObservationKey('MT:001', 'shoe-1', 'ai-consensus', ['deepseek']),
    aiObservationKey('MT:001', 'shoe-1', 'deepseek', ['deepseek', 'claude']),
  ];
  for (const nextKey of contexts) {
    assert.equal(restoreObservedAi(JSON.stringify(ledger), nextKey), undefined);
    assert.equal(observe(ledger, ['2', '2'], '1', nextKey).decisions.length, 0);
  }
  assert.equal(aiObservationKey('x', 's', 'ai-consensus', ['deepseek', 'claude']), aiObservationKey('x', 's', 'ai-consensus', ['claude', 'deepseek']));
});

test('shuffle preserves completed results and stale same-shoe snapshots cannot erase measured streaks', () => {
  let ledger = observe(undefined, ['2']);
  ledger = observe(ledger, ['2', '2']);
  const shuffling = advanceObservedAi(ledger, key, snapshot(['2', '2'], true), candidate('2'));
  assert.equal(shuffling.pending, undefined);
  assert.equal(shuffling.decisions.length, 1);
  assert.equal(observedAiPerformance(shuffling).maxStreak, 1);
  assert.equal(observe(ledger, ['2']), ledger);
  assert.equal(observe(ledger, ['1', '2']), ledger);
  assert.equal(observe(ledger, ['1'], '2', 'new-shoe').decisions.length, 0);
});

test('unknown AB shoe cannot reuse a prior mount prediction when a later shoe shares its opening results', () => {
  const firstMount = aiObservationIdentity('AB:101', '—', 'deepseek', ['deepseek'], 'mount-1');
  const nextMount = aiObservationIdentity('AB:101', '—', 'deepseek', ['deepseek'], 'mount-2');
  assert.equal(firstMount.persistent, false);
  assert.equal(nextMount.persistent, false);
  assert.notEqual(firstMount.key, nextMount.key);
  const oldShoe = observe(undefined, ['2'], '2', firstMount.key);
  assert.equal(observedAiPerformance(observe(oldShoe, ['2', '2'], '2', firstMount.key)).streak, 1, 'in-mount observations still settle normally');
  assert.equal(restoreObservedAi(JSON.stringify(oldShoe), nextMount.key), undefined);
  const newShoe = observe(oldShoe, ['2', '2'], '2', nextMount.key);
  assert.equal(newShoe.decisions.length, 0);
  assert.equal(observedAiPerformance(newShoe).streak, 0);
  for (const placeholder of ['', ' ', '-', '—', '?', 'unknown', '0'])
    assert.equal(aiObservationIdentity('AB:101', placeholder, 'deepseek', ['deepseek'], 'scope').persistent, false);
  const knownFirst = aiObservationIdentity('DG:101', 'shoe-7', 'deepseek', ['deepseek'], 'mount-1');
  const knownNext = aiObservationIdentity('DG:101', 'shoe-7', 'deepseek', ['deepseek'], 'mount-2');
  assert.equal(knownFirst.persistent, true);
  assert.equal(knownFirst.key, knownNext.key, 'an official shoe identity retains remount persistence');
});

test('invalid stored decisions and inconsistent official counts cannot be used for settlement', () => {
  const ledger = observe(undefined, ['2']);
  assert.equal(restoreObservedAi('{broken', key), undefined);
  assert.equal(restoreObservedAi(JSON.stringify({ ...ledger, pending: { ...ledger.pending, position: 99 } }), key), undefined);
  assert.equal(aiObservationSnapshot('0201', 1, false), undefined);
  assert.equal(aiObservationSnapshot('', 3, false), undefined);
  assert.equal(aiObservationSnapshot('02', Number.NaN, false), undefined);
  assert.equal(aiObservationSnapshot('02x', 1, false), undefined);
  assert.equal(aiObservationSnapshot('0203', 2, false, 2), undefined);
  assert.equal(aiObservationSnapshot('02'.repeat(36), 42, false, 42), undefined, 'a truncated tail requires explicit source evidence');
  assert.equal(aiObservationSnapshot('0202', 2, false, 2, { fullOutcomes: ['2'] }), undefined);
});

test('count-before-bead partial update keeps the locked banker vote until the actual player result can settle it', () => {
  const previous = observe(undefined, ['2']);
  assert.equal(aiObservationSnapshot('02', 2, false, 2), undefined);
  assert.equal(previous.pending.prediction, '2');
  const complete = aiObservationSnapshot('0201', 2, false, 2, { bankerTotal: 1, road: baccaratRoads([2, 1]).bigRoad });
  const settled = advanceObservedAi(previous, key, complete, candidate('1'));
  assert.equal(settled.decisions[0].prediction, '2');
  assert.equal(settled.decisions[0].outcome, '1');
  assert.equal(observedAiPerformance(settled).lastResult, '錯誤');
});

test('36-cell tails require coherent new road and winner counters before settling an unchanged window', () => {
  const beforeRoad = baccaratRoads(Array(42).fill(2)).bigRoad;
  const before = aiObservationSnapshot('02'.repeat(36), 42, false, 42, { tailWindow: 36, bankerTotal: 42, road: beforeRoad });
  const previous = advanceObservedAi(undefined, key, before, candidate('2'));
  assert.equal(aiObservationSnapshot('02'.repeat(36), 43, false, 43, { tailWindow: 36, bankerTotal: 42, road: beforeRoad }), undefined, 'new counts with the old road cannot settle');
  const playerRoad = baccaratRoads([...Array(42).fill(2), 1]).bigRoad;
  const staleBead = aiObservationSnapshot('02'.repeat(36), 43, false, 43, { tailWindow: 36, bankerTotal: 42, road: playerRoad });
  assert.equal(advanceObservedAi(previous, key, staleBead, candidate('1')), previous, 'new road with stale beads must wait');
  const playerBead = aiObservationSnapshot(`${'02'.repeat(35)}01`, 43, false, 43, { tailWindow: 36, bankerTotal: 42, road: playerRoad });
  assert.equal(observedAiPerformance(advanceObservedAi(previous, key, playerBead, candidate('1'))).lastResult, '錯誤');
  const bankerRoad = baccaratRoads(Array(43).fill(2)).bigRoad;
  const bankerBead = aiObservationSnapshot('02'.repeat(36), 43, false, 43, { tailWindow: 36, bankerTotal: 43, road: bankerRoad });
  assert.equal(observedAiPerformance(advanceObservedAi(previous, key, bankerBead, candidate('1'))).lastResult, '命中');
});

test('complete official outcomes provide proof even when the display bead window stays unchanged', () => {
  const fullOutcomes = Array(43).fill('2');
  const verified = aiObservationSnapshot('02'.repeat(36), 43, false, 43, { fullOutcomes, bankerTotal: 43, road: baccaratRoads(Array(43).fill(2)).bigRoad });
  assert.equal(verified.outcomes.length, 43);
  assert.deepEqual(verified.outcomes, fullOutcomes);
});

test('full-shoe backtest stays available but a safely mapped witnessed prediction takes precedence', () => {
  let ledger = observe(undefined, ['2', '1']);
  ledger = observe(ledger, ['2', '1', '1']);
  const simulated = [{ prediction: '1', outcome: '2' }, { prediction: '1', outcome: '1' }, { prediction: '1', outcome: '1' }];
  const combined = withObservedAiDecisions(simulated, ledger);
  assert.equal(combined.length, 3);
  assert.equal(combined[0], simulated[0]);
  assert.equal(combined[2].prediction, '2');
  assert.equal(simulated[2].prediction, '1', 'the retrospective comparison is not mutated');
  assert.equal(withObservedAiDecisions(simulated.slice(1), ledger).length, 2, 'truncated history is not assigned guessed indices');
});

test('interleaved dragon tails replay in true time order and place the predicted marker in the actual next cell', () => {
  const winners = [...Array(9).fill(2), ...Array(7).fill(1), 2, 1, 2];
  const road = baccaratRoads(winners).bigRoad;
  const marks = chronologicalAiRoad(road, winners.map(String));
  assert.deepEqual(marks.map(mark => Number(mark.code[3])), winners);
  assert.notDeepEqual(road.split('#').flatMap(column => column.split(',')).filter(Boolean).map(code => Number(code[3])), winners);
  const decisions = predictionPerformance(road, ['deepseek'], winners.map(String)).decisions;
  for (let index = 0; index < winners.length; index += 1) {
    assert.equal(decisions[index].prediction, aiConsensus(baccaratRoads(winners.slice(0, index)).bigRoad, ['deepseek']).side);
    assert.equal(decisions[index].outcome, String(winners[index]));
  }
  const beforeTurn = baccaratRoads(Array(9).fill(2)).bigRoad;
  const appended = appendAiPrediction(beforeTurn, '1');
  assert.deepEqual(appended.position, { column: 1, row: 0 });
  assert.equal(canonicalAiRoad(appended.raw), canonicalAiRoad(baccaratRoads([...Array(9).fill(2), 1]).bigRoad));
});

test('chronological road recovery and prediction placement agree with official layout across long mixed histories', () => {
  let seed = 42;
  for (let sample = 0; sample < 80; sample += 1) {
    const winners = [];
    for (let index = 0; index < 100; index += 1) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      winners.push(seed % 13 === 0 ? 3 : (seed >>> 24) % 2 + 1);
    }
    const road = baccaratRoads(winners).bigRoad;
    const marks = chronologicalAiRoad(road, winners.map(String));
    assert.ok(marks, `sample ${sample} is recoverable`);
    assert.deepEqual(marks.map(mark => Number(mark.code[3])), winners.filter(side => side !== 3));
    assert.equal(canonicalAiRoad(encodeAiRoad(marks)), canonicalAiRoad(road));
    for (const side of ['1', '2']) {
      const appended = appendAiPrediction(road, side, winners.map(String));
      assert.equal(canonicalAiRoad(appended.raw), canonicalAiRoad(baccaratRoads([...winners, Number(side)]).bigRoad));
    }
  }
});

test('ambiguous touching tails are never assigned a fabricated chronology without official outcomes', () => {
  const winners = [...Array(9).fill(2), 1, 2, 1, 1, 1, ...Array(8).fill(2), 1];
  const road = baccaratRoads(winners).bigRoad;
  assert.equal(chronologicalAiRoad(road), undefined);
  assert.equal(predictionPerformance(road, ['deepseek']).decisions.length, 0);
  assert.equal(appendAiPrediction(road, '2').position, undefined);
  assert.deepEqual(chronologicalAiRoad(road, winners.map(String)).map(mark => Number(mark.code[3])), winners);
  assert.equal(predictionPerformance(road, ['deepseek'], winners.map(String)).decisions.length, winners.length);
});
