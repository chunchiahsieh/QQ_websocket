import assert from 'node:assert/strict';
import { addMtSubscriber, currentMtFeedMessage, publishMtFeed } from '../lib/mt-shared-feed.ts';

const room = `mt-shared-feed-${Date.now()}-${Math.random()}`;
const receivedAt = Date.now();
const newest = { type: 'snapshot', tables: [{ id: 'MT:1' }], receivedAt, collectorId: 'collector-a', sequence: 2 };

assert.equal(publishMtFeed(room, newest), true, 'first snapshot is accepted');
assert.equal(publishMtFeed(room, {
  type: 'snapshot', tables: [{ id: 'MT:old' }], receivedAt: receivedAt - 1, collectorId: 'collector-a', sequence: 1,
}), false, 'an older packet from one collector cannot rewind the shared snapshot');
assert.equal(currentMtFeedMessage(room).tables?.[0]?.id, 'MT:1');

assert.equal(publishMtFeed(room, {
  type: 'status', status: 'offline', message: 'reconnecting', receivedAt: receivedAt + 1, collectorId: 'collector-a', sequence: 3,
}), true, 'reconnect status is recorded');
assert.equal(currentMtFeedMessage(room).tables?.[0]?.id, 'MT:1', 'reconnect status keeps the last valid table snapshot');

const sent = [];
const remove = addMtSubscriber(room, { send: message => sent.push(message), close: () => {} }, 'viewer-a');
assert.equal(sent.at(-1)?.tables?.[0]?.id, 'MT:1', 'a new viewer receives the existing snapshot instead of a blank card');
remove();

console.log('PASS: MT shared feed rejects stale packets and preserves the latest snapshot during reconnect');
