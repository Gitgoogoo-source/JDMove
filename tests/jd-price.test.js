// 商品页价格取值：以页面实际显示的主价格为准（数据取自 2026-10 京东新版商品页 wareBusiness）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../src/inject/jd-price.js';

const { pickBusinessPrice } = globalThis.__JDMOVE__;

const biz = (priceItemList, price) => ({ warePriceGatherVO: { priceItemList }, price });

test('uses the subsidy price shown on the page, not the original price (sku 2020621)', () => {
  const b = biz(
    [{ hitLine: false, price: '60.5', priceType: 'bybtPrice', priceLabelList: [{ labelTxt: '补贴价' }] }],
    { id: '2020621', m: '95.00', op: '90.00', p: '60.50' },
  );
  assert.equal(pickBusinessPrice(b), '60.5');
});

test('uses the jd price when that is what the page shows (sku 100035179134)', () => {
  const b = biz([{ hitLine: false, price: '45.9', priceType: 'jdPrice' }], { m: '79.90', op: '59.90', p: '45.90' });
  assert.equal(pickBusinessPrice(b), '45.9');
});

test('skips strikethrough prices', () => {
  const b = biz(
    [
      { hitLine: true, price: '90', priceType: 'jdPrice' },
      { hitLine: false, price: '60.5', priceType: 'bybtPrice' },
    ],
    {},
  );
  assert.equal(pickBusinessPrice(b), '60.5');
});

test('falls back to price.p, then price.op, when the price list is missing', () => {
  assert.equal(pickBusinessPrice({ price: { op: '90.00', p: '60.50' } }), '60.50');
  assert.equal(pickBusinessPrice({ price: { op: '90.00' } }), '90.00');
  assert.equal(pickBusinessPrice(biz([{ hitLine: false, price: '' }], { p: '60.50' })), '60.50');
});

test('returns empty string when no price is available', () => {
  assert.equal(pickBusinessPrice({}), '');
  assert.equal(pickBusinessPrice(null), '');
});

test('price info carries the label shown next to the price', () => {
  const { pickBusinessPriceInfo } = globalThis.__JDMOVE__;
  const subsidy = biz([{ hitLine: false, price: '60.5', priceType: 'bybtPrice', priceLabelList: [{ labelTxt: '百亿补贴' }] }], {});
  assert.deepEqual(pickBusinessPriceInfo(subsidy), { price: '60.5', label: '百亿补贴' });
  assert.deepEqual(pickBusinessPriceInfo(biz([{ hitLine: false, price: '45.9', priceType: 'jdPrice' }], {})), { price: '45.9', label: '京东价' });
  assert.deepEqual(pickBusinessPriceInfo(biz([{ hitLine: false, price: '9.9', priceType: 'other' }], {})), { price: '9.9', label: '' });
  assert.deepEqual(pickBusinessPriceInfo({ price: { p: '60.50' } }), { price: '60.50', label: '' });
  assert.deepEqual(pickBusinessPriceInfo(null), { price: '', label: '' });
});
