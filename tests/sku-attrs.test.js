import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUpc, productUpc, resolveUpc, skuAttrValueMap } from '../src/shared/sku-attrs.js';

test('normalizeUpc keeps 8-14 digit barcodes, accepts full-width digits and spaces', () => {
  assert.equal(normalizeUpc('6901234567892'), '6901234567892');
  assert.equal(normalizeUpc(' 6901 2345 67892 '), '6901234567892');
  assert.equal(normalizeUpc('６９０１２３４１'), '69012341');
  assert.equal(normalizeUpc('12345678901231'), '12345678901231');
});

test('normalizeUpc rejects empty, too short/long and non-digit values', () => {
  for (const bad of [undefined, null, '', '1234567', '123456789012345', '69012345678AB', '无']) {
    assert.equal(normalizeUpc(bad), '', String(bad));
  }
});

test('normalizeUpc rejects placeholder barcodes made of one repeated digit (e.g. 0000000000000)', () => {
  // 实例：item.jd.com/100027810038 没有登记条形码，upc_code 是 '0000000000000;100027810038'
  for (const bad of ['0000000000000', '00000000', '11111111111111', '８８８８８８８８']) {
    assert.equal(normalizeUpc(bad), '', bad);
  }
});

test('normalizeUpc rejects codes whose GTIN check digit is wrong', () => {
  // 源商品页上的真实条形码（格力高百奇）校验位都正确
  for (const good of ['6901845046120', '6901845045529', '6901845010206', '6914973039001']) {
    assert.equal(normalizeUpc(good), good);
  }
  for (const bad of ['6901845046121', '6901234567890', '69012345', '12345678901234']) {
    assert.equal(normalizeUpc(bad), '', bad);
  }
});

test('resolveUpc: own UPC > override UPC, invalid values skipped', () => {
  assert.equal(resolveUpc({ upc: '6901845046120', overrides: { UPC: '6914973611436' } }), '6901845046120');
  assert.equal(resolveUpc({ upc: '0000000000000', overrides: { 商品条形码: '6914973611436' } }), '6914973611436');
  assert.equal(resolveUpc({ upc: '0000000000000' }), '');
  assert.equal(resolveUpc(), '');
});

test('skuAttrValueMap: params and UPC by label', () => {
  const map = skuAttrValueMap({ params: [{ name: '原产地', value: '中国大陆' }], upc: '6901234567892' });
  assert.equal(map['原产地'], '中国大陆');
  assert.equal(map['最小可售单位UPC'], '6901234567892');
  assert.equal(map['商品条形码'], '6901234567892');
});

test('skuAttrValueMap: precedence is defaults < params < overrides < upc field', () => {
  const map = skuAttrValueMap({
    defaults: { 生产日期: '2026-01-01', 原产地: '默认产地', 层数: '2层' },
    params: [{ name: '原产地', value: '中国大陆' }, { name: '层数', value: '3层' }],
    overrides: { 层数: '4层', 最小可售单位UPC: '11111111' },
    upc: '6901234567892',
  });
  assert.equal(map['生产日期'], '2026-01-01');
  assert.equal(map['原产地'], '中国大陆');
  assert.equal(map['层数'], '4层');
  assert.equal(map['最小可售单位UPC'], '6901234567892');
});

test('skuAttrValueMap: UPC from overrides is used when the UPC field is empty', () => {
  const map = skuAttrValueMap({ overrides: { 最小可售单位UPC: '6901234567892' } });
  assert.equal(map['最小可售单位UPC'], '6901234567892');
});

test('skuAttrValueMap: no UPC keys when unknown', () => {
  assert.equal(skuAttrValueMap({ params: [] })['最小可售单位UPC'], undefined);
});

test('productUpc drops a barcode that equals the SKU id or a variant SKU id', () => {
  assert.equal(productUpc({ skuId: '100229520979', upc: '100229520979' }), '');
  assert.equal(productUpc({ skuId: '1', upc: '100002', variants: [{ skuId: 100002 }] }), '');
  assert.equal(productUpc({ skuId: '100229520979', upc: '6914973609563' }), '6914973609563');
  assert.equal(productUpc({ skuId: '1', upc: 'abc' }), '');
  assert.equal(productUpc(undefined), '');
});

test('productUpc reads multi-value upc_code "SKU编号;条形码" and skips the SKU id', () => {
  // 实例：item.jd.com/100050587042 的 upc_code === '100050587042;6914973600058'
  assert.equal(productUpc({ skuId: '100050587042', upc: '100050587042;6914973600058' }), '6914973600058');
  assert.equal(productUpc({ skuId: '100039440604', upc: ' 100039440604 ； 6914973611436 ' }), '6914973611436');
  assert.equal(productUpc({ skuId: '1', upc: '6914973600058,6914973611436' }), '6914973600058');
  assert.equal(productUpc({ skuId: '100357660574', upc: '100357660574;' }), '');
  assert.equal(productUpc({ skuId: '1', upc: '无;abc' }), '');
});

test('productUpc treats "0000000000000;SKU编号" as no barcode', () => {
  assert.equal(productUpc({ skuId: '100027810038', upc: '0000000000000;100027810038' }), '');
  assert.equal(productUpc({ skuId: '1', upc: '0000000000000;6901845046120' }), '6901845046120');
});
