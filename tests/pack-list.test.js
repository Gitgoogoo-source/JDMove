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

test('磨砂膏包装清单保留各行，按单件容量和件数合计，包装单位取自所选规格', async () => {
  const packList = '磨砂膏甲 250g×2\n磨砂膏乙 250g×1';
  const row = { querySelector: (sel) => ({
    '.label': { textContent: '包装清单' },
    '.value .text[title]': { innerText: packList.replace('\n', ' '), getAttribute: () => packList },
  })[sel] };
  const dom = {
    querySelector: () => null,
    querySelectorAll: (sel) => sel.includes('.item.exclusive-row') ? [row] : [],
  };
  const tree = fiber({
    skuHeadVO: { skuTitle: '身体磨砂膏' },
    crumbInfoVO: { crumbs: [{ text: '个人护理' }, { text: '磨砂膏' }] },
    price: { p: '15.00', id: '100200187696' },
    wareInfoReadMap: { sale_attributes: '[{"saleName":"功效规格","saleValue":"【250g3罐】甲+乙"}]' },
  });
  const raw = plain(await loadItemPage({ tree, dom }).extractItem({ scrollDetail: false, detailWaitMs: 0 }));
  assert.equal(raw.packList, packList);
  const product = normalizeProduct(raw);
  const values = Object.fromEntries(product.params.map((p) => [p.name, p.value]));
  assert.deepEqual(values, { 总净含量: '750g', 单件净含量: '250g', 包装规格: '3罐' });
  const template = JSON.parse(readFileSync(new URL('../templates/vc/34485.json', import.meta.url)));
  const attrs = vcTemplateSkuAttrs(template).filter((a) => ['单件净含量', '包装规格'].includes(a.title));
  assert.deepEqual(skuQuantityFields(attrs, values).numbers, { 单件净含量: '250g', 包装规格: '3罐' });
  assert.deepEqual(normalizeProduct({ ...raw, packList: packList.replace('250g×1', '150g×1') }).params, []);
  assert.equal(normalizeProduct({ ...raw, wareInfo: null }).params.find((p) => p.name === '包装规格').value, '3件');
});

test('用同一商品另一处的明确单位补足旧记录的通用件数，保留冲突项供核对', () => {
  const product = { leafCategory: '磨砂膏', packList: '磨砂膏250g×2', params: [{ name: '包装规格', value: '2件' }] };
  assert.deepEqual(withPackListParams({ ...product, title: '磨砂膏 2支装' }).params, [
    { name: '总净含量', value: '500g' }, { name: '单件净含量', value: '250g' }, { name: '包装规格', value: '2支' },
  ]);
  assert.equal(withPackListParams({ ...product, title: '磨砂膏 2支装', packList: '磨砂膏250g×2盒' }).params[0].value, '2件');
});

test('洗洁精按清单确定单件净含量，同规格组合可以合计，容器未知时保留件数', () => {
  const values = (raw) => Object.fromEntries(normalizeProduct({ wareInfo: { category_id: '15930' }, ...raw }).params.map((p) => [p.name, p.value]));
  assert.deepEqual(values({ packList: '香橙洗洁精 500ml*1' }), { 总净含量: '500mL', 单件净含量: '500mL', 包装规格: '1件' });
  assert.deepEqual(values({ domTitle: '洗洁精500ml*2瓶 香橙+柠檬', packList: '香橙洗洁精500ml+柠檬洗洁精500ml', wareInfo: {
    category_id: '15930', sale_attributes: '[{"saleName":"香型规格","saleValue":"香橙+柠檬"}]',
  } }), { 总净含量: '1000mL', 单件净含量: '500mL', 包装规格: '2瓶' });
  assert.deepEqual(values({ packList: '洗洁精500ml+赠品洗洁精500ml' }), {});
});

test('明确瓶装且当前规格与清单容量一致时补足单瓶包装规格', () => {
  const raw = {
    skuId: '100007196929', params: [['包装形式', '瓶装']], packList: '污渍克星清洁剂 500ml 意大利进口衣领净',
    saleDims: [{ name: '规格', values: [{ text: '污渍克星500ml', selected: true }, { text: '喷雾500ml' }] }],
  };
  assert.equal(normalizeProduct(raw).params.find((p) => p.name === '包装规格')?.value, '1瓶');
  assert.equal(normalizeProduct({ ...raw, params: [] }).params.find((p) => p.name === '包装规格'), undefined);
});

test('洗衣皂的固定单位输入框填写块数和总克数，混装只计算皂块', () => {
  const template = JSON.parse(readFileSync(new URL('../templates/vc/15926.json', import.meta.url)));
  const attrs = vcTemplateSkuAttrs(template).filter((a) => ['销售规格', '总净含量'].includes(a.title));
  for (const [packList, spec, title, expected] of [
    ['植物洗衣皂 300g*1', '洗衣皂 | 植物皂300g', '植物洗衣皂300g', { 销售规格: '1块', 总净含量: '300g' }],
    ['马赛洗衣皂300g*4', '马赛皂*4', '马赛洗衣皂300g*4', { 销售规格: '4块', 总净含量: '1200g' }],
    ['', '马赛皂*6', '马赛洗衣皂300g*6', { 销售规格: '6块', 总净含量: '1800g' }],
    ['马赛洗衣皂300g*2+白苔洗衣液1.5L', '马赛皂*2+白苔洗衣液', '', { 销售规格: '2块', 总净含量: '600g' }],
    ['马赛洗衣皂300g*2+白苔洗衣液1.5L', '马赛皂*3+白苔洗衣液', '', { 销售规格: '', 总净含量: '' }],
  ]) {
    const product = withPackListParams({ packList, title, leafCategory: '普通洗衣皂', vc: { saleAttrs: [{ name: '规格', value: spec }] } });
    const params = Object.fromEntries((product.params ?? []).map((p) => [p.name, p.value]));
    assert.deepEqual(skuQuantityFields(attrs, params).numbers, expected);
    const rows = reviewSkuAttrs(attrs, { sources: { params, defaults: {}, overrides: {} }, units: { g: '300' } });
    assert.deepEqual(rows.map(({ title, value }) => [title, value]), Object.entries(expected));
    assert.equal(rows[1].state, expected.总净含量 ? 'ok' : 'missing');
  }
  assert.deepEqual(skuQuantityFields(attrs, { 规格: '300g', 总净含量: '1.2kg' }).numbers, { 销售规格: '', 总净含量: '1200g' });
  assert.deepEqual(skuQuantityFields(attrs, { 销售规格: '300g', 总净含量: '600g+1500mL' }).numbers, { 销售规格: '', 总净含量: '' });
});

test('普通洗衣液的不同容量组合按清单合计，不合计赠品或缺少净含量的组件', () => {
  const net = (packList) => normalizeProduct({ packList, wareInfo: { category_id: '15924' } })
    .params.find((p) => p.name === '总净含量')?.value;
  assert.equal(net('洗衣液1500ml+柔顺剂1.14L'), '2640mL');
  assert.equal(net('洗衣液1500ml×2+柔顺剂600ml'), '3600mL');
  assert.equal(net('洗衣液1500ml+赠品柔顺剂1.14L'), undefined);
  assert.equal(net('洗衣液1500ml+柔顺剂'), undefined);
});

test('调味油模板按 SKU 保质期的原单位填入抽屉和检查表', () => {
  const template = JSON.parse(readFileSync(new URL('../templates/vc/34945.json', import.meta.url)));
  const attrs = vcTemplateSkuAttrs(template).filter((a) => a.title === '保质期');
  const values = { 保质期: '18个月' };
  assert.equal(skuQuantityFields(attrs, values).numbers['保质期'], '18个月');
  const [review] = reviewSkuAttrs(attrs, { sources: { params: values, defaults: {}, overrides: {} } });
  assert.equal(review.value, '18个月');
  assert.equal(skuQuantityFields(attrs, { 保质期: '2周' }).numbers['保质期'], '');
});

test('沐浴露模板的 mL(g) 区间同时接受容量和重量', () => {
  const template = JSON.parse(readFileSync(new URL('../templates/vc/16779.json', import.meta.url)));
  const attrs = vcTemplateSkuAttrs(template).filter((a) => a.title === '总净含量');
  for (const value of ['1460g', '1460mL']) {
    assert.equal(skuQuantityFields(attrs, { 总净含量: value }).select['总净含量'], '1000mL(g）以上');
  }
});
