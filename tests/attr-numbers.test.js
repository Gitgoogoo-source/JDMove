import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseNumberParts, numberSegments, formatNumberParts } from '../src/shared/attr-numbers.js';
import { buildPropPlan } from '../src/shared/attr-mapping.js';

// 湿厕纸 15913 纸张尺寸：发布页存 [{name:'长',unit:'mm',value:'200'},{name:'宽',unit:'mm',value:'140'}]
const SIZE = [
  { name: '长', units: ['mm'] },
  { name: '宽', units: ['mm'] },
];

const parts = (l, w) => [
  { name: '长', unit: 'mm', value: l },
  { name: '宽', unit: 'mm', value: w },
];

test('parseNumberParts: 源商品页“长195mm 宽133mm”', () => {
  assert.deepEqual(parseNumberParts('长195mm 宽133mm', SIZE), parts('195', '133'));
});

test('parseNumberParts: 带标签时按标签取，不按出现顺序', () => {
  assert.deepEqual(parseNumberParts('宽133mm 长195mm', SIZE), parts('195', '133'));
});

test('parseNumberParts: 末尾单位适用于前面没写单位的数字', () => {
  assert.deepEqual(parseNumberParts('195*133mm', SIZE), parts('195', '133'));
  assert.deepEqual(parseNumberParts('20×14cm', SIZE), parts('200', '140'));
  assert.deepEqual(parseNumberParts('195 × 133', SIZE), parts('195', '133'));
});

test('parseNumberParts: 各自单位分别换算，最多 3 位小数', () => {
  assert.deepEqual(parseNumberParts('19.5cm×133mm', SIZE), parts('195', '133'));
  assert.deepEqual(parseNumberParts('12.3456×1', SIZE), parts('12.346', '1'));
});

test('parseNumberParts: 数字不够、超出页面范围时返回 null', () => {
  assert.equal(parseNumberParts('195mm', SIZE), null);
  assert.equal(parseNumberParts('', SIZE), null);
  assert.equal(parseNumberParts(null, SIZE), null);
  assert.equal(parseNumberParts('1000000000×1', SIZE), null);
});

test('numberSegments: 模板里的 segments 优先，旧模板按选项文字 + 后缀', () => {
  assert.deepEqual(numberSegments({ segments: SIZE, options: [] }), SIZE);
  assert.deepEqual(numberSegments({ suffix: 'mm', options: [{ label: '长', value: '长' }, { label: '宽', value: '宽' }] }), SIZE);
  assert.deepEqual(numberSegments({ options: [] }), [{ name: '', units: [] }]);
});

test('formatNumberParts: 弹窗里显示成“195mm × 133mm”', () => {
  assert.equal(formatNumberParts(parts('195', '133')), '195mm × 133mm');
  assert.equal(formatNumberParts('x'), '');
});

test('buildPropPlan: numbers 类属性从采集参数“纸张尺寸”取到长×宽', () => {
  const attrs = [{ field: '322216', title: '纸张尺寸', type: 'ShopAttrMultiInputUnit', kind: 'numbers', required: true, segments: SIZE, options: [] }];
  const plan = buildPropPlan(attrs, { params: [{ name: '纸张尺寸', value: '长195mm 宽133mm' }] });
  assert.deepEqual(plan.values, { 322216: parts('195', '133') });
  assert.deepEqual(plan.missingRequired, []);
});

test('buildPropPlan: numbers 类属性用属性默认值；数字不够时算未匹配', () => {
  const attrs = [{ field: '322216', title: '纸张尺寸', kind: 'numbers', required: true, segments: SIZE, options: [] }];
  assert.deepEqual(buildPropPlan(attrs, { params: [] }, { defaults: { 纸张尺寸: '200*140' } }).values, { 322216: parts('200', '140') });
  const bad = buildPropPlan(attrs, { params: [{ name: '纸张尺寸', value: '大号' }] });
  assert.equal(bad.report[0].status, 'unmatched');
  assert.deepEqual(bad.missingRequired, ['纸张尺寸']);
});
