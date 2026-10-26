import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import * as React from 'react';
import * as jsxRuntime from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import { baccaratRoads } from '../lib/dg-card.ts';
import * as pointAnalysis from '../lib/point-analysis.ts';
import * as statisticalCards from '../lib/statistical-cards.ts';
import * as predictionPerformance from '../lib/prediction-performance.ts';
import * as aiRoadHistory from '../lib/ai-road-history.ts';
import * as observedPredictions from '../lib/ai-observed-predictions.ts';

const source = await readFile(new URL('../components/point-analysis-card.tsx', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
} }).outputText;
const compiledModule = { exports: {} };
const effects = [];
let activeState;
let stateIndex = 0;
let observationEpoch;
const dependencies = {
  react: { ...React, useEffect: effect => effects.push(effect),
    useState: initial => {
      const create = () => ({ value: typeof initial === 'function' ? initial() : initial });
      const state = activeState ? (activeState[stateIndex++] ??= create()) : create();
      return [state.value, value => { state.value = value; }];
    },
    useSyncExternalStore: (_subscribe, read) => read() },
  'react/jsx-runtime': jsxRuntime,
  '@/lib/point-analysis': pointAnalysis,
  '@/lib/statistical-cards': statisticalCards,
  '@/lib/prediction-performance': predictionPerformance,
  '@/lib/ai-road-history': aiRoadHistory,
  '@/lib/ai-observed-predictions': observedPredictions,
  '@/components/ai-observation-provider': { useAiObservationSession: () => observationEpoch },
};
runInNewContext(compiled, {
  module: compiledModule, exports: compiledModule.exports,
  require: name => {
    assert.ok(Object.hasOwn(dependencies, name), `Unexpected component dependency ${name}`);
    return dependencies[name];
  },
});

function renderCard(outcomes, pointDigits = outcomes.map(() => '5'), overrides = {}, refs) {
  const roads = baccaratRoads(outcomes.map(Number), pointDigits.map(point => ({ point, pair: '0' })));
  let prediction;
  let decisions;
  activeState = refs;
  stateIndex = 0;
  const html = renderToStaticMarkup(React.createElement(compiledModule.exports.PointAnalysisCard, {
    bigRoad: roads.bigRoad, beadPlate: roads.beadPlate,
    tableId: 'DG:points-1', shoe: 'shoe-1', completedRounds: outcomes.length,
    onPredictionChange: (side, history) => { prediction = side; decisions = history; },
    ...overrides,
  }));
  activeState = undefined;
  for (const effect of effects.splice(0)) effect();
  return { html, prediction, decisions };
}

function expectedDecisions(outcomes, pointDigits) {
  return outcomes.slice(-36).map((outcome, index, recent) => {
    const absoluteIndex = outcomes.length - recent.length + index;
    const points = outcomes.slice(0, absoluteIndex).flatMap((side, pointIndex) =>
      side !== '3' && /^\d$/.test(pointDigits[pointIndex])
        ? [{ side, points: Number(pointDigits[pointIndex]) }] : []);
    const answer = statisticalCards.winningPointSignal(points.slice(-36)).answer;
    return { prediction: answer === '莊' ? '2' : answer === '閒' ? '1' : undefined, outcome };
  });
}

test('a player forecast in a long shoe settles as a miss when banker wins', () => {
  const before = [...Array.from({ length: 10 }, () => ['2', '2', '2', '2', '2', '1']).flat(), ...Array(30).fill('1')];
  const displayed = renderCard(before);
  assert.equal(displayed.prediction, '1');
  assert.match(displayed.html, /下局預測：<strong[^>]*>閒<\/strong>/);
  const settled = renderCard([...before, '2']);
  assert.equal(settled.decisions.length, 36, 'keep the original bead-history statistics window');
  assert.equal(settled.decisions.at(-1).prediction, displayed.prediction);
  assert.equal(settled.decisions.at(-1).outcome, '2');
  assert.match(settled.html, /上次預測：<strong[^>]*>錯誤<\/strong>/);
});

test('dragon tails replay in round order rather than display-column order', () => {
  const outcomes = [...Array(8).fill('2'), ...Array(12).fill('1'), '2'];
  const points = outcomes.map((_, index) => String(index % 10));
  const before = renderCard(outcomes.slice(0, -1), points.slice(0, -1));
  const after = renderCard(outcomes, points);
  assert.deepEqual(after.decisions, expectedDecisions(outcomes, points));
  assert.equal(after.decisions.at(-1).prediction, before.prediction);
});

test('unknown point digits do not shift bead alignment or become invented point scores', () => {
  const outcomes = [...Array.from({ length: 8 }, () => ['2', '2', '2', '2', '2', '1']).flat(), ...Array(24).fill('1'), '2'];
  const points = outcomes.map((_, index) => index % 4 === 0 ? '?' : String(index % 10));
  const before = renderCard(outcomes.slice(0, -1), points.slice(0, -1));
  const after = renderCard(outcomes, points);
  assert.deepEqual(after.decisions, expectedDecisions(outcomes, points));
  assert.equal(after.decisions.at(-1).prediction, before.prediction);
});

test('a conflicting bead and big road cannot report a fabricated hit', () => {
  const card = renderCard(Array(12).fill('2'), undefined, { beadPlate: '01' });
  assert.equal(card.prediction, undefined);
  assert.equal(card.decisions.length, 0);
  assert.match(card.html, /上次預測：<strong[^>]*>等待<\/strong>/);
});

test('complete outcomes resolve touching dragon tails without changing the bead statistics window', () => {
  const outcomes = [...Array(8).fill('2'), '1', '2', ...Array(7).fill('1'), '2', ...Array(30).fill('1')];
  const points = outcomes.map(() => '5');
  const roads = baccaratRoads(outcomes.map(Number), points.map(point => ({ point, pair: '0' })));
  assert.equal(aiRoadHistory.chronologicalAiRoad(roads.bigRoad), undefined, 'fixture must have ambiguous touching tails');
  const unsupported = renderCard(outcomes, points);
  assert.equal(unsupported.prediction, undefined);
  assert.equal(unsupported.decisions.length, 0, 'a clipped bead cannot establish the missing complete chronology');
  const supported = renderCard(outcomes, points, { fullOutcomes: outcomes });
  assert.equal(supported.prediction, '1');
  assert.equal(supported.decisions.length, 36);
  assert.deepEqual(supported.decisions, expectedDecisions(outcomes, points));
});

test('a complete bead history also resolves touching tails when separate full outcomes are unavailable', () => {
  const outcomes = [...Array(8).fill('2'), '1', '2', ...Array(7).fill('1'), '2', '3'];
  const points = outcomes.map(() => '5');
  const roads = baccaratRoads(outcomes.map(Number), points.map(point => ({ point, pair: '0' })));
  assert.equal(aiRoadHistory.chronologicalAiRoad(roads.bigRoad), undefined);
  assert.deepEqual(renderCard(outcomes, points).decisions, expectedDecisions(outcomes, points));
});

test('staggered bead, full-outcome and road updates wait rather than settle mismatched rounds', () => {
  const before = Array(40).fill('1');
  const after = [...before, '2'];
  const cases = [
    renderCard(before, undefined, { fullOutcomes: after }),
    renderCard(after, undefined, { fullOutcomes: before }),
    renderCard(after, undefined, { fullOutcomes: after, beadPlate: baccaratRoads(before.map(Number)).beadPlate }),
  ];
  for (const card of cases) {
    assert.equal(card.prediction, undefined);
    assert.equal(card.decisions.length, 0);
    assert.match(card.html, /上次預測：<strong[^>]*>等待<\/strong>/);
  }
});

test('a short partial bead cannot settle against a longer road even when its side matches', () => {
  const card = renderCard(Array(12).fill('2'), undefined, { beadPlate: '02' });
  assert.equal(card.prediction, undefined);
  assert.equal(card.decisions.length, 0);
  assert.match(card.html, /上次預測：<strong[^>]*>等待<\/strong>/);
});

test('later supplied point digits cannot rewrite the displayed player forecast into a banker hit', () => {
  const before = [...Array(10).fill('1'), ...Array(10).fill('2')];
  const after = [...before, '2'];
  const refs = [];
  const identity = { tableId: 'DG:points-1', shoe: 'shoe-1' };
  const displayed = renderCard(before, [...Array(10).fill('5'), ...Array(10).fill('?')],
    { ...identity, fullOutcomes: before }, refs);
  assert.equal(displayed.prediction, '1');
  const corrected = renderCard(before, before.map(() => '5'), { ...identity, fullOutcomes: before }, refs);
  assert.equal(corrected.prediction, displayed.prediction, 'same-round point updates must retain the direction already displayed');
  assert.match(corrected.html, /下局預測：<strong[^>]*>閒<\/strong>/);
  const settled = renderCard(after, after.map(() => '5'), { ...identity, fullOutcomes: after }, refs);
  assert.equal(settled.decisions.at(-1).prediction, displayed.prediction);
  assert.equal(settled.decisions.at(-1).outcome, '2');
  assert.match(settled.html, /上次預測：<strong[^>]*>錯誤<\/strong>/);
});

test('a displayed no-signal decision remains no bet after missing point digits arrive', () => {
  const before = Array(10).fill('1');
  const refs = [];
  const displayed = renderCard(before, [...Array(5).fill('?'), ...Array(5).fill('5')], { fullOutcomes: before }, refs);
  assert.equal(displayed.prediction, undefined);
  const corrected = renderCard(before, before.map(() => '5'), { fullOutcomes: before }, refs);
  assert.equal(corrected.prediction, undefined);
  assert.match(corrected.html, /下局預測：<strong[^>]*>無訊號<\/strong>/);
  const after = [...before, '1'];
  const settled = renderCard(after, after.map(() => '5'), { fullOutcomes: after }, refs);
  assert.equal(settled.decisions.at(-1).prediction, undefined);
  assert.match(settled.html, /上次預測：<strong[^>]*>無訊號<\/strong>/);
});

test('different tables and shoes do not inherit another pending direction', () => {
  const outcomes = [...Array(10).fill('1'), ...Array(10).fill('2')];
  for (const identity of [{ tableId: 'DG:points-2' }, { shoe: 'shoe-2' }]) {
    const refs = [];
    const before = renderCard(outcomes, [...Array(10).fill('5'), ...Array(10).fill('?')], { fullOutcomes: outcomes }, refs);
    assert.equal(before.prediction, '1');
    const changed = renderCard(outcomes, outcomes.map(() => '5'), { ...identity, fullOutcomes: outcomes }, refs);
    assert.equal(changed.prediction, '2');
  }
});

test('unknown-shoe feed epochs isolate pending directions', () => {
  const outcomes = [...Array(10).fill('1'), ...Array(10).fill('2')];
  const refs = [];
  try {
    observationEpoch = 'feed-1:1';
    const before = renderCard(outcomes, [...Array(10).fill('5'), ...Array(10).fill('?')],
      { shoe: '—', fullOutcomes: outcomes }, refs);
    assert.equal(before.prediction, '1');
    observationEpoch = 'feed-1:2';
    const changed = renderCard(outcomes, outcomes.map(() => '5'), { shoe: '—', fullOutcomes: outcomes }, refs);
    assert.equal(changed.prediction, '2');
  } finally { observationEpoch = undefined; }
});

test('partial updates and old packets keep the saved direction without showing an old hit', () => {
  const before = [...Array(10).fill('1'), ...Array(10).fill('2')];
  const after = [...before, '2'];
  const refs = [];
  assert.equal(renderCard(before, [...Array(10).fill('5'), ...Array(10).fill('?')], { fullOutcomes: before }, refs).prediction, '1');
  const partial = renderCard(before, before.map(() => '5'), { fullOutcomes: before, completedRounds: after.length }, refs);
  assert.equal(partial.prediction, undefined);
  assert.match(partial.html, /上次預測：<strong[^>]*>等待<\/strong>/);
  const settled = renderCard(after, after.map(() => '5'), { fullOutcomes: after }, refs);
  assert.equal(settled.decisions.at(-1).prediction, '1');
  assert.match(settled.html, /上次預測：<strong[^>]*>錯誤<\/strong>/);
  const stale = renderCard(before, before.map(() => '5'), { fullOutcomes: before }, refs);
  assert.equal(stale.prediction, undefined);
  assert.equal(stale.decisions.length, 0);
  assert.match(stale.html, /上次預測：<strong[^>]*>等待<\/strong>/);
  const restored = renderCard(after, after.map(() => '5'), { fullOutcomes: after }, refs);
  assert.equal(restored.decisions.at(-1).prediction, '1');
  assert.match(restored.html, /上次預測：<strong[^>]*>錯誤<\/strong>/);
});
