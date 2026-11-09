import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { findCatalogTemplate, findVcTemplateEntry, vcLeafTemplate, vcTemplateAttrs, vcTemplateCategory, vcTemplateFieldLimits, vcTemplateLimits, vcTemplateRequired } from '../src/shared/vc-templates.js';
import { buildVcPublishPlan, vcPreflight } from '../src/shared/vc-plan.js';
import { mergeSettings } from '../src/shared/settings.js';

const read = (f) => JSON.parse(fs.readFileSync(new URL(`../templates/vc/${f}`, import.meta.url), 'utf8'));
const index = read('index.json');

test('店铺可发布的 307 个三级类目都有模板，文件齐全、四级类目都列出', () => {
  assert.equal(index.templates.length, 307);
  assert.equal(new Set(index.templates.map((e) => e.categoryId)).size, 307);
  const roots = new Set(index.templates.map((e) => e.path.split(' > ')[0]));
  assert.deepEqual([...roots].sort(), ['个人护理', '休闲食品', '家庭清洁/纸品', '母婴', '水饮冲调', '粮油调味'].sort());
  for (const e of index.templates) {
    const t = read(e.file);
    assert.equal(t.categoryId, e.categoryId);
    assert.equal(t.path.length, 3, e.categoryName);
    assert.ok(t.baseFields.length && t.skuColumns.length && t.saleSpec.length, e.categoryName);
    assert.ok(e.leafIds.includes(t.publishCategoryId), e.categoryName);
    if (!t.isLeaf) assert.deepEqual(t.leafChildren.map((c) => c.id), e.leafIds, e.categoryName);
    for (const id of Object.keys(t.leafTemplates ?? {})) assert.ok(e.leafIds.includes(id) && id !== t.publishCategoryId, `${e.categoryName} ${id}`);
  }
});

test('其他一级类目也能按类目ID找到模板（牙膏、洗衣液、薯片）', () => {
  assert.equal(findVcTemplateEntry(index, ['16750', '16755', '16806']).categoryName, '牙膏');
  assert.equal(findVcTemplateEntry(index, '15924').categoryName, '普通洗衣液');
  assert.equal(findVcTemplateEntry(index, '37022').categoryName, '薯片');
  assert.equal(vcTemplateFieldLimits(read('16806.json'), 'length').max, 2000);
});

const catalog = { entries: index.templates, byId: new Map(index.templates.map((e) => [e.categoryId, read(e.file)])) };

test('四级类目的发布页和录制用的不同时，按四级类目取它自己的商品属性/SKU属性', () => {
  const tissue = read('15908.json');
  assert.ok(tissue.leafTemplates['44478'], '悬挂式抽纸和常规抽纸的发布页不同');
  const hanging = findCatalogTemplate(catalog, ['15901', '15902', '15908', '44478']);
  assert.equal(hanging.publishCategoryId, '44478');
  assert.equal(hanging.publishCategoryName, '悬挂式抽纸');
  for (const [k, v] of Object.entries(tissue.leafTemplates['44478'])) assert.deepEqual(hanging[k], v, k);
  assert.equal(hanging.leafTemplates, undefined);
  assert.equal(vcTemplateCategory(hanging).cateList.at(-1), '44478', '默认类目就是这个四级类目');

  const regular = findCatalogTemplate(catalog, ['15901', '15902', '15908', '31403']);
  assert.equal(regular.publishCategoryId, '31403');
  assert.deepEqual(regular.productProps, tissue.productProps);
  assert.equal(findCatalogTemplate(catalog, ['15901', '15902', '15908']), catalog.byId.get('15908'), '只有三级类目时用录制的那份');
  assert.equal(vcLeafTemplate(tissue, '99999'), tissue, '不是它的四级类目时原样返回');
  assert.equal(vcLeafTemplate(read('15911.json'), '15911').publishCategoryId, '15911');
});

test('驱蚊用品：各四级类目的必填商品属性不同，取到的模板各不相同', () => {
  const mosquito = read('15938.json');
  const req = (leaf) => JSON.stringify([vcTemplateRequired(vcLeafTemplate(mosquito, leaf)), vcTemplateAttrs(vcLeafTemplate(mosquito, leaf)).map((a) => a.field)]);
  const leaves = mosquito.leafChildren.map((c) => c.id);
  assert.ok(new Set(leaves.map(req)).size > 1);
});

test('三级、四级类目ID和类目路径都能找到模板', () => {
  assert.equal(findVcTemplateEntry(index, '15908').categoryName, '抽纸');
  assert.equal(findVcTemplateEntry(index, '44478').categoryName, '抽纸');
  assert.equal(findVcTemplateEntry(index, ['15901', '15902', '15909', '40884']).categoryName, '卷纸');
  assert.equal(findVcTemplateEntry(index, '99999'), null);
});

test('取值范围和必填项按类目不同', () => {
  assert.deepEqual(vcTemplateFieldLimits(read('15910.json'), 'length'), { min: 1, max: 3000, required: true });
  assert.equal(vcTemplateFieldLimits(read('15909.json'), 'length').max, 5000);
  const req = vcTemplateRequired(read('15908.json'));
  assert.ok(req.skuProps.includes('纸张尺寸'));
  assert.deepEqual(req.spec, ['层数', '单包抽数', '包数']);
});

test('上架模板的长宽高/毛重上限覆盖默认规则；商品属性结构同发布页', () => {
  assert.deepEqual(vcTemplateLimits(read('15910.json')).length, { min: 1, max: 3000 });
  assert.equal(vcTemplateLimits(null).length, undefined);
  const attrs = vcTemplateAttrs(read('15912.json'));
  const kind = attrs.find((a) => a.title === '类型');
  assert.equal(kind.kind, 'select');
  assert.ok(kind.required && kind.options.some((o) => o.label === '抽取式'));
});

const PLAN_SETTINGS = mergeSettings({});
const paperProduct = (vc = {}, params = []) => ({
  title: '维达 厨房纸巾 2层',
  brand: { id: 17519, name: '维达（Vinda）' },
  params,
  mainImages: ['https://img14.360buyimg.com/a.jpg'],
  detailImages: ['https://img30.360buyimg.com/d.jpg'],
  vc: { cateIds: ['15901', '15902', '15912'], brandId: 17519, model: 'X1', weightKg: 1, lengthMm: 3500, widthMm: 300, heightMm: 200, ...vc },
});
const VC_EDITS = { vc: { marketPrice: 30, jdPrice: 20, costPrice: 10 } };

test('vcPreflight：有模板时按类目的上限拦（手帕纸长 ≤ 3000），卷纸放宽到 5000', () => {
  const p = paperProduct({}, [{ name: '类型', value: '抽取式' }]);
  const none = vcPreflight({ product: p, edits: VC_EDITS, settings: PLAN_SETTINGS });
  assert.ok(!none.blockers.some((b) => b.startsWith('长')));
  const hanky = vcPreflight({ product: p, edits: VC_EDITS, settings: PLAN_SETTINGS, template: read('15910.json') });
  assert.ok(hanky.blockers.some((b) => b.includes('长“3500”') && b.includes('1~3000mm')));
  const big = paperProduct({ lengthMm: 4500 });
  assert.ok(vcPreflight({ product: big, edits: VC_EDITS, settings: PLAN_SETTINGS }).blockers.some((b) => b.startsWith('长')));
  assert.ok(!vcPreflight({ product: big, edits: VC_EDITS, settings: PLAN_SETTINGS, template: read('15909.json') }).blockers.some((b) => b.startsWith('长')));
});

test('vcPreflight：按模板检查必填商品属性，打开页面前拦下；发布页读到结构后以页面为准', () => {
  const p = paperProduct({ lengthMm: 300 }, [{ name: '类型', value: '抽取式' }]);
  const tpl = read('15912.json');
  const pre = vcPreflight({ product: p, edits: VC_EDITS, settings: PLAN_SETTINGS, template: tpl });
  const blocker = pre.blockers.find((b) => b.startsWith('必填属性未匹配'));
  assert.match(blocker, /上架模板「厨房纸巾」/);
  assert.match(blocker, /类别、功能/);
  assert.doesNotMatch(blocker, /类型/);
  const filled = { ...VC_EDITS, attrOverrides: { 类别: '干巾', 功能: '吸水' } };
  assert.deepEqual(vcPreflight({ product: p, edits: filled, settings: PLAN_SETTINGS, template: tpl }).blockers, []);
  const plan = buildVcPublishPlan({ product: p, edits: VC_EDITS, settings: PLAN_SETTINGS, template: tpl, schema: { attrs: [] } });
  assert.ok(!plan.blockers.some((b) => b.startsWith('必填属性未匹配')));
});

test('湿厕纸：模板记录了纸张尺寸的长/宽和单位，属性结构是 numbers', () => {
  const size = vcTemplateAttrs(read('15913.json')).find((a) => a.title === '纸张尺寸');
  assert.equal(size.kind, 'numbers');
  assert.ok(size.required);
  assert.deepEqual(size.segments, [
    { name: '长', units: ['mm'] },
    { name: '宽', units: ['mm'] },
  ]);
});

test('湿厕纸：采集参数或属性覆盖里有纸张尺寸时不再拦，发布页填 [{name, unit, value}]', () => {
  const tpl = read('15913.json');
  const params = [
    { name: '是否可冲散', value: '可冲散' },
    { name: '适用人群', value: '通用' },
  ];
  const p = paperProduct({ cateIds: ['15901', '15902', '15913'], lengthMm: 300 }, params);
  const missing = vcPreflight({ product: p, edits: VC_EDITS, settings: PLAN_SETTINGS, template: tpl });
  assert.match(missing.blockers.find((b) => b.startsWith('必填属性未匹配')), /纸张尺寸/);

  const collected = paperProduct({ cateIds: ['15901', '15902', '15913'], lengthMm: 300 }, [...params, { name: '纸张尺寸', value: '长200mm 宽140mm' }]);
  assert.deepEqual(vcPreflight({ product: collected, edits: VC_EDITS, settings: PLAN_SETTINGS, template: tpl }).blockers, []);

  const own = { ...VC_EDITS, attrOverrides: { 纸张尺寸: '20×14cm' } };
  assert.deepEqual(vcPreflight({ product: p, edits: own, settings: PLAN_SETTINGS, template: tpl }).blockers, []);
  const plan = buildVcPublishPlan({ product: p, edits: own, settings: PLAN_SETTINGS, template: tpl, schema: { attrs: vcTemplateAttrs(tpl) } });
  assert.deepEqual(plan.props.values['322216'], [
    { name: '长', unit: 'mm', value: '200' },
    { name: '宽', unit: 'mm', value: '140' },
  ]);
});
