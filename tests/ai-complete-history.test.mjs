import test from 'node:test';
import assert from 'node:assert/strict';
import { aiConsensus, aiSources, completeAiConsensus } from '../lib/ai-consensus.ts';
import { completeAiHistory } from '../lib/ai-complete-history.ts';
import { chronologicalAiRoad, encodeAiRoad } from '../lib/ai-road-history.ts';
import { baccaratRoads } from '../lib/dg-card.ts';

const key = 'complete-history-test';
const road = (outcomes, details) => baccaratRoads(outcomes.map(Number), details).bigRoad;
const savedLedger = (outcomes, records = []) => ({
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
});

test('every settled round including opening ties has a direction, with no pending row', () => {
  const outcomes = ['3', '3', '2', '1', '3', '2'];
  const ledger = savedLedger(outcomes);
  ledger.pending = { position: 7, prediction: '1', agreement: 1, activeVotes: 1, votes: [] };
  for (const selected of [...aiSources.map(source => [source]), aiSources]) {
    const result = completeAiHistory(road(outcomes), selected, outcomes, ledger);
    assert.ok(result);
    assert.deepEqual(result.history.map(round => round.position), [1, 2, 3, 4, 5, 6]);
    assert.ok(result.history.every(round => ['1', '2'].includes(round.prediction)));
    assert.ok(result.history.every(round => ['命中', '錯誤', '和局'].includes(round.result)));
    assert.ok(result.history.every(round => round.origin === 'replayed'));
    assert.equal(result.performance.noSignal, 0);
    assert.equal(result.performance.total, 6);
    assert.equal(result.performance.ties, 3);
  }
});

test('saved directions win over replay, saved abstentions complete without changing original records', () => {
  const outcomes = ['2', '1', '3', '2'];
  const originalReplay = completeAiHistory(road(outcomes), ['deepseek'], outcomes);
  const contrary = originalReplay.history[1].prediction === '1' ? '2' : '1';
  const ledger = savedLedger(outcomes, [
    { position: 2, prediction: contrary, agreement: 2, activeVotes: 3 },
    { position: 3, prediction: '2' },
    { position: 4, prediction: undefined, agreement: 0, activeVotes: 0 },
  ]);
  const before = JSON.stringify({ ledger, outcomes });
  const result = completeAiHistory(road(outcomes), ['deepseek'], outcomes, ledger);
  assert.equal(result.history[1].prediction, contrary);
  assert.equal(result.history[1].origin, 'observed');
  assert.equal(result.history[2].prediction, '2');
  assert.equal(result.history[2].origin, 'observed');
  assert.equal(result.history[2].result, '和局');
  assert.deepEqual(result.history[3], originalReplay.history[3]);
  assert.equal(result.performance.decisions[1].agreement, 2);
  assert.equal(result.performance.decisions[1].activeVotes, 3);
  assert.equal(result.performance.decisions[2].prediction, result.history[3].prediction);
  assert.equal(result.performance.noSignal, 0, 'summarizing must not overlay the saved abstention a second time');
  assert.equal(JSON.stringify({ ledger, outcomes }), before);
});

test('single-source saved votes override consensus while absent or abstaining sources use replay', () => {
  const outcomes = ['1', '2', '1'];
  const ledger = savedLedger(outcomes, [
    { position: 1, prediction: '1', votes: [{ source: 'deepseek', side: '2' }] },
    { position: 2, prediction: '2', votes: [{ source: 'claude', side: '1' }] },
    { position: 3, prediction: '1', votes: [{ source: 'deepseek', side: undefined }] },
  ]);
  const before = JSON.stringify(ledger);
  const replay = completeAiHistory(road(outcomes), ['deepseek'], outcomes);
  const result = completeAiHistory(road(outcomes), ['deepseek'], outcomes, ledger, 'deepseek');
  assert.deepEqual(result.history[0], {
    position: 1, prediction: '2', outcome: '1', origin: 'observed', result: '錯誤',
  });
  assert.deepEqual(result.history.slice(1), replay.history.slice(1));
  assert.equal(result.performance.decisions[0].prediction, '2');
  assert.equal(JSON.stringify(ledger), before);
});

test('abstaining raw consensus completes a direction without inventing source votes', () => {
  const selected = ['deepseek'];
  let prefix;
  for (let length = 1; length <= 100; length += 1) {
    const candidate = Array(length).fill('2');
    if (!aiConsensus(road(candidate), selected).side) { prefix = candidate; break; }
  }
  assert.ok(prefix, 'fixture must reach a deterministic abstention');
  const outcomes = [...prefix, '1'];
  const raw = road(outcomes);
  const result = completeAiHistory(raw, selected, outcomes);
  assert.ok(['1', '2'].includes(result.history.at(-1).prediction));
  assert.equal(result.history.at(-1).origin, 'replayed');
  assert.equal(result.performance.decisions.at(-1).activeVotes, 0);
  assert.equal(result.performance.decisions.at(-1).agreement, 0);
});

test('changing the scored round or any future winner and code cannot change its predicted side', () => {
  const past = ['2', '2', '1', '3', '1', '2'];
  const beforeDetails = past.map((_, index) => ({ point: String(index % 10), pair: String(index % 4) }));
  for (const selected of [...aiSources.map(source => [source]), aiSources]) {
    const variants = [
      { outcomes: [...past, '1', '1', '3', '2'], details: [...beforeDetails, { point: '2', pair: '0' }, { point: '8', pair: '1' }, { point: '0', pair: '0' }, { point: '9', pair: '2' }] },
      { outcomes: [...past, '2', '3', '2', '1'], details: [...beforeDetails, { point: '9', pair: '3' }, { point: '3', pair: '0' }, { point: '1', pair: '2' }, { point: '4', pair: '0' }] },
      { outcomes: [...past, '3', '1', '2', '2'], details: [...beforeDetails, { point: '5', pair: '1' }, { point: '1', pair: '3' }, { point: '4', pair: '1' }, { point: '3', pair: '2' }] },
    ];
    const histories = variants.map(({ outcomes, details }) => completeAiHistory(road(outcomes, details), selected, outcomes).history);
    assert.deepEqual(histories[0].slice(0, past.length + 1).map(round => round.prediction), histories[1].slice(0, past.length + 1).map(round => round.prediction));
    assert.deepEqual(histories[0].slice(0, past.length + 1).map(round => round.prediction), histories[2].slice(0, past.length + 1).map(round => round.prediction));
    for (const { outcomes, details } of variants) {
      const raw = road(outcomes, details);
      const marks = chronologicalAiRoad(raw, outcomes);
      const previousNonTies = past.filter(outcome => outcome !== '3').length;
      const expected = completeAiConsensus(encodeAiRoad(marks.slice(0, previousNonTies)), selected).side;
      assert.equal(completeAiHistory(raw, selected, outcomes).history[past.length].prediction, expected);
    }
  }
});

test('completion is not a retroactive win: an adversarial result sequence produces real misses', () => {
  const selected = ['deepseek'];
  const outcomes = [];
  for (let index = 0; index < 16; index += 1) {
    const predicted = completeAiConsensus(road(outcomes), selected).side;
    outcomes.push(predicted === '1' ? '2' : '1');
  }
  const result = completeAiHistory(road(outcomes), selected, outcomes);
  assert.ok(result.history.every(round => round.result === '錯誤'));
  assert.equal(result.performance.correct, 0);
  assert.equal(result.performance.missStreak, 16);
  assert.equal(result.performance.maxMissStreak, 16);
});

test('inconsistent roads, incomplete roads and an empty selection are rejected', () => {
  assert.equal(completeAiHistory(road(['1', '2']), ['deepseek'], ['1', '1']), undefined);
  assert.equal(completeAiHistory(road(['1']), ['deepseek'], ['1', '2']), undefined);
  assert.equal(completeAiHistory(road(['1', '2']), ['deepseek'], ['1']), undefined);
  assert.equal(completeAiHistory(road(['1']), [], ['1']), undefined);
  const empty = completeAiHistory('', ['deepseek'], []);
  assert.deepEqual(empty.history, []);
  assert.equal(empty.performance.accuracy, null);
});

test('incompatible snapshots and any invalid saved decision reject the entire observed overlay', () => {
  const outcomes = ['2', '1', '2'];
  const raw = road(outcomes);
  const replay = completeAiHistory(raw, ['deepseek'], outcomes);
  const records = [
    { position: 1, prediction: '1' },
    { position: 2, prediction: '2' },
  ];
  const wrongShoe = savedLedger(['1', '1', '2'], records);
  const wrongOutcome = savedLedger(outcomes, [{ ...records[0], outcome: '1' }, records[1]]);
  const wrongOrder = savedLedger(outcomes, [records[1], records[0]]);
  const wrongPosition = savedLedger(outcomes, [{ position: 0, prediction: '2', outcome: '2' }, records[1]]);
  const duplicate = savedLedger(outcomes, [records[0], records[0]]);
  const tooLate = savedLedger(outcomes, [records[0], { position: 4, prediction: '2', outcome: '2' }]);
  for (const ledger of [wrongShoe, wrongOutcome, wrongOrder, wrongPosition, duplicate, tooLate])
    assert.deepEqual(completeAiHistory(raw, ['deepseek'], outcomes, ledger), replay);
});

test('older compatible observations preserve exact positions without claiming replay as observed', () => {
  const outcomes = ['2', '3', '1', '2'];
  const ledger = savedLedger(outcomes.slice(0, 3), [{ position: 3, prediction: '2' }]);
  const result = completeAiHistory(road(outcomes), ['deepseek'], outcomes, ledger);
  assert.deepEqual(result.history.map(round => round.origin), ['replayed', 'replayed', 'observed', 'replayed']);
  assert.equal(result.history[2].result, '錯誤');
});

test('performance exactly agrees with history and ties neither reset nor increment streaks', () => {
  const outcomes = ['2', '3', '1', '3', '2', '1', '3'];
  const predictions = ['2', '1', '1', '2', '1', '2', '2'];
  const ledger = savedLedger(outcomes, outcomes.map((_, index) => ({ position: index + 1, prediction: predictions[index] })));
  const { history, performance } = completeAiHistory(road(outcomes), ['deepseek'], outcomes, ledger);
  assert.equal(performance.correct, history.filter(round => round.result === '命中').length);
  assert.equal(performance.noSignal, 0);
  assert.equal(performance.ties, 3);
  assert.equal(performance.total, 7);
  assert.equal(performance.accuracy, 2 / 7 * 100);
  assert.equal(performance.streak, 0);
  assert.equal(performance.missStreak, 2);
  assert.equal(performance.maxStreak, 2);
  assert.equal(performance.maxMissStreak, 2);
  assert.equal(performance.lastResult, '和局');
  assert.deepEqual(performance.decisions.map(decision => decision.prediction), history.filter(round => round.outcome !== '3').map(round => round.prediction));
});
