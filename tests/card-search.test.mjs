import test from 'node:test';
import assert from 'node:assert/strict';
import { cardSearch } from '../lib/card-search.ts';

test('one digit filters a category without matching codes in other categories', () => {
  assert.equal(cardSearch('2|201|一般牌卡|MT牌卡', '2'), 1);
  assert.equal(cardSearch('1|102|圖形牌卡|十字牌卡', '2'), 0);
});

test('three digits find one card and names remain searchable', () => {
  assert.equal(cardSearch('1|101|圖形牌卡|V型牌卡', '101'), 1);
  assert.equal(cardSearch('1|102|圖形牌卡|十字牌卡', '101'), 0);
  assert.equal(cardSearch('4|402|AI牌卡|Google Gemini', 'gemini'), 1);
  assert.equal(cardSearch('5|505|路單策略牌卡|馬可夫轉移牌卡', '5'), 1);
  assert.equal(cardSearch('5|505|路單策略牌卡|馬可夫轉移牌卡', '505'), 1);
});
