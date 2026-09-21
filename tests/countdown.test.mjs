import { test } from 'node:test';
import assert from 'node:assert/strict';
import { remainingCountdownSeconds } from '../lib/countdown.ts';

test('DG uses the official approximately 950ms tick without changing the origin', () => {
  const dg = { deadline: 19 * 950, receivedAt: 0, initialValue: 19, tickMilliseconds: 950 };
  assert.equal(remainingCountdownSeconds({ ...dg, now: 0 }), 19);
  assert.equal(remainingCountdownSeconds({ ...dg, now: 949 }), 19);
  assert.equal(remainingCountdownSeconds({ ...dg, now: 950 }), 18);
  assert.equal(remainingCountdownSeconds({ ...dg, now: 1900 }), 17);
  assert.equal(remainingCountdownSeconds({ ...dg, now: 11400 }), 7);
  assert.equal(remainingCountdownSeconds({ ...dg, now: 12350 }), 6);
  assert.equal(remainingCountdownSeconds({ ...dg, now: 20000 }), 0);
});

test('MT and AB still use a 1000ms deadline', () => {
  assert.equal(remainingCountdownSeconds({ deadline: 19_000, now: 950 }), 19);
  assert.equal(remainingCountdownSeconds({ deadline: 19_000, now: 1000 }), 18);
  assert.equal(remainingCountdownSeconds({ deadline: undefined, now: 0 }), null);
});
