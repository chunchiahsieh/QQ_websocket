import test from 'node:test';
import assert from 'node:assert/strict';
import { regressionCardSignal } from '../lib/regression-card-signals.ts';

test('new regression cards abstain with insufficient preceding observations', () => {
  for (const id of ['points', 'weighted', 'weighted-consensus', 'ai-consensus'])
    assert.equal(regressionCardSignal(id, [], []), undefined);
});

test('weighted and point cards use only supplied history', () => {
  const outcomes = Array(36).fill('2');
  const points = Array.from({ length: 36 }, () => ({ side: '2', points: 8 }));
  assert.equal(regressionCardSignal('points', outcomes, points), '莊');
  assert.equal(regressionCardSignal('weighted', outcomes, points), '莊');
  assert.equal(regressionCardSignal('weighted-consensus', outcomes, points), '莊');
});
