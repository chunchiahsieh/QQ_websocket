import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import * as React from 'react';
import * as jsxRuntime from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import * as consensus from '../lib/ai-consensus.ts';
import * as complete from '../lib/ai-complete-history.ts';
import * as observed from '../lib/ai-observed-predictions.ts';
import * as performance from '../lib/ai-prediction-performance.ts';
import { baccaratRoads } from '../lib/dg-card.ts';

const selected = ['deepseek'];
const tableId = 'MT:test';
const shoe = 'shoe-test';
const key = observed.aiObservationKey(tableId, shoe, 'deepseek', selected);
const road = outcomes => baccaratRoads(outcomes.map(Number)).bigRoad;
const propsFor = outcomes => ({
  raw: road(outcomes), beadPlate: outcomes.map(side => `0${side}`).join(''),
  fullOutcomes: outcomes, tableId, shoe, initialSource: 'deepseek',
  completedRounds: outcomes.length, completedNonTies: outcomes.length,
  completedBankers: outcomes.filter(side => side === '2').length,
});

function observedShoe(outcomes) {
  let ledger;
  for (let length = 0; length <= outcomes.length; length += 1) {
    const props = propsFor(outcomes.slice(0, length));
    const snapshot = observed.aiObservationSnapshot(props.beadPlate, props.completedRounds, false,
      props.completedNonTies, { fullOutcomes: props.fullOutcomes, road: props.raw, bankerTotal: props.completedBankers });
    assert.ok(snapshot);
    ledger = observed.advanceObservedAi(ledger, key, snapshot, consensus.completeAiConsensus(props.raw, selected), true);
  }
  return ledger;
}

let saved;
let historyProps;
const dependencies = {
  react: {
    ...React,
    useCallback: callback => callback,
    useEffect: () => {},
    useMemo: calculate => calculate(),
    useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
    useSyncExternalStore: () => saved,
  },
  'react/jsx-runtime': jsxRuntime,
  '@/lib/ai-consensus': consensus,
  '@/lib/ai-complete-history': complete,
  '@/lib/ai-observed-predictions': observed,
  '@/lib/ai-prediction-performance': performance,
  '@/components/ai-observation-provider': { useAiObservationSession: () => undefined },
  '@/components/ai-prediction-history': { AiPredictionHistory: props => { historyProps = props; return null; } },
  '@/components/ui/dialog': { Dialog: () => null },
};
const source = await readFile(new URL('../components/ai-prediction-card.tsx', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
} }).outputText;
const compiledModule = { exports: {} };
runInNewContext(compiled, {
  module: compiledModule, exports: compiledModule.exports,
  require: name => {
    assert.ok(Object.hasOwn(dependencies, name), `Unexpected component dependency ${name}`);
    return dependencies[name];
  },
});

function renderCard(ledger, props) {
  saved = { ledger };
  historyProps = undefined;
  const html = renderToStaticMarkup(React.createElement(compiledModule.exports.AiPredictionCard, props));
  return { html, history: historyProps };
}

test('AI card hides the previous hit until the new official result and road agree', () => {
  const outcomes = Array(8).fill('2');
  const ledger = observedShoe(outcomes);
  assert.equal(ledger.pending.position, 9);
  assert.equal(ledger.pending.prediction, '1');
  const before = renderCard(ledger, propsFor(outcomes));
  assert.match(before.html, /上一局：<strong class="text-emerald-300">命中<\/strong>/);
  const original = structuredClone(ledger);
  const next = [...outcomes, '2'];
  const partial = renderCard(ledger, { ...propsFor(next), raw: road(outcomes) });
  assert.equal(partial.history.status, '同步中');
  assert.match(partial.html, /上一局：<strong class="text-slate-300">資料同步中<\/strong>/);
  assert.match(partial.html, /本靴統計 8 局/);
  assert.deepEqual(ledger, original, 'a partial update must preserve the locked vote and settled statistics');
});

test('AI card hides the old result when counters update before the full outcomes', () => {
  const outcomes = Array(8).fill('2');
  const partial = renderCard(observedShoe(outcomes), { ...propsFor([...outcomes, '2']), fullOutcomes: outcomes });
  assert.equal(partial.history.status, '同步中');
  assert.match(partial.html, /上一局：<strong class="text-slate-300">資料同步中<\/strong>/);
});

test('AI card settles the saved player prediction as a miss when the next round is banker', () => {
  const outcomes = Array(8).fill('2');
  const ledger = observedShoe(outcomes);
  assert.equal(ledger.pending.prediction, '1');
  const after = renderCard(ledger, propsFor([...outcomes, '2']));
  const settled = after.history.rounds.find(round => round.position === 9 && round.outcome);
  assert.equal(settled.prediction, '1');
  assert.equal(settled.outcome, '2');
  assert.equal(settled.result, '錯誤');
  assert.match(after.html, /上一局：<strong class="text-orange-300">錯誤<\/strong>/);
  assert.match(after.html, /本靴統計 9 局/);
});

test('AI card still shows a settled hit for a correct prediction and while shuffling', () => {
  const outcomes = Array(8).fill('2');
  const ledger = observedShoe(outcomes);
  const hit = renderCard(ledger, propsFor([...outcomes, '1']));
  assert.match(hit.html, /上一局：<strong class="text-emerald-300">命中<\/strong>/);
  const shuffling = renderCard(ledger, { ...propsFor(outcomes), shuffling: true });
  assert.equal(shuffling.history.status, '洗牌中');
  assert.match(shuffling.html, /上一局：<strong class="text-emerald-300">命中<\/strong>/);
});
