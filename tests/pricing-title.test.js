import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePrice, computePrice, retailPrice } from '../src/shared/pricing.js';
import { weightedLength, truncateWeighted, cleanTitle } from '../src/shared/title.js';

test('parsePrice reads numbers from price text', () => {
  assert.equal(parsePrice('￥39.90'), 39.9);
  assert.equal(parsePrice('¥ 1,299.00'), 1299);
  assert.equal(parsePrice('暂无报价'), null);
  assert.equal(parsePrice(undefined), null);
});

test('computePrice applies multiplier and add with cent rounding', () => {
  assert.equal(computePrice(100, { multiplier: 1.1, add: 2, rounding: 'cent' }), 112);
  assert.equal(computePrice(33.333, { multiplier: 1, add: 0, rounding: 'cent' }), 33.33);
});

test('computePrice rounding modes', () => {
  assert.equal(computePrice(37.23, { rounding: 'jiao' }), 37.2);
  assert.equal(computePrice(37.5, { rounding: 'yuan' }), 38);
  assert.equal(computePrice(37.23, { rounding: 'nine' }), 37.9);
  assert.equal(computePrice(37.95, { rounding: 'nine' }), 38.9);
});

test('computePrice enforces minimum price and rejects invalid source', () => {
  assert.equal(computePrice(0.001, { minPrice: 0.5 }), 0.5);
  assert.equal(computePrice(null, {}), null);
  assert.equal(computePrice(-3, {}), null);
});

test('retailPrice is the sale price × 1.1 ending in .9, always above the sale price', () => {
  assert.equal(retailPrice(1.05), 1.9);
  assert.equal(retailPrice(52.9), 58.9);
  assert.equal(retailPrice(72.9), 80.9);
  assert.equal(retailPrice(null), null);
  assert.equal(retailPrice(0), null);
});

test('weightedLength counts CJK as 2', () => {
  assert.equal(weightedLength('测试标题ABC'), 11);
  assert.equal(weightedLength('（）'), 4);
  assert.equal(weightedLength(''), 0);
});

test('truncateWeighted cuts at weighted boundary', () => {
  assert.equal(truncateWeighted('测试标题ABC', 9), '测试标题A');
  assert.equal(truncateWeighted('测试', 3), '测');
  assert.equal(truncateWeighted('abc', 10), 'abc');
});

test('cleanTitle removes words, adds affixes and truncates main part', () => {
  const out = cleanTitle('京东自营 德芙（Dove）丝滑牛奶巧克力  252g', {
    removeWords: ['京东自营', '自营'],
    prefix: '',
    suffix: '',
    maxLength: 60,
  });
  assert.equal(out, '德芙（Dove）丝滑牛奶巧克力 252g');
});

test('cleanTitle keeps suffix when truncating', () => {
  const out = cleanTitle('一二三四五六七八九十', { suffix: 'X', maxLength: 9 });
  assert.equal(out, '一二三四X');
  assert.ok(weightedLength(out) <= 9);
});

test('cleanTitle tolerates missing options', () => {
  assert.equal(cleanTitle('  标题  '), '标题');
});
