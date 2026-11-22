import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeProduct } from '../src/shared/product-normalize.js';
import { withPackListParams } from '../src/shared/pack-list.js';
import { createItemRepository } from '../src/shared/store.js';
import { skuQuantityFields } from '../src/shared/sku-quantity.js';
import { vcTemplateSkuAttrs } from '../src/shared/vc-templates.js';
import { fiber, loadItemPage, plain } from './helpers/item-page.js';
import { reviewSkuAttrs } from '../src/shared/vc-review-attrs.js';

// 随尺寸和件数生成用例，验证采集只依赖页面数据。
test('不同容量、件数和容器都按当前页面的数值换算', () => {
  for (const unit of ['瓶', '袋', '桶']) {
    for (const size of [125, 375, 725]) {
      for (const count of [1, 2, 4, 12]) {
        const product = normalizeProduct({ packList: `商品 ${size}ml × ${count} 日常装`, params: [['包装形式', unit + '装']] });
        const values = Object.fromEntries(product.params.map((p) => [p.name, p.value]));
        assert.equal(values['总净含量'], size * count + 'mL');
        assert.equal(values['包装规格'], count + unit);
        assert.equal(withPackListParams(product), product);
      }
    }
  }
});

test('组合、赠品、冲突数量、毛重或相邻 SKU 规格均不用于补总量', () => {
  const base = { params: [], title: '食用油900mL', wareInfo: { weight: '0.94' } };
  for (const packList of ['', '面粉500g×2×3', '茶100g+赠品50g×1', '两瓶组合：茶100g、茶100g*2', '油400mL 900mL×1', '毛重650g×1', '空瓶900ml×0']) {
    assert.deepEqual(normalizeProduct({ ...base, packList }).params, [], packList);
  }
  const direct = [{ name: '包装规格', value: '2瓶' }];
  assert.deepEqual(withPackListParams({ packList: '油400ml*1', params: direct }).params, direct);
  const source = normalizeProduct({ packList: '面粉1斤×3袋', params: [['总净含量', '1.5kg']] });
  assert.deepEqual(source.params, [{ name: '总净含量', value: '1.5kg' }, { name: '包装规格', value: '3袋' }]);
});

test('旧任务和旧商品文件导入后都能用已有包装清单补齐，保留手动编辑', async () => {
  const old = { id: '710001', skuId: '710001', product: { params: [{ name: '包装形式', value: '瓶装' }], packList: '测试商品375ml × 1' }, edits: { attrOverrides: { 包装规格: '1罐' } } };
  const data = { items: [old] };
  const repo = createItemRepository({ get: async (k) => data[k], set: async (k, v) => { data[k] = v; } });
  for (const item of [await repo.findById(old.id), (await repo.findAll())[0]]) {
    assert.equal(item.product.params.at(-1).value, '1瓶');
    assert.deepEqual(item.edits, old.edits);
  }
  await repo.importItems([{ ...old, skuId: '710002' }]);
  assert.equal((await repo.findById('710002')).product.params.find((p) => p.name === '总净含量').value, '375mL');
});

test('SKU 数值与区间分别匹配同名控件，单位保留，缺容器时提示核对', () => {
  const template = JSON.parse(readFileSync(new URL('../templates/vc/34887.json', import.meta.url)));
  const attrs = vcTemplateSkuAttrs(template).filter((a) => ['总净含量', '包装规格'].includes(a.title));
  const values = { 总净含量: '375mL', 包装规格: '1桶' };
  const fields = skuQuantityFields(attrs, values);
  assert.deepEqual(fields, { numbers: values, select: { 总净含量: '0-1L' } });
  assert.equal(skuQuantityFields(attrs, { 总净含量: '12L' }).select['总净含量'], '>10L');
  const rows = reviewSkuAttrs(attrs, { sources: { params: { ...values, 包装规格: '1件' }, defaults: {}, overrides: {} } });
  assert.deepEqual(rows.filter((r) => r.title === '总净含量').map((r) => r.value), ['375mL', '0-1L']);
  const unknownPack = rows.find((r) => r.title === '包装规格');
  assert.equal(unknownPack.state, 'error');
  assert.equal(unknownPack.value, '1件');
});

test('所选规格、清单与参数独立出现，或者互相印证时都能取值', () => {
  const paramsOf = (raw) => Object.fromEntries(normalizeProduct(raw, { allVariants: true }).params.map((p) => [p.name, p.value]));
  const selected = (value) => ({
    skuId: 'test-selected',
    pageConfig: { colorSize: [{ skuId: 'test-other', 规格: '99kg×9袋' }, { skuId: 'test-selected', 规格: value }] },
  });
  assert.deepEqual(paramsOf({ packList: '测试商品×5袋' }), { 包装规格: '5袋' });
  assert.deepEqual(paramsOf({ packList: '测试商品×5袋', params: [['单件净含量', '150g']] }),
    { 单件净含量: '150g', 总净含量: '750g', 包装规格: '5袋' });
  assert.deepEqual(paramsOf(selected('250g/袋×4袋')), { 总净含量: '1000g', 包装规格: '4袋' });
  assert.deepEqual(paramsOf({ ...selected('0.75斤×4'), packList: '小麦粉375g×4×1', params: [['包装规格', '4袋']] }),
    { 包装规格: '4袋', 总净含量: '1500g' });
  assert.deepEqual(paramsOf({ ...selected('优+麦香 320g×4'), packList: '挂面320g×4 早餐面' }), { 总净含量: '1280g', 包装规格: '4件' });
  assert.deepEqual(paramsOf({ ...selected('2.75L'), packList: '食用油2.75升' }), { 总净含量: '2750mL' });
  assert.deepEqual(paramsOf({ ...selected('2kg×2'), packList: '面粉1kg×3' }), {});
  assert.deepEqual(paramsOf({ ...selected('2kg×2'), packList: '毛重2kg×2' }), {});
  assert.deepEqual(paramsOf({ ...selected('2kg×2'), skuId: 'test-missing' }), {});
  assert.deepEqual(paramsOf({ params: [['单瓶净含量', '125mL'], ['包装规格', '4瓶']] }),
    { 单瓶净含量: '125mL', 包装规格: '4瓶', 总净含量: '500mL' });
  assert.deepEqual(paramsOf({ params: [['总净含量', '4kg'], ['包装规格', '2袋']], ...selected('10g×8') }),
    { 总净含量: '4kg', 包装规格: '2袋' });
});

test('页面采集入口按标签读取高亮卡片和普通参数行，并保留直接标注的值', async () => {
  const row = (fields) => ({ querySelector: (sel) => {
    const key = sel.split(', ').find((s) => fields[s]);
    return key ? { textContent: fields[key] } : null;
  } });
  const card = row({ '.desc .text': '总净含量', '.title': '3.6kg' });
  const attr = row({ '.label': '包装规格', '.value': '6袋' });
  const list = row({ '.label': '包装清单', '.value': '谷物600g×6' });
  const dom = { querySelector: () => null, querySelectorAll: (sel) => {
    if (sel === '.highlight-attrs .item, .attrs .item') return [card, attr, list];
    if (sel.includes('.item.exclusive-row')) return [list];
    return [];
  } };
  const tree = fiber({ skuHeadVO: { skuTitle: '测试谷物' }, price: { p: '12.00' }, wareInfoReadMap: {} });
  const raw = plain(await loadItemPage({ tree, dom }).extractItem({ scrollDetail: false, detailWaitMs: 0 }));
  assert.equal(raw.packList, '谷物600g×6');
  assert.deepEqual(normalizeProduct(raw).params, [{ name: '总净含量', value: '3.6kg' }, { name: '包装规格', value: '6袋' }]);
});
