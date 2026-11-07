// VC 自营发布的填写计划（纯函数）：用 2026-11 走查过的维达抽纸样本
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildVcPublishPlan, vcPreflight, vcTarget, vcTitle, vcActionLabel } from '../src/shared/vc-plan.js';
import { mergeSettings } from '../src/shared/settings.js';
import { weightedLength } from '../src/shared/title.js';

const product = () => ({
  skuId: '100114866451',
  title: '维达（Vinda）抽纸【孙颖莎推荐】棉韧3层100抽*36包S码 亲肤无刺激纸巾 AB混发',
  brand: { id: 17519, name: '维达（Vinda）' },
  crumbs: ['家庭清洁/纸品', '清洁纸品', '抽纸', '常规抽纸', '维达（Vinda）'],
  leafCategory: '常规抽纸',
  price: 44.9,
  params: [
    { name: '层数', value: '3层' },
    { name: '香型', value: '无香型' },
    { name: '原料成分', value: '原生木浆' },
    { name: '包装形式', value: '箱装' },
    { name: '适用场景', value: '家用' },
    { name: '是否印花', value: '无印花' },
    { name: '单包抽数', value: '100抽' },
    { name: '纸张尺寸', value: '长195mm 宽133mm' },
    { name: '类型', value: '软包式' },
    { name: '类别', value: '抽取式' },
  ],
  mainImages: ['https://img14.360buyimg.com/sku/jfs/t1/a.jpg', 'https://img14.360buyimg.com/sku/jfs/t1/b.jpg'],
  detailImages: ['https://img30.360buyimg.com/sku/jfs/t1/d1.jpg'],
  saleDims: [{ name: '规格', values: ['【王牌囤货装】 3层 100抽*36包'] }],
  variants: [{ skuId: '100114866451', values: { 规格: '【王牌囤货装】 3层 100抽*36包' } }],
  upc: '6901236326411',
  packList: '',
  vc: {
    cateIds: ['15901', '15902', '15908', '31403'],
    brandId: 17519,
    model: 'V2833-D',
    weightKg: 4.33,
    lengthMm: 408,
    widthMm: 310,
    heightMm: 280,
    warranty: '无质保',
  },
});

const PRICES = { marketPrice: 89.9, jdPrice: 69.9, costPrice: 50 };
const settings = (patch = {}) => mergeSettings({ attrDefaultsText: '', ...patch });

const opt = (label, value) => ({ label, value });
// 常规抽纸[31403] 的商品属性（走查时页面上的 4 个）
const SCHEMA = {
  attrs: [
    { field: '132416', title: '适用场景', kind: 'select', required: true, options: [opt('家用', '704205'), opt('商用', '1'), opt('其他', '2'), opt('通用', '3')] },
    { field: '280256', title: '是否压花', kind: 'select', required: false, options: [opt('压花', 'a'), opt('非压花', 'b')] },
    { field: '164370', title: '类别', kind: 'select', required: false, options: [opt('抽取式', 'c1'), opt('悬挂式', 'c2'), opt('其他', 'c3')] },
    { field: '164372', title: '类型', kind: 'select', required: false, options: [opt('硬盒装', 't1'), opt('软包式', 't2')] },
  ],
  saleDimNames: [],
};

test('vcTarget: 默认用源商品的末级类目和品牌 ID', () => {
  assert.deepEqual(vcTarget({ product: product(), edits: {}, settings: settings() }), {
    target: { categoryId: '31403', cateList: ['15901', '15902', '15908', '31403'], brandId: 17519, name: '常规抽纸', from: 'source' },
  });
});

test('vcTarget: 编辑里手动指定的类目、品牌 ID 优先', () => {
  const edits = { cateList: ['1', '2', '3'], cateName: '手动类目', vc: { brandId: 18477 } };
  const { target } = vcTarget({ product: product(), edits, settings: settings() });
  assert.equal(target.categoryId, '3');
  assert.equal(target.brandId, 18477);
  assert.equal(target.from, 'manual');
});

test('vcTarget: 类目映射命中时用映射的类目', () => {
  const s = settings({ categoryMap: [{ source: '清洁纸品>抽纸', cateList: ['9', '8', '7'], name: '映射类目' }] });
  const { target } = vcTarget({ product: product(), edits: {}, settings: s });
  assert.equal(target.categoryId, '7');
  assert.equal(target.from, 'map');
});

test('vcTarget: 旧数据没有类目或品牌 ID 时给出原因', () => {
  const old = { ...product(), vc: undefined, brand: { id: null, name: '维达（Vinda）' } };
  assert.match(vcTarget({ product: old, edits: {}, settings: settings() }).error, /重新采集/);
  const noBrand = { ...product(), vc: { ...product().vc, brandId: null }, brand: { id: null, name: '' } };
  assert.match(vcTarget({ product: noBrand, edits: {}, settings: settings() }).error, /品牌/);
});

test('vcTitle: 去掉品牌（品牌前缀由页面自动加）和【】里的宣传语，按 60 字符截断', () => {
  const t = vcTitle(product().title, '维达（Vinda）', settings().title);
  assert.equal(t, '抽纸 棉韧3层100抽*36包S码 亲肤无刺激纸巾 AB混发');
  assert.ok(weightedLength(t) <= 60);
  assert.equal(vcTitle('Vinda维达 抽纸', '维达（Vinda）', settings().title), '抽纸');
});

test('vcPreflight: 5 个手动字段里的 3 个价格没填时，打开发布页之前就拦下', () => {
  const { blockers } = vcPreflight({ product: product(), edits: {}, settings: settings() });
  assert.ok(blockers.some((b) => /市场价、京东价、采购价/.test(b)), blockers.join('\n'));
});

test('vcPreflight: 京东价高于市场价时拦下；价格齐全且合理时没有缺项', () => {
  const high = vcPreflight({ product: product(), edits: { vc: { ...PRICES, jdPrice: 99 } }, settings: settings() });
  assert.ok(high.blockers.some((b) => /京东价.*市场价/.test(b)));
  assert.deepEqual(vcPreflight({ product: product(), edits: { vc: PRICES }, settings: settings() }).blockers, []);
});

test('vcPreflight: 旧数据缺型号/长宽高/毛重时提示重新采集或在编辑中填写', () => {
  const old = { ...product(), vc: undefined };
  const { blockers } = vcPreflight({ product: old, edits: { vc: PRICES }, settings: settings() });
  assert.ok(blockers.some((b) => /型号/.test(b)));
  assert.ok(blockers.some((b) => /长宽高|毛重/.test(b)));
  const filled = { vc: { ...PRICES, model: 'M1', lengthMm: 1, widthMm: 2, heightMm: 3, weightKg: 0.5 } };
  assert.deepEqual(vcPreflight({ product: old, edits: filled, settings: settings() }).blockers, []);
});

test('buildVcPublishPlan: 样本商品生成完整计划', () => {
  const plan = buildVcPublishPlan({ product: product(), edits: { vc: { ...PRICES, erpCode: 'xudezhi.6' } }, settings: settings(), schema: SCHEMA });
  assert.deepEqual(plan.blockers, []);
  assert.equal(plan.title, '抽纸 棉韧3层100抽*36包S码 亲肤无刺激纸巾 AB混发');
  assert.equal(plan.model, 'V2833-D');
  assert.equal(plan.erpCode, 'xudezhi.6');
  assert.deepEqual(plan.prices, PRICES);
  assert.deepEqual(plan.logistics, {
    length: 408,
    wide: 310,
    height: 280,
    weight: 4.33,
    unit: '箱',
    packSpecification: 1,
    packType: '普通商品',
    warranty: '无质保',
    packListing: '常规抽纸*1',
    sldays: null,
  });
  assert.deepEqual(plan.props.values, { 132416: '704205', 164370: 'c1', 164372: 't2' });
  assert.equal(plan.images.mainImageUrls.length, 2);
  assert.equal(plan.images.transparentUrl, plan.images.mainImageUrls[0]);
  assert.equal(plan.images.aiRecUrl, plan.images.mainImageUrls[0]);
  assert.equal(plan.sku.upc, '6901236326411');
  assert.equal(plan.sku.spec.desc, '王牌囤货装');
  assert.deepEqual(plan.skuAttrUnits, { 层: '3', 抽: '100', 包: '36' });
  assert.equal(plan.skuAttrValues['纸张尺寸'], '长195mm 宽133mm');
});

test('buildVcPublishPlan: SKU 商品名称 = 标题 + 标题里没有的规格内容，不超过 60 字符', () => {
  const plan = buildVcPublishPlan({ product: product(), edits: { vc: PRICES }, settings: settings(), schema: SCHEMA });
  assert.ok(plan.sku.name.startsWith(plan.title.slice(0, 10)));
  assert.match(plan.sku.name, /王牌囤货装/);
  assert.ok(weightedLength(plan.sku.name) <= 60, `${plan.sku.name} ${weightedLength(plan.sku.name)}`);
});

test('buildVcPublishPlan: 没填 ERP 时沿用页面默认值并提醒；采购价不低于京东价时提醒毛利为负', () => {
  const plan = buildVcPublishPlan({ product: product(), edits: { vc: { ...PRICES, costPrice: 70 } }, settings: settings(), schema: SCHEMA });
  assert.equal(plan.erpCode, '');
  assert.ok(plan.warnings.some((w) => /ERP/.test(w)));
  assert.ok(plan.warnings.some((w) => /毛利/.test(w)));
});

test('buildVcPublishPlan: VC 不使用默认 UPC；没有条形码时只提醒（入仓需要）', () => {
  const noUpc = { ...product(), upc: '' };
  const plan = buildVcPublishPlan({ product: noUpc, edits: { vc: PRICES }, settings: settings(), schema: SCHEMA });
  assert.equal(plan.sku.upc, '');
  assert.deepEqual(plan.blockers, []);
  assert.ok(plan.warnings.some((w) => /条形码/.test(w)));
});

test('buildVcPublishPlan: 设置里的 ERP、销售单位、包装清单生效；必填属性缺值时拦下', () => {
  const s = settings({ vc: { erpCode: 'zhangsan', saleUnit: '提' }, packList: '抽纸*36' });
  const schema = { ...SCHEMA, attrs: [...SCHEMA.attrs, { field: '9', title: '执行标准', kind: 'input', required: true, options: [] }] };
  const plan = buildVcPublishPlan({ product: product(), edits: { vc: PRICES }, settings: s, schema });
  assert.equal(plan.erpCode, 'zhangsan');
  assert.equal(plan.logistics.unit, '提');
  assert.equal(plan.logistics.packListing, '抽纸*36');
  assert.ok(plan.blockers.some((b) => /执行标准/.test(b)));
});

test('buildVcPublishPlan: 销售单位按包装形式推断时提醒核对；推断不出来时默认“件”并提示去设置', () => {
  const plan = buildVcPublishPlan({ product: product(), edits: { vc: PRICES }, settings: settings(), schema: SCHEMA });
  assert.ok(plan.warnings.some((w) => /销售单位按推断填写：箱/.test(w)));
  const bare = { ...product(), params: [], variants: [] };
  const fallback = buildVcPublishPlan({ product: bare, edits: { vc: PRICES }, settings: settings(), schema: { attrs: [] } });
  assert.equal(fallback.logistics.unit, '件');
  assert.ok(fallback.warnings.some((w) => /推断不出来/.test(w)));
});

test('buildVcPublishPlan: 参数里有保质期时换算成天数', () => {
  const p = { ...product(), params: [...product().params, { name: '保质期', value: '36个月' }] };
  const plan = buildVcPublishPlan({ product: p, edits: { vc: PRICES }, settings: settings(), schema: SCHEMA });
  assert.equal(plan.logistics.sldays, 1080);
});

test('vcActionLabel: VC 只有“发布商品”“保存草稿”两个按钮', () => {
  assert.equal(vcActionLabel('submit_on'), 'vc_publish');
  assert.equal(vcActionLabel('submit_off'), 'vc_publish');
  assert.equal(vcActionLabel('draft'), 'vc_draft');
  assert.equal(vcActionLabel('none'), null);
});

test('vcTitle: 只删开头的品牌简称和任意位置的完整品牌，不误删标题中间同字的词', () => {
  const opts = mergeSettings({}).title;
  assert.equal(vcTitle('金龙鱼食用油 5L', '金龙', opts), '鱼食用油 5L', '开头的简称照常删除（品牌本身就是这样写的）');
  assert.equal(vcTitle('食用油 金龙鱼同款 5L', '金龙', opts), '食用油 金龙鱼同款 5L');
  assert.equal(vcTitle('Professional 剃须刀 Pro', 'Pro', opts), 'Professional 剃须刀 Pro');
  assert.equal(vcTitle('抽纸 维达（Vinda）棉韧', '维达（Vinda）', opts), '抽纸 棉韧');
  assert.equal(vcTitle('Vinda维达 抽纸', '维达（Vinda）', opts), '抽纸');
});

test('buildVcPublishPlan: 销售单位取包装形式里最先出现的容器词', () => {
  const p = { ...product(), params: [{ name: '包装形式', value: '盒装（含6瓶，整箱发货）' }] };
  const plan = buildVcPublishPlan({ product: p, edits: { vc: PRICES }, settings: settings(), schema: { attrs: [] } });
  assert.equal(plan.logistics.unit, '盒');
});
