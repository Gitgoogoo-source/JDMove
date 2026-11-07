// VC 发布页字段写入值（shared/vc-form-values.js）：全部转字符串、按页面规则控制小数位和范围
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decimalText, vcFormEntries } from '../src/shared/vc-form-values.js';

const PLAN = {
  model: ' V2833-D ',
  prices: { marketPrice: 89.9, jdPrice: 69.9, costPrice: 50.12345 },
  logistics: {
    length: 408,
    wide: 310.4,
    height: 280,
    weight: 4.33,
    sldays: 1095,
    packSpecification: 1,
    unit: '箱',
    packType: '普通商品',
    warranty: '无质保',
    packListing: '抽纸*36',
  },
};

const byField = (entries) => Object.fromEntries(entries.map((e) => [e.field, e.value]));

test('decimalText: 四舍五入到指定小数位，不补零、不出科学计数法', () => {
  assert.equal(decimalText(4.33, 3), '4.33');
  assert.equal(decimalText(4.3336, 3), '4.334');
  assert.equal(decimalText(89.9, 2), '89.9');
  assert.equal(decimalText(5, 2), '5');
  assert.equal(decimalText(310.6, 0), '311');
  assert.equal(decimalText(0.0000001, 2), '0');
  assert.equal(decimalText('12.50', 2), '12.5');
  assert.equal(decimalText('abc', 2), '');
  assert.equal(decimalText(null, 2), '');
});

test('vcFormEntries: 每个字段都是字符串，字段名是 fApi 的字段', () => {
  const { entries, errors, warnings } = vcFormEntries(PLAN);
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
  assert.ok(entries.every((e) => typeof e.value === 'string'));
  assert.deepEqual(byField(entries), {
    'features.model': 'V2833-D',
    marketPrice: '89.9',
    jdPrice: '69.9',
    costPrice: '50.1235',
    length: '408',
    wide: '310',
    height: '280',
    weight: '4.33',
    'features.sldays': '1095',
    packSpecification: '1',
    'features.unit': '箱',
    'features.packType': '普通商品',
    warranty: '无质保',
    packListing: '抽纸*36',
  });
});

test('vcFormEntries: 型号、价格、长宽高、毛重是必须写进去的字段', () => {
  const critical = vcFormEntries(PLAN).entries.filter((e) => e.critical).map((e) => e.label);
  assert.deepEqual(critical, ['型号', '市场价', '京东价', '采购价', '长', '宽', '高', '毛重']);
});

test('vcFormEntries: 必填数字缺失或超出范围报错，选填的只提醒并跳过', () => {
  const plan = {
    ...PLAN,
    prices: { ...PLAN.prices, jdPrice: null },
    logistics: { ...PLAN.logistics, height: 3001, weight: 0.001, sldays: 0.2, packSpecification: null },
  };
  const { entries, errors, warnings } = vcFormEntries(plan);
  assert.deepEqual(errors, [
    '缺少京东价',
    '高“3001”超出页面允许的范围（1~3000mm，整数）',
    '毛重“0.001”超出页面允许的范围（0.01~60000kg，最多 3 位小数）',
  ]);
  assert.deepEqual(warnings, ['保质期“0.2”超出页面允许的范围（1~99999天，整数），已跳过']);
  const fields = entries.map((e) => e.field);
  assert.ok(!fields.includes('jdPrice') && !fields.includes('height') && !fields.includes('features.sldays'));
  assert.ok(!fields.includes('packSpecification'), '选填字段没有值时不写');
});

test('vcFormEntries: 空文本字段不写', () => {
  const { entries } = vcFormEntries({ ...PLAN, model: '  ', logistics: { ...PLAN.logistics, packListing: '' } });
  const fields = entries.map((e) => e.field);
  assert.ok(!fields.includes('features.model'));
  assert.ok(!fields.includes('packListing'));
});
