// 用真实采集结果（2026-10 京东新版商品页）做归一化回归
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeProduct, validateProduct } from '../src/shared/product-normalize.js';

const raw = JSON.parse(readFileSync(new URL('./fixtures/item-100035179134.raw.json', import.meta.url), 'utf8'));

test('real item normalizes into a publishable product', () => {
  const p = normalizeProduct(raw);
  assert.equal(p.title, '德芙香浓黑巧克力 桶装480g 休闲零食糖果 节日礼物 送女友礼物');
  assert.deepEqual(p.brand, { id: 5962, name: '德芙（Dove）' });
  assert.equal(p.leafCategory, '牛奶巧克力');
  assert.equal(p.price, 45.9);
  assert.equal(p.mainImages.length, 6);
  assert.ok(p.mainImages.every((u) => u.startsWith('https://img14.360buyimg.com/sku/jfs/')));
  assert.equal(p.detailImages.length, 13);
  assert.ok(p.detailImages.every((u) => /^https:\/\/img30\.360buyimg\.com\/sku\/jfs\/.+\.(jpg|png)$/.test(u)));
  assert.deepEqual(p.saleDims, [{ name: '规格', values: ['黑巧480g'] }]);
  assert.deepEqual(validateProduct(p), []);
});
