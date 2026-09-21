import test from 'node:test';
import assert from 'node:assert/strict';
import { aiConsensus, aiSources, localSignal } from '../lib/ai-consensus.ts';

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
