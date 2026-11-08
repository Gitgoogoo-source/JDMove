// VC 自营发布的填写计划（纯函数）：用 2026-11 走查过的维达抽纸样本
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildVcPublishPlan, vcPreflight, vcTarget, vcTitle, vcActionLabel, vcWeightKg, defaultPackListing } from '../src/shared/vc-plan.js';
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

test('vcTarget: 新采集的商品没有类目 ID 时，说明是采集时没读到，并给出类目ID路径的写法', () => {
  const noCate = { ...product(), vc: { ...product().vc, cateIds: [] } };
  const { error } = vcTarget({ product: noCate, edits: {}, settings: settings() });
  assert.doesNotMatch(error, /之前采集的商品/);
  assert.match(error, /采集时没有读到/);
  assert.match(error, /15901,15902,15908/);
  assert.match(error, /保存/);
  const offShelf = vcTarget({ product: { ...noCate, offShelf: '商品已下架' }, edits: {}, settings: settings() }).error;
  assert.match(offShelf, /源商品已下架/);
});

test('vcTarget: 缺品牌 ID 时说明在哪里填', () => {
  const noBrand = { ...product(), vc: { ...product().vc, brandId: null }, brand: { id: null, name: '维达（Vinda）' } };
  const { error } = vcTarget({ product: noBrand, edits: {}, settings: settings() });
  assert.match(error, /编辑 → VC 自营 → 品牌ID/);
  assert.match(error, /维达（Vinda）/);
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
  assert.ok(!blockers.some((b) => /长宽高|毛重/.test(b)), blockers.join('\n'));
  const filled = { vc: { ...PRICES, model: 'M1', lengthMm: 1, widthMm: 2, heightMm: 3, weightKg: 0.5 } };
  assert.deepEqual(vcPreflight({ product: old, edits: filled, settings: settings() }).blockers, []);
});

// POP 商品（2026-11 维达官方旗舰店 30235277278）：主数据没有型号、长宽高是 0，只有货号和毛重
const popProduct = () => ({ ...product(), vc: { ...product().vc, model: '', itemNum: 'V2182-A', lengthMm: null, widthMm: null, heightMm: null } });

test('vcPreflight: POP 商品没有型号时用货号，不再拦下', () => {
  const { blockers } = vcPreflight({ product: popProduct(), edits: { vc: PRICES }, settings: settings() });
  assert.ok(!blockers.some((b) => /型号/.test(b)), blockers.join('\n'));
});

test('buildVcPublishPlan: 源商品主数据里没有长宽高时按默认 100mm 填写并提醒核对，已有的毛重不覆盖', () => {
  const plan = buildVcPublishPlan({ product: popProduct(), edits: { vc: PRICES }, settings: settings(), schema: SCHEMA });
  assert.ok(!plan.blockers.some((b) => /长宽高/.test(b)), plan.blockers.join('\n'));
  assert.equal(plan.logistics.length, 100);
  assert.equal(plan.logistics.wide, 100);
  assert.equal(plan.logistics.height, 100);
  assert.equal(plan.logistics.weight, 4.33);
  const dims = plan.warnings.find((w) => /长宽高\/毛重按默认值/.test(w));
  assert.match(dims, /长 100mm、宽 100mm、高 100mm）?/);
  assert.doesNotMatch(dims, /毛重 0/);
  assert.match(dims, /源商品主数据里没有/);
});

test('buildVcPublishPlan: 主数据里是占位值（1×1×1 mm、0.01 kg）时当成没有，按默认 100mm / 0.5kg 填写', () => {
  const fake = { ...product(), vc: { ...product().vc, lengthMm: 1, widthMm: 1, heightMm: 1, weightKg: 0.01 } };
  const plan = buildVcPublishPlan({ product: fake, edits: { vc: PRICES }, settings: settings(), schema: SCHEMA });
  assert.deepEqual([plan.logistics.length, plan.logistics.wide, plan.logistics.height, plan.logistics.weight], [100, 100, 100, 0.5]);
  const dims = plan.warnings.find((w) => /长宽高\/毛重按默认值/.test(w));
  assert.match(dims, /长、?.*毛重 0\.5kg/);
  assert.match(dims, /占位值/);
});

test('buildVcPublishPlan: 源商品有长宽高/毛重时不用默认值', () => {
  const plan = buildVcPublishPlan({ product: product(), edits: { vc: PRICES }, settings: settings(), schema: SCHEMA });
  assert.deepEqual([plan.logistics.length, plan.logistics.wide, plan.logistics.height, plan.logistics.weight], [408, 310, 280, 4.33]);
  assert.ok(!plan.warnings.some((w) => /长宽高\/毛重按默认值/.test(w)), plan.warnings.join("\n"));
});

test('buildVcPublishPlan: 型号用货号时提醒核对', () => {
  const edits = { vc: { ...PRICES, lengthMm: 408, widthMm: 310, heightMm: 280 } };
  const plan = buildVcPublishPlan({ product: popProduct(), edits, settings: settings(), schema: SCHEMA });
  assert.deepEqual(plan.blockers, []);
  assert.equal(plan.model, 'V2182-A');
  assert.ok(plan.warnings.some((w) => /型号.*货号.*V2182-A/.test(w)), plan.warnings.join('\n'));
  const own = buildVcPublishPlan({ product: popProduct(), edits: { vc: { ...edits.vc, model: 'X1' } }, settings: settings(), schema: SCHEMA });
  assert.equal(own.model, 'X1');
  assert.ok(!own.warnings.some((w) => /货号/.test(w)));
});

test('buildVcPublishPlan: 样本商品生成完整计划', () => {
  const plan = buildVcPublishPlan({ product: product(), edits: { vc: { ...PRICES, erpCode: 'xudezhi.6' } }, settings: settings(), schema: SCHEMA });
  assert.deepEqual(plan.blockers, []);
  assert.equal(plan.title, '抽纸 棉韧3层100抽*36包S码 亲肤无刺激纸巾 AB混发');
  assert.equal(plan.model, 'V2833-D');
  assert.deepEqual(plan.erp, { buyer: 'xudezhi.6', saler: 'xudezhi.6' });
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
    packListing: '维达 常规抽纸 x1',
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
  assert.deepEqual(plan.erp, { buyer: '', saler: '' });
  assert.ok(plan.warnings.some((w) => /采购员\/销售员 ERP 没有填写/.test(w)));
  assert.ok(plan.warnings.some((w) => /毛利/.test(w)));
});

test('buildVcPublishPlan: 采购员和销售员 ERP 可以不同；只填一个时另一个用设置里的默认 ERP，都没有时提醒缺的那个', () => {
  const own = buildVcPublishPlan({ product: product(), edits: { vc: { ...PRICES, buyerErp: 'caigou.1', salerErp: 'xiaoshou.2' } }, settings: settings(), schema: SCHEMA });
  assert.deepEqual(own.erp, { buyer: 'caigou.1', saler: 'xiaoshou.2' });
  assert.ok(!own.warnings.some((w) => /ERP/.test(w)));
  const withDefault = buildVcPublishPlan({ product: product(), edits: { vc: { ...PRICES, buyerErp: 'caigou.1' } }, settings: settings({ vc: { erpCode: 'moren' } }), schema: SCHEMA });
  assert.deepEqual(withDefault.erp, { buyer: 'caigou.1', saler: 'moren' });
  const half = buildVcPublishPlan({ product: product(), edits: { vc: { ...PRICES, salerErp: 'xiaoshou.2' } }, settings: settings(), schema: SCHEMA });
  assert.deepEqual(half.erp, { buyer: '', saler: 'xiaoshou.2' });
  assert.ok(half.warnings.some((w) => /^采购员ERP 没有填写/.test(w)), half.warnings.join('\n'));
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
  assert.deepEqual(plan.erp, { buyer: 'zhangsan', saler: 'zhangsan' });
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

test('vcActionLabel: VC 一律点“保存草稿”，只填写不保存时不点按钮', () => {
  assert.equal(vcActionLabel('submit_on'), 'vc_draft');
  assert.equal(vcActionLabel('submit_off'), 'vc_draft');
  assert.equal(vcActionLabel('draft'), 'vc_draft');
  assert.equal(vcActionLabel('none'), null);
});

test('vcWeightKg: 毛重按页面规则最多 3 位小数，不足 0.01 按 0.01，无效值为 null', () => {
  assert.equal(vcWeightKg(4.33), 4.33);
  assert.equal(vcWeightKg(4.3336), 4.334);
  assert.equal(vcWeightKg('2.06'), 2.06);
  assert.equal(vcWeightKg(5), 5);
  assert.equal(vcWeightKg(0.004), 0.01);
  assert.equal(vcWeightKg(0), null);
  assert.equal(vcWeightKg('abc'), null);
});

test('buildVcPublishPlan: 写入页面的值都是字符串（毛重 4.33 → "4.33"）', () => {
  const plan = buildVcPublishPlan({ product: product(), edits: { vc: PRICES }, settings: settings(), schema: SCHEMA });
  assert.ok(plan.form.every((e) => typeof e.value === 'string'));
  assert.equal(plan.form.find((e) => e.field === 'weight').value, '4.33');
  assert.equal(plan.form.find((e) => e.field === 'packSpecification').value, '1');
  const edited = buildVcPublishPlan({ product: product(), edits: { vc: { ...PRICES, weightKg: 1.2704 } }, settings: settings(), schema: SCHEMA });
  assert.equal(edited.form.find((e) => e.field === 'weight').value, '1.27');
});

test('vcPreflight: 长宽高超出页面范围时不打开页面', () => {
  const { blockers } = vcPreflight({ product: product(), edits: { vc: { ...PRICES, lengthMm: 5000 } }, settings: settings() });
  assert.ok(blockers.some((b) => /长“5000”超出页面允许的范围（1~4000mm/.test(b)), blockers.join('\n'));
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

test('buildVcPublishPlan: 包装清单按 编辑 > 采集到的 > 设置 > 品牌 类目 x1', () => {
  const pack = '维达（Vinda）抽纸 棉韧3层100抽*36包S码 亲肤无刺激 纸巾 整箱';
  const withPack = { ...product(), packList: pack };
  const s = settings({ packList: '抽纸*36' });
  const plan = (p, edits = {}) => buildVcPublishPlan({ product: p, edits: { vc: { ...PRICES, ...edits } }, settings: s, schema: SCHEMA });
  assert.equal(plan(withPack).logistics.packListing, pack);
  assert.equal(plan(withPack, { packListing: '手填*1' }).logistics.packListing, '手填*1');
  assert.equal(plan(product()).logistics.packListing, '抽纸*36');
});

test('buildVcPublishPlan: 源商品没有包装清单时默认填“品牌 类目 x1”，有则不覆盖', () => {
  const plan = (p) => buildVcPublishPlan({ product: p, edits: { vc: PRICES }, settings: settings(), schema: SCHEMA });
  assert.equal(plan({ ...product(), packList: '' }).logistics.packListing, '维达 常规抽纸 x1');
  assert.equal(plan({ ...product(), packList: '抽纸*36包' }).logistics.packListing, '抽纸*36包');
});

test('defaultPackListing: 品牌去掉括号里的外文名；只有外文名、没有品牌或类目时也能生成', () => {
  assert.equal(defaultPackListing({ brand: { name: '德芙（Dove）' }, leafCategory: '牛奶巧克力' }), '德芙 牛奶巧克力 x1');
  assert.equal(defaultPackListing({ brand: { name: '(Apple)' }, leafCategory: '手机' }), '(Apple) 手机 x1');
  assert.equal(defaultPackListing({ brand: { name: '' }, leafCategory: '抽纸' }), '抽纸 x1');
  assert.equal(defaultPackListing({}), '商品 x1');
});

test('buildVcPublishPlan: 有京东给的无品牌标题时用它生成标题', () => {
  const p = { ...product(), title: '维达（Vinda）旧标题', vc: { ...product().vc, titleNoBrand: '抽纸【孙颖莎推荐】棉韧3层100抽*36包S码' } };
  const plan = buildVcPublishPlan({ product: p, edits: { vc: PRICES }, settings: settings(), schema: SCHEMA });
  assert.equal(plan.title, '抽纸 棉韧3层100抽*36包S码');
  const edited = buildVcPublishPlan({ product: p, edits: { title: '手改标题', vc: PRICES }, settings: settings(), schema: SCHEMA });
  assert.equal(edited.title, '手改标题');
});

test('buildVcPublishPlan: 源商品是危险品时提醒核对；不是时不提醒', () => {
  const danger = { ...product(), vc: { ...product().vc, dangerGoods: true } };
  const plan = buildVcPublishPlan({ product: danger, edits: { vc: PRICES }, settings: settings(), schema: SCHEMA });
  assert.equal(plan.dangerGoods, true);
  assert.ok(plan.warnings.some((w) => /危险品/.test(w)));
  const normal = buildVcPublishPlan({ product: { ...product(), vc: { ...product().vc, dangerGoods: false } }, edits: { vc: PRICES }, settings: settings(), schema: SCHEMA });
  assert.equal(normal.dangerGoods, false);
  assert.ok(!normal.warnings.some((w) => /危险品/.test(w)));
});

test('buildVcPublishPlan: 规格按钮没采到时用主数据里的销售属性', () => {
  const p = { ...product(), variants: [], vc: { ...product().vc, saleAttrs: [{ name: '规格', value: '【王牌囤货装】 3层 100抽*36包' }] } };
  const plan = buildVcPublishPlan({ product: p, edits: { vc: PRICES }, settings: settings(), schema: SCHEMA });
  assert.equal(plan.sku.spec.desc, '王牌囤货装');
  assert.deepEqual(plan.skuAttrUnits, { 层: '3', 抽: '100', 包: '36' });
});

test('buildVcPublishPlan: 源商品没有「适用场景」时默认填“通用”', () => {
  const p = product();
  const bare = { ...p, params: p.params.filter((x) => x.name !== '适用场景') };
  const plan = buildVcPublishPlan({ product: bare, edits: { vc: PRICES }, settings: settings(), schema: SCHEMA });
  assert.equal(plan.props.values['132416'], '3');
  assert.equal(plan.props.report.find((r) => r.title === '适用场景').status, 'default');
  assert.ok(!plan.props.missingRequired.includes('适用场景'));
});

test('buildVcPublishPlan: 源商品有「适用场景」时不被默认值覆盖', () => {
  const plan = buildVcPublishPlan({ product: product(), edits: { vc: PRICES }, settings: settings(), schema: SCHEMA });
  assert.equal(plan.props.values['132416'], '704205');
});

test('buildVcPublishPlan: 设置里的「适用场景」默认值优先于内置“通用”', () => {
  const p = product();
  const bare = { ...p, params: p.params.filter((x) => x.name !== '适用场景') };
  const s = settings({ attrDefaultsText: '适用场景=商用' });
  const plan = buildVcPublishPlan({ product: bare, edits: { vc: PRICES }, settings: s, schema: SCHEMA });
  assert.equal(plan.props.values['132416'], '1');
});
