// 发布前检查：模板匹配、选模板、字段/属性/图片的检查结果，以及和打开发布页前的检查（vcPreflight）一致
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildPropPlan } from '../src/shared/attr-mapping.js';
import {
  applyReviewValue,
  applyTemplateChoice,
  autoTemplate,
  buildReview,
  currentChoice,
  NO_CATEGORY,
  rebaseEdits,
  reviewOwnValue,
  reviewTemplate,
  reviewValueError,
  templateChoices,
} from '../src/shared/vc-review.js';
import { pickOption, plannedKey, reviewPropAttrs, reviewSkuAttrs } from '../src/shared/vc-review-attrs.js';
import { findCatalogTemplate, vcTemplateCategory, vcTemplateAttrs, vcTemplateLeaves, vcTemplateSkuAttrs } from '../src/shared/vc-templates.js';
import { vcPreflight } from '../src/shared/vc-plan.js';
import { mergeSettings } from '../src/shared/settings.js';

const read = (f) => JSON.parse(fs.readFileSync(new URL(`../templates/vc/${f}`, import.meta.url), 'utf8'));
const index = read('index.json');
const catalog = { entries: index.templates, byId: new Map(index.templates.map((e) => [e.categoryId, read(e.file)])) };
const settings = mergeSettings({});
const IMG = 'https://img14.360buyimg.com/a.jpg';

/** 维达常规抽纸：源商品类目是四级类目 31403，参数里有层数、印花、包装形式，规格里有抽数和包数 */
const tissue = (vc = {}, params = []) => ({
  skuId: '100012345678',
  title: '维达 抽纸 3层100抽*36包',
  brand: { id: 17519, name: '维达（Vinda）' },
  params: [{ name: '层数', value: '3层' }, { name: '是否印花', value: '无印花' }, { name: '包装形式', value: '箱装' }, ...params],
  mainImages: [IMG],
  detailImages: [IMG],
  variants: [{ skuId: '100012345678', values: { 规格: '3层100抽*36包' } }],
  vc: { cateIds: ['15901', '15902', '15908', '31403'], brandId: 17519, model: 'V1', weightKg: 5, lengthMm: 500, widthMm: 300, heightMm: 200, ...vc },
});
const PRICES = { vc: { marketPrice: 99, jdPrice: 89, costPrice: 50 } };
const field = (review, key) => review.fields.find((f) => f.key === key);
const sku = (review, title) => review.skuAttrs.find((a) => a.title === title);

test('reviewTemplate：按源商品类目（三级、四级都行）自动找模板；没有类目ID或类目没录制模板时为 null', () => {
  const auto = reviewTemplate({ product: tissue(), settings, catalog });
  assert.equal(auto.template.categoryName, '抽纸');
  assert.equal(auto.from, 'source');
  assert.equal(currentChoice(auto), '', '自动匹配的不算手动选择');
  const none = reviewTemplate({ product: tissue({ cateIds: [] }), settings, catalog });
  assert.equal(none.template, null);
  assert.equal(none.category, null);
  const other = reviewTemplate({ product: tissue({ cateIds: ['1320', '1583', '1590'] }), settings, catalog });
  assert.equal(other.template, null);
  assert.equal(other.category.categoryId, '1590');
});

test('选模板：存成编辑里的类目ID路径，不是末级的三级类目带上选的四级类目；选“自动”清掉手动类目', () => {
  const choices = templateChoices(catalog).flatMap((g) => g.options);
  assert.equal(choices.length, 15, '7 个末级三级类目 + 抽纸 5 个四级 + 卷纸 3 个四级');
  assert.ok(choices.some((o) => o.value === '15908:44478' && o.label === '抽纸 > 悬挂式抽纸'));
  const before = { title: 'x' };
  const picked = applyTemplateChoice(before, catalog, '15908:44478');
  assert.deepEqual(picked.cateList, ['15901', '15902', '15908', '44478']);
  assert.equal(picked.cateName, '家庭清洁/纸品 > 清洁纸品 > 抽纸 > 悬挂式抽纸');
  assert.deepEqual(before, { title: 'x' }, '不改原对象');
  const product = tissue({ cateIds: [] });
  const match = reviewTemplate({ product, edits: picked, settings, catalog });
  assert.equal(match.from, 'manual');
  assert.equal(currentChoice(match), '15908:44478');
  assert.deepEqual(applyTemplateChoice(picked, catalog, ''), { title: 'x' });
  assert.equal(applyTemplateChoice(picked, catalog, '99999:1'), picked, '不认识的模板不改');
  assert.equal(autoTemplate({ product, edits: picked, settings, catalog }).template, null, '不选模板时这个商品没有模板');
  const wipes = applyTemplateChoice({}, catalog, '15911:15911');
  assert.deepEqual(wipes.cateList, ['15901', '15902', '15911']);
});

test('手动指定的类目不在模板里时，下拉框显示“手动指定”（currentChoice 为 null）', () => {
  const edits = { cateList: ['1320', '1583', '1590'], cateName: '食品 > 饼干' };
  const match = reviewTemplate({ product: tissue(), edits, settings, catalog });
  assert.equal(match.template, null);
  assert.equal(currentChoice(match), null);
});

test('模板目录：按类目ID路径找模板；末级类目列表和选模板后的类目', () => {
  assert.equal(findCatalogTemplate(catalog, ['15901', '15902', '15909', '40884']).categoryName, '卷纸');
  assert.equal(findCatalogTemplate(null, '15909'), null);
  assert.deepEqual(vcTemplateLeaves(read('15911.json')), [{ id: '15911', name: '湿巾' }]);
  assert.equal(vcTemplateLeaves(read('15909.json')).length, 3);
  assert.equal(vcTemplateCategory(read('15909.json')).cateList.at(-1), '40883', '默认用录制模板的四级类目');
  assert.equal(vcTemplateSkuAttrs(read('15908.json')).find((a) => a.title === '纸张尺寸').kind, 'numbers');
});

test('applyReviewValue：返回新对象；ERP 分开存；属性写进属性覆盖，清空时删掉；数字字段只存正数', () => {
  const edits = { vc: { erpCode: 'a.b', marketPrice: 9 }, attrOverrides: { 香型: '有香型' } };
  const next = applyReviewValue(edits, 'saler', 'c.d');
  assert.deepEqual(next.vc, { marketPrice: 9, buyerErp: 'a.b', salerErp: 'c.d' });
  assert.deepEqual(edits.vc, { erpCode: 'a.b', marketPrice: 9 }, '不改原对象');
  assert.deepEqual(applyReviewValue(edits, 'attr:香型', ' ').attrOverrides, undefined);
  assert.deepEqual(applyReviewValue(edits, 'attr:层数', '3层').attrOverrides, { 香型: '有香型', 层数: '3层' });
  assert.deepEqual(applyReviewValue({}, 'lengthMm', '320').vc, { lengthMm: 320 });
  assert.deepEqual(applyReviewValue({ vc: { lengthMm: 1 } }, 'lengthMm', ''), {});
  assert.equal(applyReviewValue({}, 'upc', '6901234567892').upc, '6901234567892');
  assert.equal(applyReviewValue({}, 'upc', '123').upc, undefined, '无效条形码不存');
  assert.equal(applyReviewValue({}, 'title', '  新标题 ').title, '新标题');
  assert.equal(applyReviewValue(edits, 'nope', '1'), edits);
  assert.equal(reviewOwnValue(next, 'buyer'), 'a.b');
  assert.equal(reviewOwnValue(next, 'attr:香型'), '有香型');
});

test('reviewValueError：价格小数位、按模板的长宽高范围、品牌ID、ERP、条形码、标题长度', () => {
  const wipes = read('15911.json');
  assert.equal(reviewValueError('jdPrice', '89.999'), '最多 2 位小数');
  assert.equal(reviewValueError('costPrice', '50.1234'), '');
  assert.equal(reviewValueError('jdPrice', 'abc'), '京东价(元)要填正数');
  assert.match(reviewValueError('lengthMm', '3000', wipes), /1~2900 mm/);
  assert.equal(reviewValueError('lengthMm', '3000'), '', '没有模板时按默认上限 4000');
  assert.equal(reviewValueError('lengthMm', '320.4', wipes), '', '长宽高四舍五入成整数');
  assert.equal(reviewValueError('weightKg', '4.3333', wipes), '最多 3 位小数');
  assert.equal(reviewValueError('weightKg', '4.3333', wipes, { typed: false }), '', '采集到的值发布时会四舍五入');
  assert.equal(reviewValueError('brandId', '17519'), '');
  assert.equal(reviewValueError('brandId', '维达'), '品牌ID是数字');
  assert.match(reviewValueError('buyer', '张三'), /不能填姓名/);
  assert.match(reviewValueError('upc', '6901234567890'), /条形码/);
  assert.match(reviewValueError('title', '超'.repeat(31)), /超过 60/);
  assert.equal(reviewValueError('model', 'x'.repeat(101), wipes), '最多 100 个字');
  assert.equal(reviewValueError('lengthMm', ''), '');
});

test('buildReview：齐全的商品打开发布页前的检查也通过；缺采购价和必填 SKU属性时列出来', () => {
  const product = tissue();
  const { template } = reviewTemplate({ product, settings, catalog });
  const missing = buildReview({ product, edits: { vc: { marketPrice: 99, jdPrice: 89 } }, settings, template });
  assert.equal(missing.ready, false);
  assert.deepEqual(missing.problems, ['采购价(元)', '纸张尺寸']);
  assert.equal(field(missing, 'costPrice').state, 'missing');
  assert.equal(sku(missing, '纸张尺寸').state, 'missing');
  assert.equal(sku(missing, '层数').value, '3层');
  assert.equal(sku(missing, '包数').value, '36包', '只带单位的输入框用规格里的数量');
  assert.equal(sku(missing, '包数').from, '规格');
  const edits = applyReviewValue(PRICES, 'attr:纸张尺寸', '195*133mm');
  const ready = buildReview({ product, edits, settings, template });
  assert.equal(ready.ready, true);
  assert.equal(sku(ready, '纸张尺寸').value, '195 × 133');
  assert.equal(sku(ready, '纸张尺寸').from, '手动填写');
  assert.deepEqual(vcPreflight({ product, edits, settings, template }).blockers, []);
  assert.equal(field(ready, 'title').from, '按源标题生成');
  assert.equal(field(ready, 'title').value, '抽纸 3层100抽*36包');
});

test('buildReview：源商品的长宽高超出本类目范围时标红并要求填写；占位值按默认值填写并提醒核对', () => {
  const wipes = read('15911.json');
  const big = buildReview({ product: tissue({ cateIds: ['15901', '15902', '15911'], lengthMm: 3500 }), edits: PRICES, settings, template: wipes });
  const length = field(big, 'lengthMm');
  assert.equal(length.state, 'error');
  assert.match(length.note, /采集的值“3500”超出本类目允许的范围（1~2900 mm）/);
  assert.equal(length.limits, '范围 1~2900 mm');
  assert.ok(big.problems.includes('包装长(mm)'));
  const fake = buildReview({ product: tissue({ lengthMm: 1, widthMm: 1, heightMm: 1, weightKg: 0.01 }), edits: PRICES, settings, template: null });
  assert.equal(field(fake, 'lengthMm').state, 'default');
  assert.equal(field(fake, 'lengthMm').value, '100');
  assert.match(field(fake, 'weightKg').note, /占位值/);
  assert.ok(fake.checks >= 4);
});

test('buildReview：京东价高于市场价标红，采购价不低于京东价提醒；货号当型号、没有条形码提醒核对', () => {
  const r = buildReview({ product: tissue({ model: '', itemNum: 'H-1' }), edits: { vc: { marketPrice: 50, jdPrice: 60, costPrice: 70 } }, settings, template: null });
  assert.equal(field(r, 'jdPrice').state, 'error');
  assert.equal(field(r, 'jdPrice').note, '京东价不能高于市场价');
  assert.equal(field(r, 'costPrice').state, 'warn');
  assert.equal(field(r, 'model').state, 'warn');
  assert.equal(field(r, 'model').from, '采集（货号）');
  assert.equal(field(r, 'upc').state, 'warn');
  assert.equal(field(r, 'buyer').state, 'ok', 'ERP 不填沿用页面默认');
  assert.ok(!r.ready);
});

test('buildReview：没有类目时缺项里有“上架模板（类目）”，没有模板时不检查属性；没有图片时列出', () => {
  const product = { ...tissue({ cateIds: [] }), mainImages: [], detailImages: [] };
  const r = buildReview({ product, edits: PRICES, settings, template: null });
  assert.ok(r.problems.includes(NO_CATEGORY));
  assert.deepEqual(r.props, []);
  assert.deepEqual(r.skuAttrs, []);
  assert.deepEqual(r.images.problems, ['主图', '详情图']);
  assert.ok(r.blockers.some((b) => b.includes('类目ID')));
});

test('buildReview：商品属性用发布流程的匹配结果，选项对不上的标出来；设置关闭 SKU属性填写时不算缺项', () => {
  const wipes = read('15911.json');
  const product = tissue({ cateIds: ['15901', '15902', '15911'] }, [{ name: '是否消字号商品', value: '否' }]);
  const r = buildReview({ product, edits: PRICES, settings, template: wipes });
  const xiao = r.props.find((a) => a.title === '是否消字号商品');
  assert.equal(xiao.state, 'error');
  assert.match(xiao.note, /“否”不在可选项里/);
  assert.ok(r.problems.includes('是否消字号商品'));
  const fixed = buildReview({ product, edits: applyReviewValue(PRICES, 'attr:是否消字号商品', '非消字号'), settings, template: wipes });
  assert.equal(fixed.props.find((a) => a.title === '是否消字号商品').from, '手动填写');
  const off = buildReview({ product, edits: PRICES, settings: mergeSettings({ publish: { fillSkuAttrs: false } }), template: wipes });
  assert.equal(off.skuAttrsOn, false);
  assert.ok(!off.problems.includes('香型'));
  assert.ok(r.problems.includes('香型'), 'SKU属性必填：香型');
});

test('SKU属性和发布页抽屉的取值规则一致：完全相同优先、互相包含；下拉要对上选项；长×宽要两个数', () => {
  assert.equal(plannedKey('单包片数', { 片数: '80片' }), '片数');
  assert.equal(plannedKey('香型', { 香型: '无香', 香: 'x' }), '香型');
  assert.equal(plannedKey('层数', { 包数: '3' }), null);
  assert.equal(pickOption(['有香型', '无香型'], '无香'), '无香型');
  assert.equal(pickOption(['消字号', '非消字号'], '是'), null);
  const attrs = vcTemplateSkuAttrs(read('15908.json'));
  const sources = { overrides: { 纸张尺寸: '195mm' }, params: { 香型: '桂花香' }, defaults: {} };
  const rows = reviewSkuAttrs(attrs, { sources, units: { 抽: '100' } });
  const size = rows.find((a) => a.title === '纸张尺寸');
  assert.equal(size.state, 'error');
  assert.match(size.note, /要有 2 个数字/);
  assert.equal(rows.find((a) => a.title === '香型').state, 'warn', '选填的对不上选项只提醒（发布时跳过）');
  const own = reviewSkuAttrs(attrs, { sources: { ...sources, overrides: { 香型: '桂花香' } }, units: {} });
  assert.equal(own.find((a) => a.title === '香型').state, 'error', '自己填的对不上选项算错');
  assert.equal(rows.find((a) => a.title === '单包抽数' && a.required).value, '100抽');
  assert.equal(rows.find((a) => a.title === '包数').state, 'missing');
});

test('rebaseEdits：保存时只覆盖弹窗里改过的项，弹窗打开期间在别处的修改保留；ERP 三个键当成一项', () => {
  const base = { title: 'A', vc: { marketPrice: 9, erpCode: 'a.b' }, attrOverrides: { 香型: '有香型' } };
  const draft = { title: 'A', vc: { marketPrice: 9, jdPrice: 8, buyerErp: 'a.b', salerErp: 'c.d' }, attrOverrides: { 香型: '有香型', 层数: '3层' }, cateList: ['1', '2'], cateName: 'x' };
  const current = { title: 'B', upc: '6901234567892', vc: { marketPrice: 10, erpCode: 'a.b', model: 'M2' }, attrOverrides: { 香型: '无香型' } };
  const merged = rebaseEdits(base, draft, current);
  assert.deepEqual(merged, {
    title: 'B',
    upc: '6901234567892',
    cateList: ['1', '2'],
    cateName: 'x',
    vc: { marketPrice: 10, model: 'M2', jdPrice: 8, buyerErp: 'a.b', salerErp: 'c.d' },
    attrOverrides: { 香型: '无香型', 层数: '3层' },
  });
  assert.deepEqual(current.vc, { marketPrice: 10, erpCode: 'a.b', model: 'M2' }, '不改原对象');
  assert.deepEqual(rebaseEdits(base, base, current), current, '弹窗没改的全部保留存储里的');
  const cleared = rebaseEdits({ cateList: ['1'], cateName: 'x', vc: { lengthMm: 5 } }, {}, { cateList: ['1'], cateName: 'x', vc: { lengthMm: 5 } });
  assert.deepEqual(cleared, {}, '弹窗里清掉的项保存后也清掉');
});

test('reviewPropAttrs：湿厕纸纸张尺寸显示成“200mm × 140mm”；数字不够时标出来', () => {
  const attrs = vcTemplateAttrs(read('15913.json')).filter((a) => a.title === '纸张尺寸');
  const okPlan = buildPropPlan(attrs, { params: [{ name: '纸张尺寸', value: '200*140mm' }] });
  const [ok] = reviewPropAttrs(attrs, okPlan.report);
  assert.equal(ok.state, 'ok');
  assert.equal(ok.value, '200mm × 140mm');
  const badPlan = buildPropPlan(attrs, { params: [{ name: '纸张尺寸', value: '200mm' }] });
  const [bad] = reviewPropAttrs(attrs, badPlan.report);
  assert.equal(bad.state, 'error');
  assert.match(bad.note, /长×宽/);
  const [none] = reviewPropAttrs(attrs, buildPropPlan(attrs, { params: [] }).report);
  assert.equal(none.state, 'missing');
});
