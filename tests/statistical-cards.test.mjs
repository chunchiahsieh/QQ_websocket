import test from 'node:test';
import assert from 'node:assert/strict';
import { beadWinners, weightedSignal, weightedConsensus, winningPointSignal } from '../lib/statistical-cards.ts';

test('bead outcomes are read chronologically', () => {
  assert.deepEqual(beadWinners('010203#0201'), ['1', '2', '3', '2', '1']);
});

test('weighted card abstains on sparse history and picks a clear tendency', () => {
  assert.equal(weightedSignal(['2', '2']).answer, '無訊號');
  assert.equal(weightedSignal(Array(12).fill('1')).answer, '閒');
  const history = [...Array(18).fill('1'), ...Array(18).fill('2')];
  assert.equal(weightedSignal(history.slice(-18), 18).sample, 18);
  assert.match(weightedSignal(history.slice(-24), 24).reason, /最近 24 局/);
  assert.equal(weightedSignal(history, 36).sample, 36);
});

test('weighted consensus needs two distinct full windows with the same signal', () => {
  assert.equal(weightedConsensus(Array(18).fill('2')).answer, '無訊號');
  assert.equal(weightedConsensus(Array(36).fill('2')).answer, '莊');
  assert.equal(weightedConsensus(Array(36).fill('3')).answer, '無訊號');
});

test('winning-point card abstains when samples are insufficient', () => {
  assert.equal(winningPointSignal([{ side: '2', points: 8 }]).answer, '無訊號');
});
