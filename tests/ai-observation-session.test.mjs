import test from 'node:test';
import assert from 'node:assert/strict';
import { createObservationSessions, updateObservationSessions } from '../lib/ai-observation-session.ts';
import { advanceObservedAi, aiObservationIdentity, observedAiPerformance } from '../lib/ai-observed-predictions.ts';
import { baccaratRoads } from '../lib/dg-card.ts';

const table = (winners, extra = {}) => ({ id: 'AB:144', shoe: '—', ...baccaratRoads(winners), ...extra });
const vote = side => ({ side, active: 1, required: 1, votes: [{ source: 'deepseek', side }] });
const identity = state => aiObservationIdentity('AB:144', '—', 'deepseek', ['deepseek'], state.tables.get('AB:144').epoch);

test('one live feed identity survives card/action/betting/route remounts and settles saved predictions', () => {
  let sessions = updateObservationSessions(createObservationSessions('browser1'), [table([2])], 1000);
  const key = identity(sessions).key;
  let ledger = advanceObservedAi(undefined, key, sessions.tables.get('AB:144').snapshot, vote('2'));
  sessions = updateObservationSessions(sessions, [table([2, 2])], 2000);
  assert.equal(identity(sessions).key, key);
  ledger = advanceObservedAi(ledger, key, sessions.tables.get('AB:144').snapshot, vote('2'));
  assert.equal(observedAiPerformance(ledger).streak, 1);
  // A new card instance consumes the feed epoch, not its mount counter.
  sessions = updateObservationSessions(sessions, [table([2, 2])], 3000);
  assert.equal(identity(sessions).key, key);
  assert.equal(identity(sessions).persistent, false, 'unknown official shoe is never restored across browser sessions');
  sessions = updateObservationSessions(sessions, [table([2, 2, 1])], 4000);
  ledger = advanceObservedAi(ledger, identity(sessions).key, sessions.tables.get('AB:144').snapshot, vote('1'));
  assert.equal(observedAiPerformance(ledger).streak, 0);
  assert.equal(observedAiPerformance(ledger).missStreak, 1);
  assert.equal(observedAiPerformance(ledger).maxStreak, 1);
});

test('one rollback or contradictory packet cannot erase an unknown-shoe identity', () => {
  const original = updateObservationSessions(createObservationSessions('browser1'), [table([2, 2])], 1000);
  const before = identity(original).key;
  assert.equal(identity(updateObservationSessions(original, [table([2])], 2000)).key, before);
  assert.equal(identity(updateObservationSessions(original, [table([1, 2])], 2000)).key, before);
  assert.notEqual(identity(updateObservationSessions(original, [table([2, 2])], 32_000)).key, before);
  assert.equal(identity(updateObservationSessions(original, [table([2, 2])], 20_000)).key, before);
});

test('a new unknown shoe without a witnessed shuffle requires a forward-confirmed new history', () => {
  let sessions = updateObservationSessions(createObservationSessions('browser1'), [table([2, 2, 1, 2])], 1000);
  const before = identity(sessions).key;
  sessions = updateObservationSessions(sessions, [table([1])], 2000);
  assert.equal(identity(sessions).key, before);
  sessions = updateObservationSessions(sessions, [table([1])], 3000);
  assert.equal(identity(sessions).key, before, 'repeating one suspect snapshot is not proof');
  sessions = updateObservationSessions(sessions, [table([1, 2])], 4000);
  assert.notEqual(identity(sessions).key, before);
});

test('recovering from one stale snapshot retains the same session and original results', () => {
  let sessions = updateObservationSessions(createObservationSessions('browser1'), [table([2, 2, 1])], 1000);
  const before = identity(sessions).key;
  sessions = updateObservationSessions(sessions, [table([2, 2])], 2000);
  assert.equal(identity(sessions).key, before);
  sessions = updateObservationSessions(sessions, [table([2, 2, 1, 2])], 3000);
  assert.equal(identity(sessions).key, before);
  assert.equal(sessions.tables.get('AB:144').snapshot.total, 4);
  assert.equal(sessions.tables.get('AB:144').resetCandidate, undefined);
});

test('shuffle stops the pending signal but retains results until the actual next shoe', () => {
  let sessions = updateObservationSessions(createObservationSessions('browser1'), [table([2, 2])], 1000);
  const before = identity(sessions).key;
  sessions = updateObservationSessions(sessions, [table([2, 2], { tableState: '2' })], 2000);
  assert.equal(identity(sessions).key, before);
  sessions = updateObservationSessions(sessions, [table([])], 3000);
  assert.notEqual(identity(sessions).key, before);
});

test('partial updates cannot reset the session; official shoes use their existing independent identity', () => {
  const original = updateObservationSessions(createObservationSessions('browser1'), [table([2, 2])], 1000);
  const partial = updateObservationSessions(original, [table([2, 2], { banker: '3' })], 2000);
  assert.equal(identity(partial).key, identity(original).key);
  assert.equal(partial.tables.get('AB:144').seenAt, 1000);
  const known = updateObservationSessions(original, [table([1], { id: 'DG:144', shoe: '23' })], 3000);
  assert.equal(known.tables.has('DG:144'), false);
});

test('a slower copy of the same card cannot overwrite results from the faster copy', () => {
  let sessions = updateObservationSessions(createObservationSessions('browser1'), [table([2])], 1000);
  const key = identity(sessions).key;
  const oldSnapshot = sessions.tables.get('AB:144').snapshot;
  let ledger = advanceObservedAi(undefined, key, oldSnapshot, vote('2'));
  sessions = updateObservationSessions(sessions, [table([2, 1])], 2000);
  ledger = advanceObservedAi(ledger, key, sessions.tables.get('AB:144').snapshot, vote('1'));
  const stale = advanceObservedAi(ledger, key, oldSnapshot, vote('2'));
  assert.equal(stale, ledger);
  assert.equal(observedAiPerformance(stale).missStreak, 1);
  assert.equal(observedAiPerformance(stale).maxMissStreak, 1);
});
