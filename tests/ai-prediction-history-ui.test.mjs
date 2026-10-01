import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import * as React from 'react';
import * as jsxRuntime from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import { completeAiHistory } from '../lib/ai-complete-history.ts';
import { baccaratRoads } from '../lib/dg-card.ts';

const source = await readFile(new URL('../components/ai-prediction-history.tsx', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
} }).outputText;
const module = { exports: {} };
const dependencies = { react: React, 'react/jsx-runtime': jsxRuntime };
runInNewContext(compiled, {
  module, exports: module.exports,
  require: name => {
    assert.ok(Object.hasOwn(dependencies, name), `Unexpected component dependency ${name}`);
    return dependencies[name];
  },
});
const renderRound = round => renderToStaticMarkup(React.createElement(module.exports.AiPredictionHistory,
  { rounds: [round], status: '下局無訊號' }));

test('AI card restores the original two-panel layout without added legend and detail rows', () => {
  const html = renderRound({ position: 1, prediction: '1', outcome: '1', origin: 'observed', result: '命中' });
  assert.doesNotMatch(html, /ai-history-legend|ai-history-detail/);
  assert.equal([...html.matchAll(/<section\b/g)].length, 2);
  assert.match(html, /AI預測/);
});

test('AI history keeps ten responsive columns per panel without visible scrollbars', async () => {
  const css = await readFile(new URL('../app/globals.css', import.meta.url), 'utf8');
  const gridRule = css.match(/\.ai-history-grid\s*\{([^}]+)\}/)?.[1];
  const webkitRule = css.match(/\.ai-history-grid::-webkit-scrollbar\s*\{([^}]+)\}/)?.[1];
  assert.ok(gridRule);
  assert.ok(webkitRule);
  assert.match(gridRule, /grid-auto-columns:\s*calc\(100% \/ 10\)\s*;/);
  assert.match(gridRule, /overflow-x:\s*auto\s*;/);
  assert.match(gridRule, /scrollbar-width:\s*none\s*;/);
  assert.match(webkitRule, /display:\s*none\s*;/);
  const html = renderRound({ position: 1, prediction: '1', outcome: '1', origin: 'observed', result: '命中' });
  assert.equal([...html.matchAll(/class="ai-history-grid" tabindex="0"/g)].length, 2);
});

test('AI card and nested history grids can shrink within narrow table cards', async () => {
  const css = await readFile(new URL('../app/globals.css', import.meta.url), 'utf8');
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
  for (const className of ['ai-prediction-card', 'ai-history-comparison', 'ai-history-panels', 'ai-history-panel', 'ai-history-grid']) {
    const target = new RegExp(`\\.${className}\\s*$`);
    const declarations = rules.filter(([, selectors]) => selectors.split(',').some(selector => target.test(selector.trim())))
      .map(([, , body]) => body).join('\n');
    assert.match(declarations, /(?:^|[;\n])\s*min-width:\s*0(?:px)?\s*;/,
      `${className} must not let an automatic grid minimum push either panel outside the card`);
  }
});

test('AI table bodies retain responsive card proportions without a 280px minimum height', async () => {
  const css = await readFile(new URL('../app/globals.css', import.meta.url), 'utf8');
  const bodyRules = [...css.matchAll(/\.ai-history-table-body\s*\{([^}]+)\}/g)].map(match => match[1]);
  assert.ok(bodyRules.length > 0);
  assert.match(bodyRules.join('\n'), /min-height:\s*0(?:px)?\s*;/);
  for (const rule of bodyRules) assert.doesNotMatch(rule, /min-height:\s*280px\s*;/);
});

test('a complete 80-round shoe renders exactly 80 actual and 80 directional prediction cells', () => {
  const outcomes = Array.from({ length: 80 }, (_, index) => ['3', '2', '1', '2', '2', '1', '3'][index % 7]);
  const result = completeAiHistory(baccaratRoads(outcomes.map(Number)).bigRoad, ['deepseek'], outcomes);
  assert.ok(result);
  const html = renderToStaticMarkup(React.createElement(module.exports.AiPredictionHistory,
    { rounds: result.history, status: '下局莊' }));
  const panels = [...html.matchAll(/<section\b[^>]*>([\s\S]*?)<\/section>/g)].map(match => match[1]);
  for (const panel of panels) assert.equal([...panel.matchAll(/class="ai-history-cell"/g)].length, 80);
  assert.equal([...panels[1].matchAll(/dominant-baseline="central"[^>]*>[莊閒]<\/text>/g)].length, 80);
  assert.doesNotMatch(html, /未記錄|補值|>\?<\/text>/);
  assert.equal(result.performance.noSignal, 0);
  assert.equal(result.performance.correct, result.history.filter(round => round.result === '命中').length);
});

test('an unrecorded tie displays no signal opposite the actual tie, without altering the record', () => {
  const round = { position: 2, prediction: undefined, outcome: '3', origin: 'unrecorded', result: '和局' };
  const original = structuredClone(round);
  const html = renderRound(round);
  const panels = [...html.matchAll(/<section\b[^>]*>([\s\S]*?)<\/section>/g)].map(match => match[1]);
  assert.equal(panels.length, 2);
  assert.match(panels[0], />和<\/text>/);
  assert.match(panels[1], />—<\/text>/);
  assert.match(html, /預測無訊號，實際和，和局，不計命中／錯誤/);
  assert.doesNotMatch(html, /未記錄|補值|>\?<\/text>/);
  assert.match(html, /data-origin="unrecorded"/);
  assert.deepEqual(round, original);
});

test('saved player and banker predictions remain visible when the actual outcome is a tie', () => {
  for (const [prediction, label] of [['1', '閒'], ['2', '莊']]) {
    const html = renderRound({ position: 2, prediction, outcome: '3', origin: 'observed', result: '和局' });
    assert.ok(html.includes(`預測${label}，實際和，和局，當時紀錄`));
    const predictionPanel = [...html.matchAll(/<section\b[^>]*>([\s\S]*?)<\/section>/g)][1][1];
    assert.ok(predictionPanel.includes(`>${label}</text>`));
  }
});

test('settled hits and misses keep their recorded directions and verdicts', () => {
  const hit = renderRound({ position: 2, prediction: '1', outcome: '1', origin: 'observed', result: '命中' });
  assert.match(hit, /預測閒，實際閒，命中，當時紀錄/);
  const miss = renderRound({ position: 2, prediction: '2', outcome: '1', origin: 'observed', result: '錯誤' });
  assert.match(miss, /預測莊，實際閒，錯誤，當時紀錄/);
});

test('a pending round is still awaiting settlement, not a tie or a completed result', () => {
  const html = renderRound({ position: 3, prediction: '2', origin: 'pending', result: '待開獎' });
  assert.match(html, /預測莊，實際待開獎，待開獎，待開獎/);
  assert.match(html, /stroke-dasharray="3 2"/);
  assert.doesNotMatch(html, /不計命中／錯誤|實際和/);
});
