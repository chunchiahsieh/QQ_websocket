import test from 'node:test';
import assert from 'node:assert/strict';
import { aiConsensus, aiSources, canonicalAiRoad, localSignal } from '../lib/ai-consensus.ts';
import { predictionPerformance } from '../lib/ai-prediction-performance.ts';

test('one selected source can abstain and emit no signal', () => {
  const raw = Array.from({ length: 1000 }, (_, index) => `road-${index}`)
    .find(value => localSignal(value, aiSources[0]) === undefined);
  assert.ok(raw);
  assert.equal(aiConsensus(raw, [aiSources[0]]).side, undefined);
});

test('two opposing votes do not produce a consensus', () => {
  const raw = Array.from({ length: 1000 }, (_, index) => `road-${index}`)
    .find(value => localSignal(value, aiSources[0]) && localSignal(value, aiSources[1])
      && localSignal(value, aiSources[0]) !== localSignal(value, aiSources[1]));
  assert.ok(raw);
  const result = aiConsensus(raw, aiSources.slice(0, 2));
  assert.equal(result.required, 2);
  assert.equal(result.side, undefined);
});

test('abstentions do not count toward the selected-source majority', () => {
  const raw = Array.from({ length: 1000 }, (_, index) => `road-${index}`)
    .find(value => localSignal(value, aiSources[0]) && localSignal(value, aiSources[1]) === undefined);
  assert.ok(raw);
  const result = aiConsensus(raw, aiSources.slice(0, 2));
  assert.equal(result.active, 1);
  assert.equal(result.side, localSignal(raw, aiSources[0]));
});

test('two player votes beat one banker vote when the fourth source abstains', () => {
  const raw = Array.from({ length: 10000 }, (_, index) => `road-${index}`)
    .find(value => {
      const sides = aiSources.map(source => localSignal(value, source));
      return sides.filter(side => side === '1').length === 2
        && sides.filter(side => side === '2').length === 1
        && sides.filter(side => side === undefined).length === 1;
    });
  assert.ok(raw);
  const result = aiConsensus(raw, aiSources);
  assert.equal(result.active, 3);
  assert.equal(result.required, 2);
  assert.equal(result.side, '1');
});

test('DeepSeek counts an actual player result as a miss after predicting banker on a padded road', () => {
  const before = Array.from({ length: 10 }, (_, point) => `0${point}02,,,,,`)
    .find(raw => aiConsensus(raw, ['deepseek']).side === '2');
  assert.ok(before, 'a padded road must produce a banker test signal');
  const after = `${before}#0101,,,,,`;
  const performance = predictionPerformance(after, ['deepseek']);
  assert.equal(performance.decisions.at(-1)?.prediction, '2');
  assert.equal(performance.decisions.at(-1)?.outcome, '1');
  assert.equal(performance.lastResult, '錯誤');
  assert.equal(performance.streak, 0);
  assert.equal(performance.missStreak, 1);
});

test('AI input ignores empty road padding and later tie-counter changes', () => {
  assert.equal(canonicalAiRoad('0102,,,,,'), canonicalAiRoad('9102'));
  assert.equal(aiConsensus('0102,,,,,', ['deepseek']).side, aiConsensus('9102', ['deepseek']).side);
});
