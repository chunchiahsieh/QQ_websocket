import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
registerHooks({ resolve(specifier, context, next) {
  return next(specifier === './dg-card' ? new URL('../lib/dg-card.ts', import.meta.url).href : specifier, context);
} });
const { abCard } = await import('../lib/ab-card.ts');

test('AB uses its own chronological results, points and shuffling code', () => {
  const card = abCard({ tableId:'10', tableName:'B201', state:102,
    results:['186060100000','27858A302000','04420A000000','550050000000','626000000000'] });
  assert.equal(card.id,'AB:10');
  assert.equal(card.banker,'2'); assert.equal(card.player,'2'); assert.equal(card.tie,'1');
  assert.equal(card.tableState,'2');
  assert.match(card.bigRoad,/0802/); assert.match(card.bigRoad,/1801/);
  assert.equal(card.players,'—');
});
test('AB discards incomplete results without inventing winners', () => {
  const card = abCard({ tableId:'10', results:['-1','garbage'], state:100 });
  assert.equal(card.banker,'0'); assert.equal(card.bigRoad,''); assert.equal(card.tableState,undefined);
});
test('AB forwards dealer media into the shared card and leaves unavailable video disabled', () => {
  const card = abCard({ tableId:'10', dealerPhoto:'https://www.axgglm.net/dealer/Dealer_123.jpg',
    videoUrl:'https://v-tx.pinpfz.com/live/example.flv' });
  assert.equal(card.dealerPhoto,'https://www.axgglm.net/dealer/Dealer_123.jpg');
  assert.equal(card.videoUrl,'https://v-tx.pinpfz.com/live/example.flv');
  assert.equal(abCard({tableId:'10',videoUrl:''}).videoUrl,undefined);
});
