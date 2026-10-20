import { test } from 'node:test';
import assert from 'node:assert/strict';
import { THUMB_LIMIT, normalizeSpus, spuListSkus, needsItemPage, normalizeItemSkus } from '../src/shared/shop-spu.js';

test('normalizeSpus: 只保留数字编码，缩略图去重；页面没有缩略图栏时 sids 为 null', () => {
  const raw = [
    { sku: '100000481562', sids: ['100000481562', '8923703', '8923703', 'x', ''] },
    { sku: '7481134', sids: null },
    { sku: 'abc', sids: ['1234567'] },
    null,
    { sku: '100000481562', sids: [] },
  ];
  assert.deepEqual(normalizeSpus(raw), [
    { sku: '100000481562', sids: ['100000481562', '8923703'] },
    { sku: '7481134', sids: null },
  ]);
  assert.deepEqual(normalizeSpus(undefined), []);
  assert.deepEqual(normalizeSpus({}), []);
});

test('spuListSkus: 列表上能看到的全部 SKU（主 SKU + 缩略图），保持顺序去重', () => {
  const spus = [
    { sku: '1000001', sids: ['1000001', '1000002'] },
    { sku: '1000003', sids: null },
    { sku: '1000004', sids: ['1000002', '1000005'] },
  ];
  assert.deepEqual(spuListSkus(spus), ['1000001', '1000002', '1000003', '1000004', '1000005']);
});

test('needsItemPage: 缩略图少于 5 个时列表已完整，不打开商品页', () => {
  const sids = (n) => Array.from({ length: n }, (_, i) => String(1000000 + i));
  assert.equal(THUMB_LIMIT, 5);
  assert.equal(needsItemPage({ sku: '1000000', sids: sids(4) }, new Set()), false);
  assert.equal(needsItemPage({ sku: '1000000', sids: [] }, new Set()), false);
  // 正好 5 个可能被截断（实测 14 个规格的 SPU 列表上只显示 5 个）
  assert.equal(needsItemPage({ sku: '1000000', sids: sids(5) }, new Set()), true);
  // 模板不显示缩略图时无法判断，需要打开
  assert.equal(needsItemPage({ sku: '1000000', sids: null }, new Set()), true);
});

test('needsItemPage: 主 SKU 已在之前打开的商品页里读到过（同一个 SPU）时不再打开', () => {
  const sids = Array.from({ length: 5 }, (_, i) => String(1000000 + i));
  assert.equal(needsItemPage({ sku: '1000000', sids }, new Set(['1000000'])), false);
  assert.equal(needsItemPage({ sku: '2000000', sids: null }, new Set(['1000000'])), true);
});

test('normalizeItemSkus: 商品页读到的编码只保留数字并去重，主 SKU 放在最前', () => {
  assert.deepEqual(normalizeItemSkus({ skuIds: ['8923703', '100000481562', '8923703', 'bad'] }, '100000481562'), ['100000481562', '8923703']);
  assert.deepEqual(normalizeItemSkus({ skuIds: [] }, '100000481562'), []);
  assert.deepEqual(normalizeItemSkus(null, '100000481562'), []);
});
