import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUpc, productUpc, resolveUpc, skuAttrValueMap, describeSkuAttrResults, missingSkuAttrs, skuAttrStop } from '../src/shared/sku-attrs.js';

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

test('resolveUpc: own UPC > override UPC > fallback UPC, invalid values skipped', () => {
  assert.equal(resolveUpc({ upc: '6901845046120', overrides: { UPC: '6914973611436' }, fallbackUpc: '6914973039001' }), '6901845046120');
  assert.equal(resolveUpc({ upc: '0000000000000', overrides: { 商品条形码: '6914973611436' }, fallbackUpc: '6914973039001' }), '6914973611436');
  assert.equal(resolveUpc({ upc: '0000000000000', fallbackUpc: '6914973039001' }), '6914973039001');
  assert.equal(resolveUpc({ upc: '0000000000000', fallbackUpc: '' }), '');
  assert.equal(resolveUpc(), '');
});

test('skuAttrValueMap: params, price and UPC by label', () => {
  const map = skuAttrValueMap({
    params: [{ name: '原产地', value: '中国大陆' }],
    retailPrice: 59.9,
    upc: '6901234567892',
  });
  assert.equal(map['建议零售价'], '59.9');
  assert.equal(map['市场价'], '59.9');
  assert.equal(map['原产地'], '中国大陆');
  assert.equal(map['最小可售单位UPC'], '6901234567892');
  assert.equal(map['商品条形码'], '6901234567892');
});

test('skuAttrValueMap: precedence is defaults < params < price < overrides < upc field', () => {
  const map = skuAttrValueMap({
    defaults: { 生产日期: '2026-01-01', 原产地: '默认产地', 建议零售价: '1' },
    params: [{ name: '原产地', value: '中国大陆' }],
    retailPrice: 50,
    overrides: { 建议零售价: '66', 最小可售单位UPC: '11111111' },
    upc: '6901234567892',
  });
  assert.equal(map['生产日期'], '2026-01-01');
  assert.equal(map['原产地'], '中国大陆');
  assert.equal(map['建议零售价'], '66');
  assert.equal(map['市场价'], '50');
  assert.equal(map['最小可售单位UPC'], '6901234567892');
});

test('skuAttrValueMap: UPC from overrides is used when the UPC field is empty', () => {
  const map = skuAttrValueMap({ overrides: { 最小可售单位UPC: '6901234567892' } });
  assert.equal(map['最小可售单位UPC'], '6901234567892');
});

test('skuAttrValueMap: no price or UPC keys when unknown', () => {
  const map = skuAttrValueMap({ params: [], retailPrice: 0 });
  assert.equal(map['建议零售价'], undefined);
  assert.equal(map['最小可售单位UPC'], undefined);
});

test('describeSkuAttrResults: empty for confirmed rows with nothing missing', () => {
  assert.deepEqual(describeSkuAttrResults([{ row: 0, confirmed: true, filled: ['建议零售价'], missing: [] }]), []);
  assert.deepEqual(describeSkuAttrResults(undefined), []);
});

test('describeSkuAttrResults: unconfirmed panel says what was discarded, rows grouped', () => {
  const lines = describeSkuAttrResults([
    { row: 0, confirmed: false, filled: ['建议零售价'], missing: ['最小可售单位UPC'] },
    { row: 1, confirmed: false, filled: ['建议零售价'], missing: ['最小可售单位UPC'] },
  ]);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /第 1、2 行/);
  assert.match(lines[0], /未能保存/);
  assert.match(lines[0], /最小可售单位UPC/);
  assert.match(lines[0], /建议零售价.*丢弃/);
});

test('describeSkuAttrResults: unconfirmed without filled values or missing list', () => {
  const [line] = describeSkuAttrResults([{ row: 2, confirmed: false, filled: [], missing: [] }]);
  assert.match(line, /第 3 行/);
  assert.match(line, /未能保存/);
  assert.doesNotMatch(line, /丢弃/);
});

test('describeSkuAttrResults: panel not opened and confirmed-but-missing are reported', () => {
  const lines = describeSkuAttrResults([
    { row: 0, confirmed: false, error: '未打开SKU属性面板', filled: [], missing: [] },
    { row: 1, confirmed: true, filled: [], missing: ['生产日期'] },
  ]);
  assert.equal(lines.length, 2);
  assert.match(lines[0], /第 1 行.*未打开SKU属性面板/);
  assert.match(lines[1], /第 2 行.*生产日期/);
});

const REQUIRED = [
  { field: '256076', label: '最小可售单位UPC' },
  { field: '393788', label: '建议零售价' },
];

test('missingSkuAttrs: lists empty required fields per enabled row', () => {
  const state = {
    required: REQUIRED,
    skuProps: [{ 256076: '6914973609563', 393788: '25.9' }, null, { 256076: ' ', 393788: '25.9' }],
  };
  assert.deepEqual(missingSkuAttrs(state, [true, true, true]), [
    { row: 1, missing: ['最小可售单位UPC', '建议零售价'] },
    { row: 2, missing: ['最小可售单位UPC'] },
  ]);
});

test('missingSkuAttrs: disabled rows and categories without required fields are skipped', () => {
  assert.deepEqual(missingSkuAttrs({ required: REQUIRED, skuProps: [null, null] }, [false, true]), [
    { row: 1, missing: ['最小可售单位UPC', '建议零售价'] },
  ]);
  assert.deepEqual(missingSkuAttrs({ required: [], skuProps: [null] }, [true]), []);
});

test('missingSkuAttrs: numeric values count as filled', () => {
  assert.deepEqual(missingSkuAttrs({ required: REQUIRED, skuProps: [{ 256076: 6914973609563, 393788: 0 }] }, [true]), []);
});

test('skuAttrStop: need_action when the plan has no value for a missing field', () => {
  const stop = skuAttrStop([{ row: 0, missing: ['最小可售单位UPC', '建议零售价'] }], { 建议零售价: '25.9' });
  assert.equal(stop.status, 'need_action');
  assert.match(stop.message, /最小可售单位UPC/);
  assert.match(stop.message, /编辑/);
  assert.match(stop.message, /已停止保存/);
});

test('skuAttrStop: failed when values were planned but did not stick', () => {
  const stop = skuAttrStop(
    [{ row: 0, missing: ['最小可售单位UPC'] }, { row: 1, missing: ['最小可售单位UPC'] }],
    { 最小可售单位UPC: '6914973609563' },
  );
  assert.equal(stop.status, 'failed');
  assert.match(stop.message, /第 1、2 行/);
  assert.match(stop.message, /没有生效/);
  assert.match(stop.message, /已停止保存/);
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

test('skuAttrValueMap: fallbackUpc is used only when neither upc nor overrides give one', () => {
  assert.equal(skuAttrValueMap({ fallbackUpc: '6914973039001' })['最小可售单位UPC'], '6914973039001');
  assert.equal(skuAttrValueMap({ upc: '6914973600058', fallbackUpc: '6914973039001' })['最小可售单位UPC'], '6914973600058');
  assert.equal(skuAttrValueMap({ overrides: { UPC: '6914973611436' }, fallbackUpc: '6914973039001' })['最小可售单位UPC'], '6914973611436');
  assert.equal(skuAttrValueMap({ fallbackUpc: 'abc' })['最小可售单位UPC'], undefined);
});
