import test from 'node:test';
import assert from 'node:assert/strict';
import { recentPointResults, pointCounts } from '../lib/point-analysis.ts';

test('only known winner point digits are counted', () => {
  const results = recentPointResults('0702,0?01#0301,0902,0103');
  assert.deepEqual(results, [{ side: '2', points: 7 }, { side: '1', points: 3 }, { side: '2', points: 9 }]);
  assert.equal(pointCounts(results, '2')[7], 1);
  assert.equal(pointCounts(results, '1')[3], 1);
});

test('recent point window is bounded', () => {
  assert.deepEqual(recentPointResults('0101,0202,0301', 2), [{ side: '2', points: 2 }, { side: '1', points: 3 }]);
});
