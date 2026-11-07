// 规格文本拆分：给 VC 结构化规格、SKU属性里的“包数/层数/单包抽数”这类字段取数
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSpecText, quantitiesByUnit, numbersIn } from '../src/shared/vc-spec.js';

test('parseSpecText: 拆出括号里的描述和每个“数字+单位”', () => {
  assert.deepEqual(parseSpecText('【王牌囤货装】 3层 100抽*36包'), {
    text: '【王牌囤货装】 3层 100抽*36包',
    desc: '王牌囤货装',
    quantities: [
      { value: 3, unit: '层' },
      { value: 100, unit: '抽' },
      { value: 36, unit: '包' },
    ],
  });
});

test('parseSpecText: 小数、英文单位、没有描述', () => {
  const r = parseSpecText('黑巧 1.5L*2瓶 480g');
  assert.equal(r.desc, '');
  assert.deepEqual(r.quantities, [
    { value: 1.5, unit: 'L' },
    { value: 2, unit: '瓶' },
    { value: 480, unit: 'g' },
  ]);
});

test('parseSpecText: 空值和没有数字的规格', () => {
  assert.deepEqual(parseSpecText(undefined), { text: '', desc: '', quantities: [] });
  assert.deepEqual(parseSpecText('原味').quantities, []);
  assert.equal(parseSpecText('[家庭装] 6袋').desc, '家庭装');
});

test('quantitiesByUnit: 同一单位只取第一个，数字转成字符串', () => {
  const { quantities } = parseSpecText('3层 100抽*36包 另赠2包');
  assert.deepEqual(quantitiesByUnit(quantities), { 层: '3', 抽: '100', 包: '36' });
  assert.deepEqual(quantitiesByUnit([]), {});
});

test('numbersIn: 纸张尺寸这类“长×宽”写法按顺序取数字', () => {
  assert.deepEqual(numbersIn('长195mm 宽133mm'), [195, 133]);
  assert.deepEqual(numbersIn('195*133mm'), [195, 133]);
  assert.deepEqual(numbersIn('19.5cm×13.3cm'), [19.5, 13.3]);
  assert.deepEqual(numbersIn(''), []);
});
