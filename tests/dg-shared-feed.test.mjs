import assert from 'node:assert/strict';
import { currentDgFeedMessage, publishDgFeed } from '../lib/dg-shared-feed.ts';

const room = `dg-shared-feed-${Date.now()}-${Math.random()}`;
const receivedAt = Date.now();

assert.equal(publishDgFeed(room, {
  type: 'snapshot', tables: [{ id: 'DG:RB01' }], receivedAt, collectorId: 'collector-a', sequence: 2,
}), true, 'collector snapshot is accepted');

assert.equal(publishDgFeed(room, {
  type: 'snapshot', tables: [{ id: 'DG:old' }], receivedAt: receivedAt - 1, collectorId: 'collector-a', sequence: 1,
}), false, 'late relay data cannot rewind a table snapshot');

assert.equal(currentDgFeedMessage(room).tables?.[0]?.id, 'DG:RB01', 'viewers receive the collector snapshot');

assert.equal(publishDgFeed(room, {
  type: 'status', status: 'offline', message: 'reconnecting', receivedAt: receivedAt + 1, collectorId: 'collector-a', sequence: 3,
}), true, 'collector status is accepted');
assert.equal(currentDgFeedMessage(room).tables?.[0]?.id, 'DG:RB01', 'reconnect status never clears the last valid DG snapshot');

console.log('PASS: DG shared feed rejects stale packets and preserves the latest snapshot during reconnect');
