import { test } from 'node:test';
import assert from 'node:assert/strict';
import { abTablePhase } from '../lib/ab-phase.ts';
import { tableOverlayLabel } from '../lib/table-state.ts';

test('AB opening begins at a verified official zero-countdown event', () => {
  assert.equal(tableOverlayLabel('AB:B201', undefined, '歐博', abTablePhase(100, false)), null);
  assert.equal(tableOverlayLabel('AB:B201', undefined, '歐博', abTablePhase(100, true)), '開牌中');
  assert.equal(abTablePhase(101, undefined), undefined);
  assert.equal(abTablePhase(101, false), undefined);
  assert.equal(abTablePhase(101, true), undefined);
  assert.equal(abTablePhase(102, true), undefined);
  assert.equal(tableOverlayLabel('AB:B201', '2', '歐博', abTablePhase(102, false)), '洗牌中');
});
