import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePrice } from '../src/shared/pricing.js';
import { weightedLength, truncateWeighted, cleanTitle } from '../src/shared/title.js';

test('parsePrice reads numbers from price text', () => {
  assert.equal(parsePrice('￥39.90'), 39.9);
  assert.equal(parsePrice('¥ 1,299.00'), 1299);
  assert.equal(parsePrice('暂无报价'), null);
  assert.equal(parsePrice(undefined), null);
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
