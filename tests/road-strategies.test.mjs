import test from 'node:test';
import assert from 'node:assert/strict';
import { followRoad, reverseRoad, streakRoad, sequenceRoad, markovRoad } from '../lib/road-strategies.ts';

test('follow, reverse and streak use only completed decisive rounds', () => {
  assert.equal(followRoad(['1', '3', '2']).side, '2');
  assert.equal(reverseRoad(['1', '3', '2']).side, '1');
  assert.equal(streakRoad(['2', '3', '2', '2'], 3, true).side, '2');
  assert.equal(streakRoad(['2', '3', '2', '2'], 3, false).side, '1');
  assert.equal(streakRoad(['2', '1', '2'], 3, true).side, undefined);
});

test('sequence and Markov abstain without enough matching historical contexts', () => {
  assert.equal(sequenceRoad(['1', '2', '1'], 2).side, undefined);
  assert.equal(markovRoad(['2', '2', '1'], 1).side, undefined);
  assert.equal(sequenceRoad(Array(18).fill('2'), 3).side, '2');
  assert.equal(markovRoad(Array(18).fill('1'), 1).side, '1');
});

test('sequence requires exact context while Markov can back off to shorter state', () => {
  const history = [...Array.from({ length: 30 }, (_, index) => index % 2 ? '1' : '2'), '2', '2'];
  assert.equal(sequenceRoad(history, 3).side, undefined);
  const markov = markovRoad(history, 3);
  assert.equal(markov.usedOrder, 1);
  assert.ok(markov.sample >= 10);
});
