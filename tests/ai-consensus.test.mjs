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
  assert.equal(aiConsensus(raw, aiSources.slice(0, 2)).side, undefined);
});
