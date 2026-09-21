import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
registerHooks({ resolve(specifier, context, next) {
  const local = {
    './dg-card': '../lib/dg-card.ts',
    './ab-phase': '../lib/ab-phase.ts',
    './table-state': '../lib/table-state.ts',
  };
  return next(local[specifier] ? new URL(local[specifier], import.meta.url).href : specifier, context);
} });
const { abCard } = await import('../lib/ab-card.ts');
const { tableOverlayLabel } = await import('../lib/table-state.ts');

test('AB uses its own chronological results, points and shuffling code', () => {
  const card = abCard({ tableId:'10', tableName:'B201', state:102,
    results:['186060100000','27858A302000','04420A000000','550050000000','626000000000'] });
  assert.equal(card.id,'AB:10');
  assert.equal(card.banker,'2'); assert.equal(card.player,'2'); assert.equal(card.tie,'1');
  assert.equal(card.tableState,'2');
  assert.equal(card.tablePhase,undefined);
  assert.match(card.bigRoad,/0802/); assert.match(card.bigRoad,/1801/);
  assert.equal(card.players,'—');
});
test('AB discards incomplete results without inventing winners', () => {
  const card = abCard({ tableId:'10', results:['-1','garbage'], state:100 });
  assert.equal(card.banker,'0'); assert.equal(card.bigRoad,''); assert.equal(card.tableState,undefined);
  assert.equal(card.tablePhase,undefined);
});

test('AB does not present enterCount as live online players', () => {
  const card = abCard({ tableId:'10', onlineCount:739, results:[] });
  assert.equal(card.players, '—');
});
test('AB countdown opening shows dealing while status 101 ends it', () => {
  const dealing = abCard({ tableId:'10', state:100, openingStarted:true });
  assert.equal(dealing.tablePhase,'dealing');
  assert.equal(dealing.tableState,undefined);
  assert.equal(tableOverlayLabel(dealing.id, dealing.tableState, '歐博', dealing.tablePhase), '開牌中');
  const ended = abCard({ tableId:'10', state:101, openingStarted:true });
  assert.equal(ended.tablePhase,undefined);
  const ready = abCard({ tableId:'10', state:100 });
  assert.equal(ready.tablePhase,undefined);
  assert.equal(ready.tableState,undefined);
  assert.equal(tableOverlayLabel(ready.id, ready.tableState, '歐博', ready.tablePhase), null);
});
test('AB forwards dealer media into the shared card and leaves unavailable video disabled', () => {
  const card = abCard({ tableId:'10', dealerPhoto:'https://www.axgglm.net/dealer/Dealer_123.jpg',
    videoUrl:'https://v-tx.pinpfz.com/live/example.flv' });
  assert.equal(card.dealerPhoto,'https://www.axgglm.net/dealer/Dealer_123.jpg');
  assert.equal(card.videoUrl,'https://v-tx.pinpfz.com/live/example.flv');
  assert.equal(abCard({tableId:'10',videoUrl:''}).videoUrl,undefined);
});
