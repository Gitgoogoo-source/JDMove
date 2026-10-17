import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSalePlan, assignDims } from '../src/shared/sale-plan.js';

const product = {
  params: [{ name: '净含量', value: '252g' }],
  saleDims: [
    { name: '口味', values: ['牛奶', '黑巧'] },
    { name: '规格', values: ['252g', '504g'] },
  ],
  variants: [
    { skuId: '1', values: { 口味: '牛奶', 规格: '252g' } },
    { skuId: '2', values: { 口味: '黑巧', 规格: '252g' } },
    { skuId: '3', values: { 口味: '牛奶', 规格: '504g' } },
  ],
};

test('assignDims matches by name and falls back to free dims', () => {
  assert.deepEqual(assignDims(['规格', '口味'], ['口味', '规格']), [['规格'], ['口味']]);
  assert.deepEqual(assignDims(['颜色', '尺码'], ['颜色分类', '尺寸']), [['颜色分类'], ['尺寸']]);
  assert.deepEqual(assignDims(['规格'], ['口味', '规格']), [['口味', '规格']]);
  assert.deepEqual(assignDims(['规格', '口味'], []), [[], []]);
  assert.deepEqual(assignDims(['颜色', '版本'], ['套餐']), [[], ['套餐']]);
});

test('buildSalePlan builds dims in target order and cartesian rows', () => {
  const plan = buildSalePlan(['规格', '口味'], product, {
    defaultPrice: 59.9,
    prices: { 2: 61 },
    stock: 50,
  });
  assert.deepEqual(plan.dims, [
    { name: '规格', values: ['252g', '504g'] },
    { name: '口味', values: ['牛奶', '黑巧'] },
  ]);
  assert.deepEqual(plan.rows, [
    { values: ['252g', '牛奶'], price: 59.9, stock: 50, enabled: true, sourceSkuId: '1' },
    { values: ['252g', '黑巧'], price: 61, stock: 50, enabled: true, sourceSkuId: '2' },
    { values: ['504g', '牛奶'], price: 59.9, stock: 50, enabled: true, sourceSkuId: '3' },
    { values: ['504g', '黑巧'], price: 59.9, stock: 0, enabled: false, sourceSkuId: null },
  ]);
});

test('buildSalePlan merges dims when target has fewer', () => {
  const plan = buildSalePlan(['规格'], product, { defaultPrice: 10, stock: 5 });
  assert.deepEqual(plan.dims, [{ name: '规格', values: ['牛奶 252g', '黑巧 252g', '牛奶 504g'] }]);
  assert.equal(plan.rows.length, 3);
  assert.ok(plan.rows.every((r) => r.enabled));
});

test('buildSalePlan uses spec param when product has no sale dims', () => {
  const plan = buildSalePlan(['规格', '口味'], { params: [{ name: '净含量', value: '252g' }], saleDims: [], variants: [] }, {
    defaultPrice: 9.9,
    stock: 100,
  });
  assert.deepEqual(plan.dims, [{ name: '规格', values: ['252g'] }]);
  assert.deepEqual(plan.rows, [{ values: ['252g'], price: 9.9, stock: 100, enabled: true, sourceSkuId: null }]);
});

test('buildSalePlan falls back to 标准装 when nothing known', () => {
  const plan = buildSalePlan(['颜色'], {}, { defaultPrice: 1, stock: 1 });
  assert.deepEqual(plan.dims, [{ name: '颜色', values: ['标准装'] }]);
});

test('buildSalePlan enables all rows when variants are unknown', () => {
  const plan = buildSalePlan(['颜色', '尺码'], {
    saleDims: [
      { name: '颜色', values: ['红', '蓝'] },
      { name: '尺码', values: ['S', 'M'] },
    ],
    variants: [],
  }, { defaultPrice: 99, stock: 10 });
  assert.equal(plan.rows.length, 4);
  assert.ok(plan.rows.every((r) => r.enabled && r.price === 99));
});

test('buildSalePlan caps the number of rows', () => {
  const plan = buildSalePlan(['颜色', '尺码'], {
    saleDims: [
      { name: '颜色', values: ['a', 'b', 'c', 'd', 'e'] },
      { name: '尺码', values: ['1', '2', '3', '4', '5'] },
    ],
    variants: [],
  }, { defaultPrice: 1, stock: 1, maxRows: 12 });
  assert.ok(plan.rows.length <= 12);
  assert.ok(plan.warnings.length > 0);
});

test('buildSalePlan truncates long values and returns empty plan without target dims', () => {
  const long = '超级无敌长的规格名称一二三四五六七八九十';
  const plan = buildSalePlan(['规格'], { saleDims: [{ name: '规格', values: [long] }], variants: [] }, { defaultPrice: 1, stock: 1 });
  assert.equal(plan.dims[0].values[0], '超级无敌长的规格名称一二三四五');
  assert.deepEqual(buildSalePlan([], product, {}).rows, []);
});
