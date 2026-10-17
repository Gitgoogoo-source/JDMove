import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPropPlan, matchOption, convertInputValue, findSourceValue } from '../src/shared/attr-mapping.js';

const opt = (label, value) => ({ label, value });

const attrs = [
  { field: '256104', title: '本品与最小可售单位数量关系', kind: 'input', required: true, suffix: '', options: [] },
  { field: '156403', title: '规格', kind: 'input', required: true, suffix: '', options: [] },
  { field: '156406', title: '销售单位', kind: 'select', required: true, options: [opt('块', '1'), opt('盒', '2'), opt('袋', '3')] },
  { field: '149367', title: '产地', kind: 'select', required: true, options: [opt('比利时', '11'), opt('中国大陆', '12'), opt('德国', '13')] },
  { field: '156404', title: '净含量', kind: 'input', required: true, suffix: 'g', options: [] },
  { field: '149365', title: '包装', kind: 'select', required: true, options: [opt('罐装', '21'), opt('盒装', '22'), opt('袋装', '23')] },
  { field: '156405', title: '保质期', kind: 'input', required: true, suffix: '天', options: [] },
  { field: '149369', title: '国产/进口', kind: 'select', required: false, options: [opt('国产', '31'), opt('进口', '32')] },
  { field: '153539', title: '口味', kind: 'multi', required: false, options: [opt('牛奶', '41'), opt('黑巧', '42'), opt('抹茶', '43')] },
  { field: '149376', title: '形状', kind: 'select', required: false, options: [opt('粒状', '51')] },
];

const product = {
  brand: { id: 5962, name: '德芙（Dove）' },
  params: [
    { name: '原产地', value: '中国大陆' },
    { name: '净含量', value: '0.252kg' },
    { name: '包装形式', value: '盒装' },
    { name: '保质期', value: '12个月' },
    { name: '口味', value: '牛奶，黑巧/草莓' },
    { name: '规格', value: '252g*1盒' },
    { name: '形状', value: '心形' },
  ],
};

test('matchOption finds exact, contained and split matches', () => {
  const options = [opt('中国大陆', '1'), opt('比利时', '2')];
  assert.equal(matchOption(options, '中国大陆')?.value, '1');
  assert.equal(matchOption(options, '产地：比利时')?.value, '2');
  assert.equal(matchOption(options, '日本,比利时')?.value, '2');
  assert.equal(matchOption(options, '火星'), null);
  assert.equal(matchOption([], '任何'), null);
});

test('matchOption prefers the longest contained label', () => {
  const options = [opt('中国', '1'), opt('中国大陆', '2')];
  assert.equal(matchOption(options, '中国大陆')?.value, '2');
  assert.equal(matchOption(options, '产自中国大陆广东')?.value, '2');
});

test('convertInputValue converts units into attribute suffix', () => {
  assert.equal(convertInputValue('12个月', '天'), '360');
  assert.equal(convertInputValue('2年', '天'), '730');
  assert.equal(convertInputValue('180天', '天'), '180');
  assert.equal(convertInputValue('0.252kg', 'g'), '252');
  assert.equal(convertInputValue('1.5L', 'ml'), '1500');
  assert.equal(convertInputValue('252g', 'g'), '252');
  assert.equal(convertInputValue('约252', 'g'), '252');
  assert.equal(convertInputValue('见包装', '天'), '');
  assert.equal(convertInputValue('252g*1盒', ''), '252g*1盒');
});

test('findSourceValue uses synonyms and containment', () => {
  assert.deepEqual(findSourceValue('产地', product), { value: '中国大陆', from: '原产地' });
  assert.deepEqual(findSourceValue('包装', product), { value: '盒装', from: '包装形式' });
  assert.deepEqual(findSourceValue('品牌', product), { value: '德芙（Dove）', from: '品牌' });
  assert.equal(findSourceValue('颜色', product), null);
});

test('buildPropPlan maps params, derives and applies defaults', () => {
  const plan = buildPropPlan(attrs, product, { defaults: { 本品与最小可售单位数量关系: '1', 销售单位: '盒' } });
  assert.deepEqual(plan.values, {
    256104: '1',
    156403: '252g*1盒',
    156406: '2',
    149367: '12',
    156404: '252',
    149365: '22',
    156405: '360',
    149369: '31',
    153539: ['41', '42'],
  });
  const byField = Object.fromEntries(plan.report.map((r) => [r.field, r.status]));
  assert.equal(byField['256104'], 'default');
  assert.equal(byField['149367'], 'matched');
  assert.equal(byField['149369'], 'derived');
  assert.equal(byField['149376'], 'unmatched');
  assert.deepEqual(plan.missingRequired, []);
});

test('buildPropPlan reports missing required attributes', () => {
  const plan = buildPropPlan(attrs, { params: [] }, {});
  assert.ok(plan.missingRequired.includes('产地'));
  assert.ok(plan.missingRequired.includes('保质期'));
  assert.ok(!plan.missingRequired.includes('形状'));
  assert.deepEqual(plan.values, {});
});

test('buildPropPlan derives 进口 for foreign origin', () => {
  const plan = buildPropPlan(
    [attrs[7]],
    { params: [{ name: '产地', value: '比利时' }] },
    {},
  );
  assert.equal(plan.values['149369'], '32');
});

test('buildPropPlan truncates input to maxLength', () => {
  const plan = buildPropPlan(
    [{ field: 'x', title: '成份', kind: 'input', maxLength: 4, options: [] }],
    { params: [{ name: '配料表', value: '白砂糖可可脂全脂乳粉' }] },
    {},
  );
  assert.equal(plan.values.x, '白砂糖可');
});

test('buildPropPlan derives net content and spec from sale value or title', () => {
  const plan = buildPropPlan(
    [
      { field: 'n', title: '净含量', kind: 'input', suffix: '', options: [] },
      { field: 's', title: '规格', kind: 'input', suffix: '', options: [] },
      { field: 'g', title: '重量', kind: 'input', suffix: 'kg', options: [] },
    ],
    { title: '德芙香浓黑巧克力 桶装480g 休闲零食', saleDims: [{ name: '规格', values: ['黑巧480g'] }], params: [] },
    {},
  );
  assert.deepEqual(plan.values, { n: '480g', s: '480g', g: '0.48' });
  assert.equal(plan.report[0].status, 'derived');
});

test('buildPropPlan does not derive net content without a unit', () => {
  const plan = buildPropPlan([{ field: 'n', title: '净含量', kind: 'input', options: [] }], { title: '德芙 礼盒 6 块', params: [] }, {});
  assert.deepEqual(plan.values, {});
});
