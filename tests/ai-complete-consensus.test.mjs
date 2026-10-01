import test from 'node:test';
import assert from 'node:assert/strict';
import { aiConsensus, aiSources, canonicalAiRoad, completeAiConsensus } from '../lib/ai-consensus.ts';
import { advanceObservedAi, aiObservationSnapshot, restoreObservedAi } from '../lib/ai-observed-predictions.ts';

const roads = Array.from({ length: 100 }, (_, index) => `0${Math.floor(index / 10)}${index % 10}2`);
const selections = Array.from({ length: 15 }, (_, index) => aiSources.filter((_, bit) => (index + 1) & (1 << bit)));
const key = 'complete-consensus-test';
const snapshot = outcomes => aiObservationSnapshot(outcomes.map(side => `0${side}`).join(''),
  outcomes.length, false, outcomes.filter(side => side !== '3').length);
const reopen = ledger => {
  const restored = restoreObservedAi(JSON.stringify(ledger), key);
  assert.ok(restored);
  return restored;
};
const abstention = () => {
  const selected = ['deepseek'];
  const raw = roads.find(value => aiConsensus(value, selected).active === 0);
  assert.ok(raw, 'the fixture includes a real source abstention');
  return { raw, selected, original: aiConsensus(raw, selected), completed: completeAiConsensus(raw, selected) };
};

test('completing consensus preserves every existing direction and its confidence', () => {
  let existingDirections = 0;
  for (const selected of selections) for (const raw of roads) {
    const original = aiConsensus(raw, selected);
    if (original.side === undefined) continue;
    existingDirections++;
    assert.deepEqual(completeAiConsensus(raw, selected), original);
  }
  assert.ok(existingDirections > 0);
});

test('every nonempty selection gets a repeatable direction without changing source votes or confidence', () => {
  let missingDirections = 0;
  for (const selected of selections) for (const raw of ['', ...roads]) {
    const original = aiConsensus(raw, selected);
    const completed = completeAiConsensus(raw, selected);
    assert.ok(completed.side === '1' || completed.side === '2');
    assert.deepEqual(completeAiConsensus(raw, [...selected]), completed);
    assert.deepEqual({ ...completed, side: original.side }, original);
    if (original.side === undefined) missingDirections++;
  }
  assert.ok(missingDirections > selections.length, 'coverage includes abstentions beyond the empty-road cases');
});

test('fallback ignores selection order, road padding and later tie-counter changes', () => {
  const selected = aiSources.slice(0, 2);
  const raw = roads.find(value => {
    const consensus = aiConsensus(value, selected);
    return consensus.side === undefined && consensus.active === 2;
  });
  assert.ok(raw, 'the fixture includes opposing real votes');
  const expected = completeAiConsensus(raw, selected).side;
  const variants = [raw, `${raw},,,,,`, `9${raw.slice(1)}`, `#9${raw.slice(1)},,,,,#`];
  for (const variant of variants) for (const sources of [selected, [...selected].reverse()]) {
    assert.equal(canonicalAiRoad(variant), canonicalAiRoad(raw));
    const original = aiConsensus(variant, sources);
    assert.equal(original.side, undefined, 'this must exercise fallback rather than an existing majority');
    const completed = completeAiConsensus(variant, sources);
    assert.equal(completed.side, expected);
    assert.deepEqual(completed.votes, original.votes);
    assert.equal(completed.active, original.active);
    assert.equal(completed.required, original.required);
  }
  assert.equal(completeAiConsensus('', selected).side, completeAiConsensus('', [...selected].reverse()).side);
});

test('completing an abstention does not invent a supporting vote or a majority', () => {
  const { original, completed } = abstention();
  assert.equal(original.side, undefined);
  assert.equal(completed.active, 0);
  assert.equal(completed.required, 1);
  assert.deepEqual(completed.votes, [{ source: 'deepseek', side: undefined }]);
  assert.equal(completed.votes.filter(vote => vote.side === completed.side).length, 0);
});

test('an empty source selection never invents a direction', () => {
  for (const raw of ['', ...roads]) {
    assert.deepEqual(completeAiConsensus(raw, []), aiConsensus(raw, []));
    assert.equal(completeAiConsensus(raw, []).side, undefined);
  }
});

test('direction-required mode upgrades only the current abstention, then restores and settles it once', () => {
  const { original, completed } = abstention();
  const first = advanceObservedAi(undefined, key, snapshot([]), original);
  const withPastAbstention = advanceObservedAi(first, key, snapshot(['2']), original);
  assert.equal(withPastAbstention.decisions[0].prediction, undefined);
  const restored = reopen(withPastAbstention);
  const upgraded = advanceObservedAi(restored, key, snapshot(['2']), completed, true);
  assert.equal(restored.pending.prediction, undefined, 'upgrading must not mutate the saved input');
  assert.equal(upgraded.pending.prediction, completed.side);
  assert.equal(upgraded.pending.position, 2);
  assert.equal(upgraded.pending.agreement, 0);
  assert.equal(upgraded.pending.activeVotes, 0);
  assert.deepEqual(upgraded.pending.votes, completed.votes);
  assert.deepEqual(upgraded.decisions, restored.decisions, 'settled abstentions are never rewritten');
  const reopened = reopen(upgraded);
  assert.equal(advanceObservedAi(reopened, key, snapshot(['2']), completed, true), reopened);
  const outcome = completed.side === '1' ? '2' : '1';
  const outcomes = ['2', outcome];
  const settled = advanceObservedAi(reopened, key, snapshot(outcomes), completeAiConsensus('0102', ['deepseek']), true);
  assert.equal(settled.decisions.length, 2);
  assert.equal(settled.decisions[0].prediction, undefined);
  assert.equal(settled.decisions[1].position, 2);
  assert.equal(settled.decisions[1].prediction, completed.side);
  assert.equal(settled.decisions[1].outcome, outcome);
  const settledAgain = reopen(settled);
  assert.equal(advanceObservedAi(settledAgain, key, snapshot(outcomes), completed, true), settledAgain);
  assert.equal(settledAgain.decisions.length, 2);
});

test('the default mode retains pending abstentions and a missing new direction cannot upgrade them', () => {
  const { original, completed } = abstention();
  const pending = advanceObservedAi(undefined, key, snapshot(['2']), original);
  assert.equal(advanceObservedAi(pending, key, snapshot(['2']), completed), pending);
  assert.equal(advanceObservedAi(pending, key, snapshot(['2']), completed, false), pending);
  assert.equal(advanceObservedAi(pending, key, snapshot(['2']), original, true), pending);
  assert.equal(pending.pending.prediction, undefined);
});

test('direction-required mode cannot replace an existing locked banker or player prediction', () => {
  for (const side of ['1', '2']) {
    const selected = ['deepseek'];
    const raw = roads.find(value => aiConsensus(value, selected).side === side);
    const contraryRaw = roads.find(value => aiConsensus(value, selected).side !== undefined
      && aiConsensus(value, selected).side !== side);
    assert.ok(raw);
    assert.ok(contraryRaw);
    const locked = reopen(advanceObservedAi(undefined, key, snapshot(['2']), completeAiConsensus(raw, selected), true));
    const contrary = completeAiConsensus(contraryRaw, selected);
    assert.equal(advanceObservedAi(locked, key, snapshot(['2']), contrary, true), locked);
    const settled = advanceObservedAi(locked, key, snapshot(['2', side]), contrary, true);
    assert.equal(settled.decisions[0].prediction, side);
    assert.equal(settled.decisions[0].outcome, side);
    assert.equal(settled.pending.prediction, contrary.side);
  }
});
