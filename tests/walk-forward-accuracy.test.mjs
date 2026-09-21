import test from 'node:test';
import assert from 'node:assert/strict';
import { walkForwardAccuracy } from '../lib/walk-forward-accuracy.ts';

const event = outcome => ({ outcome });

test('accuracy uses only results known before each reveal', () => {
  const seen = [];
  const results = ['1', '2', '1', '3', '2'].map(event);
  const accuracy = walkForwardAccuracy(results, known => {
    seen.push(known.map(item => item.outcome).join(''));
    return known.length === 3 ? undefined : '2';
  });
  assert.deepEqual(seen, ['1', '12', '121', '1213']);
  assert.deepEqual(accuracy, { hits: 2, evaluated: 3, noSignal: 0, ties: 1, percent: 66.7 });
});

test('ties and missing signals cannot inflate a banker/player hit rate', () => {
  assert.deepEqual(walkForwardAccuracy(['1', '3', '2'].map(event), () => '2'),
    { hits: 1, evaluated: 1, noSignal: 0, ties: 1, percent: 100 });
  assert.deepEqual(walkForwardAccuracy(['1', '2'].map(event), () => undefined),
    { hits: 0, evaluated: 0, noSignal: 1, ties: 0, percent: null });
});
