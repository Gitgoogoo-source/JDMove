import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPublishPlan, descriptionHtml, publishImagePlan } from '../src/shared/publish-plan.js';
import { DEFAULT_SETTINGS, mergeSettings } from '../src/shared/settings.js';

const product = {
  skuId: '100001',
  title: '京东自营 德芙 丝滑牛奶巧克力 252g',
  brand: { id: 5962, name: '德芙（Dove）' },
  price: 50,
  params: [
    { name: '原产地', value: '中国大陆' },
    { name: '保质期', value: '12个月' },
    { name: '毛重', value: '300g' },
  ],
  mainImages: Array.from({ length: 12 }, (_, i) => `https://img/${i}.jpg`),
  detailImages: ['https://d/1.jpg', 'https://d/2.jpg'],
  saleDims: [],
  variants: [],
};

const schema = {
  attrs: [
    { field: '1', title: '产地', kind: 'select', required: true, options: [{ label: '中国大陆', value: 'cn' }] },
    { field: '2', title: '保质期', kind: 'input', required: true, suffix: '天', options: [] },
    { field: '3', title: '销售期限', kind: 'select', required: true, options: [{ label: '新日期：未过保质期1/3', value: 'n' }] },
  ],
  saleDimNames: ['规格', '口味'],
};

test('buildPublishPlan composes title, props, sale rows and images', () => {
  const settings = mergeSettings({ price: { multiplier: 1.2, add: 0, rounding: 'cent' }, stock: 30 });
  const plan = buildPublishPlan({ product, edits: {}, settings, schema });
  assert.equal(plan.title, '德芙 丝滑牛奶巧克力 252g');
  assert.deepEqual(plan.brand, { id: 5962, name: '德芙（Dove）' });
  assert.deepEqual(plan.props.values, { 1: 'cn', 2: '360', 3: 'n' });
  assert.equal(plan.sale.rows.length, 1);
  assert.equal(plan.sale.rows[0].price, 60);
  assert.equal(plan.sale.rows[0].stock, 30);
  assert.equal(plan.mainImageUrls.length, 10);
  assert.deepEqual(plan.detailImageUrls, ['https://d/1.jpg', 'https://d/2.jpg']);
  assert.equal(plan.weightKg, '0.3');
  assert.deepEqual(plan.blockers, []);
});

test('buildPublishPlan applies user edits', () => {
  const plan = buildPublishPlan({
    product,
    edits: { title: '自定义标题', price: 88, stock: 5, brandName: '其他品牌', attrOverrides: { 产地: '中国大陆' } },
    settings: DEFAULT_SETTINGS,
    schema,
  });
  assert.equal(plan.title, '自定义标题');
  assert.equal(plan.sale.rows[0].price, 88);
  assert.equal(plan.sale.rows[0].stock, 5);
  assert.deepEqual(plan.brand, { id: null, name: '其他品牌' });
});

test('buildPublishPlan fills 建议零售价 from the marked-up sale price × 1.1, ending in .9', () => {
  const settings = mergeSettings({ price: { multiplier: 1.05, add: 0, rounding: 'nine' } });
  const plan = buildPublishPlan({ product, edits: {}, settings, schema });
  assert.equal(plan.sale.rows[0].price, 52.9);
  assert.equal(plan.skuAttrValues['建议零售价'], '58.9');
  assert.equal(plan.skuAttrValues['市场价'], '58.9');
});

test('buildPublishPlan bases 建议零售价 on the edited price', () => {
  const plan = buildPublishPlan({ product, edits: { price: 88 }, settings: DEFAULT_SETTINGS, schema });
  assert.equal(plan.skuAttrValues['建议零售价'], '96.9');
});

test('buildPublishPlan bases 建议零售价 on the highest enabled variant price', () => {
  const multi = {
    ...product,
    saleDims: [{ name: '规格', values: ['a', 'b'] }],
    variants: [
      { skuId: '1', values: { 规格: 'a' } },
      { skuId: '2', values: { 规格: 'b' } },
    ],
    variantPrices: { 1: 50, 2: 80 },
  };
  const plan = buildPublishPlan({ product: multi, edits: {}, settings: DEFAULT_SETTINGS, schema });
  assert.equal(plan.skuAttrValues['建议零售价'], '88.9');
});

test('buildPublishPlan swaps watermarked n0 main images for sku originals', () => {
  const legacy = { ...product, mainImages: ['https://img14.360buyimg.com/n0/jfs/t1/1/2/3/a.jpg'] };
  const plan = buildPublishPlan({ product: legacy, schema, settings: mergeSettings({}), edits: {} });
  assert.deepEqual(plan.mainImageUrls, ['https://img14.360buyimg.com/sku/jfs/t1/1/2/3/a.jpg']);
});

test('publishImagePlan: 不需要表单结构就能算出主图/详情图地址（用于提前处理图片）', () => {
  const settings = mergeSettings({ publish: { maxMainImages: 3, maxDetailImages: 1 } });
  const legacy = { ...product, mainImages: ['https://img14.360buyimg.com/n0/jfs/t1/1/2/3/a.jpg', 'https://img/1.jpg', 'https://img/2.jpg', 'https://img/3.jpg'] };
  assert.deepEqual(publishImagePlan({ product: legacy, settings }), {
    mainImageUrls: ['https://img14.360buyimg.com/sku/jfs/t1/1/2/3/a.jpg', 'https://img/1.jpg', 'https://img/2.jpg'],
    detailImageUrls: ['https://d/1.jpg'],
  });
});

test('publishImagePlan: 编辑里指定的主图优先；没有图片时返回空列表', () => {
  const settings = mergeSettings({});
  assert.deepEqual(publishImagePlan({ product, edits: { mainImages: ['https://img/x.jpg'] }, settings }).mainImageUrls, ['https://img/x.jpg']);
  assert.deepEqual(publishImagePlan({ product: { title: 't' }, settings }), { mainImageUrls: [], detailImageUrls: [] });
});

test('buildPublishPlan 的图片地址与 publishImagePlan 一致', () => {
  const settings = mergeSettings({});
  const plan = buildPublishPlan({ product, edits: {}, settings, schema });
  const images = publishImagePlan({ product, edits: {}, settings });
  assert.deepEqual({ mainImageUrls: plan.mainImageUrls, detailImageUrls: plan.detailImageUrls }, images);
});

test('buildPublishPlan lists blockers for missing price and required attrs', () => {
  const plan = buildPublishPlan({
    product: { ...product, price: null, params: [] },
    edits: {},
    settings: mergeSettings({ attrDefaultsText: '' }),
    schema,
  });
  assert.ok(plan.blockers.some((b) => b.includes('价格')));
  // 产地可以按国产兜底；保质期没有来源也无法推断，仍然阻塞
  assert.ok(plan.blockers.some((b) => b.includes('保质期') && b.includes('属性默认值')));
});

test('buildPublishPlan: 源商品没有详情图时阻塞发布，提示重新采集', () => {
  const plan = buildPublishPlan({ product: { ...product, detailImages: [] }, edits: {}, settings: DEFAULT_SETTINGS, schema });
  assert.ok(plan.blockers.some((b) => b.includes('缺少详情图') && b.includes('重新采集')));
});

test('buildPublishPlan: 详情图数量设为 0 时不算缺少详情图', () => {
  const settings = mergeSettings({ publish: { maxDetailImages: 0 } });
  const plan = buildPublishPlan({ product, edits: {}, settings, schema });
  assert.deepEqual(plan.detailImageUrls, []);
  assert.ok(!plan.blockers.some((b) => b.includes('详情图')));
});

test('buildPublishPlan warns about guessed attribute values so they can be checked', () => {
  const plan = buildPublishPlan({
    product: { ...product, params: [{ name: '保质期', value: '12个月' }] },
    edits: {},
    settings: mergeSettings({}),
    schema,
  });
  assert.equal(plan.props.values['1'], 'cn');
  assert.ok(plan.warnings.some((w) => w.includes('产地') && w.includes('中国大陆')));
});

test('descriptionHtml wraps images in order and escapes urls', () => {
  const html = descriptionHtml(['https://a/1.jpg', 'https://a/2.jpg?x="y"']);
  assert.ok(html.indexOf('1.jpg') < html.indexOf('2.jpg'));
  assert.ok(!html.includes('"y"'));
  assert.equal(descriptionHtml([]), '');
});

test('buildPublishPlan: SKU attrs merge attribute defaults, overrides and the UPC field', () => {
  const settings = mergeSettings({ attrDefaultsText: '生产日期=2026-01-01\n原产地=默认' });
  const plan = buildPublishPlan({
    product,
    edits: { upc: '6901234567892', attrOverrides: { 建议零售价: '66' } },
    settings,
    schema,
  });
  assert.equal(plan.skuAttrValues['生产日期'], '2026-01-01');
  assert.equal(plan.skuAttrValues['原产地'], '中国大陆');
  assert.equal(plan.skuAttrValues['建议零售价'], '66');
  assert.equal(plan.skuAttrValues['最小可售单位UPC'], '6901234567892');
  assert.ok(!plan.warnings.some((w) => w.includes('UPC')));
});

test('buildPublishPlan uses the scraped UPC; the edit field overrides it', () => {
  const scraped = { ...product, upc: '6914973609563' };
  const plan = buildPublishPlan({ product: scraped, edits: {}, settings: DEFAULT_SETTINGS, schema });
  assert.equal(plan.skuAttrValues['最小可售单位UPC'], '6914973609563');
  assert.ok(!plan.warnings.some((w) => w.includes('UPC')));
  const edited = buildPublishPlan({ product: scraped, edits: { upc: '6901234567892' }, settings: DEFAULT_SETTINGS, schema });
  assert.equal(edited.skuAttrValues['最小可售单位UPC'], '6901234567892');
});

test('buildPublishPlan ignores a stored UPC that is just the SKU id (collected before the fix)', () => {
  const stale = { ...product, skuId: '100229520979', upc: '100229520979' };
  const plan = buildPublishPlan({ product: stale, edits: {}, settings: mergeSettings({ publish: { defaultUpc: '' } }), schema });
  assert.equal(plan.skuAttrValues['最小可售单位UPC'], undefined);
  assert.ok(plan.warnings.some((w) => w.includes('最小可售单位UPC')));
  const edited = buildPublishPlan({ product: stale, edits: { upc: '6901234567892' }, settings: DEFAULT_SETTINGS, schema });
  assert.equal(edited.skuAttrValues['最小可售单位UPC'], '6901234567892');
});

test('buildPublishPlan falls back to the default UPC from settings when none was collected', () => {
  const settings = mergeSettings({ publish: { defaultUpc: '6914973039001' } });
  const plan = buildPublishPlan({ product, edits: {}, settings, schema });
  assert.equal(plan.skuAttrValues['最小可售单位UPC'], '6914973039001');
  assert.ok(plan.warnings.some((w) => w.includes('默认 UPC') && w.includes('6914973039001')));
  assert.ok(!plan.warnings.some((w) => w.includes('未填写')));
});

test('buildPublishPlan: collected UPC, the edit field and 属性覆盖 all win over the default UPC', () => {
  const settings = mergeSettings({ publish: { defaultUpc: '6914973039001' } });
  const scraped = buildPublishPlan({ product: { ...product, upc: '6914973600058' }, edits: {}, settings, schema });
  assert.equal(scraped.skuAttrValues['最小可售单位UPC'], '6914973600058');
  assert.ok(!scraped.warnings.some((w) => w.includes('默认 UPC')));
  const edited = buildPublishPlan({ product, edits: { upc: '6901234567892' }, settings, schema });
  assert.equal(edited.skuAttrValues['最小可售单位UPC'], '6901234567892');
  const override = buildPublishPlan({ product, edits: { attrOverrides: { 最小可售单位UPC: '6914973611436' } }, settings, schema });
  assert.equal(override.skuAttrValues['最小可售单位UPC'], '6914973611436');
  assert.ok(!override.warnings.some((w) => w.includes('默认 UPC')));
});

test('buildPublishPlan warns (not blocks) when no UPC is available and the default UPC is cleared', () => {
  const plan = buildPublishPlan({ product, edits: {}, settings: mergeSettings({ publish: { defaultUpc: '' } }), schema });
  assert.ok(plan.warnings.some((w) => w.includes('最小可售单位UPC') && w.includes('重新采集') && w.includes('编辑')));
  assert.deepEqual(plan.blockers, []);
});

test('buildPublishPlan: UPC given through 属性覆盖 counts as present', () => {
  const plan = buildPublishPlan({ product, edits: { attrOverrides: { 最小可售单位UPC: '6901234567892' } }, settings: DEFAULT_SETTINGS, schema });
  assert.ok(!plan.warnings.some((w) => w.includes('UPC')));
});

test('buildPublishPlan: every SKU row carries the same UPC as the SKU属性 drawer (SKU 表“商品条形码”列)', () => {
  const scraped = buildPublishPlan({ product: { ...product, upc: '6901845046120' }, edits: {}, settings: DEFAULT_SETTINGS, schema });
  assert.ok(scraped.sale.rows.length > 0);
  assert.deepEqual(scraped.sale.rows.map((r) => r.upc), scraped.sale.rows.map(() => '6901845046120'));
  assert.equal(scraped.skuAttrValues['最小可售单位UPC'], '6901845046120');
  assert.equal(scraped.upc, '6901845046120', '基本信息的商品条形码用同一个值');
  const none = buildPublishPlan({ product, edits: {}, settings: mergeSettings({ publish: { defaultUpc: '' } }), schema });
  assert.deepEqual(none.sale.rows.map((r) => r.upc), none.sale.rows.map(() => ''));
});

test('buildPublishPlan: a placeholder UPC 0000000000000 (collected before the fix) falls back to the default UPC', () => {
  // 实例：item.jd.com/100027810038，旧版插件把 '0000000000000' 存成了 upc
  const stale = { ...product, skuId: '100027810038', upc: '0000000000000' };
  const settings = mergeSettings({ publish: { defaultUpc: '6914973039001' } });
  const plan = buildPublishPlan({ product: stale, edits: {}, settings, schema });
  assert.equal(plan.sale.rows[0].upc, '6914973039001');
  assert.equal(plan.skuAttrValues['最小可售单位UPC'], '6914973039001');
  assert.ok(plan.warnings.some((w) => w.includes('默认 UPC')));
  const cleared = buildPublishPlan({ product: stale, edits: {}, settings: mergeSettings({ publish: { defaultUpc: '' } }), schema });
  assert.equal(cleared.sale.rows[0].upc, '');
  assert.ok(cleared.warnings.some((w) => w.includes('未填写商品条形码')));
});

test('buildPublishPlan warns when several SKUs would share one UPC', () => {
  const multi = {
    ...product,
    saleDims: [{ name: '规格', values: ['a', 'b'] }],
    variants: [
      { skuId: '1', values: { 规格: 'a' } },
      { skuId: '2', values: { 规格: 'b' } },
    ],
  };
  const plan = buildPublishPlan({ product: multi, edits: { upc: '6901234567892' }, settings: DEFAULT_SETTINGS, schema });
  assert.ok(plan.sale.rows.filter((r) => r.enabled).length > 1, 'fixture should produce several enabled rows');
  assert.ok(plan.warnings.some((w) => w.includes('共用') && w.includes('UPC')));
});

test('buildPublishPlan: 源页面有建议零售价时用它，不用公式估算', () => {
  const withRetail = { ...product, price: 7.1, params: [...product.params, { name: '建议零售价', value: '9.9元/盒' }] };
  const settings = mergeSettings({ price: { multiplier: 1.05, add: 0, rounding: 'nine' } });
  const plan = buildPublishPlan({ product: withRetail, edits: {}, settings, schema });
  assert.equal(plan.sale.rows[0].price, 7.9);
  assert.equal(plan.skuAttrValues['建议零售价'], '9.9');
  assert.equal(plan.skuAttrValues['市场价'], '9.9');
});

test('buildPublishPlan: 售价高于源页面的建议零售价时改用公式，避免京麦提示售价过高', () => {
  const withRetail = { ...product, params: [...product.params, { name: '建议零售价', value: '9.9元/盒' }] };
  const plan = buildPublishPlan({ product: withRetail, edits: {}, settings: DEFAULT_SETTINGS, schema });
  assert.equal(plan.skuAttrValues['建议零售价'], '55.9');
});

test('buildPublishPlan: 设置里的包装清单优先，留空时用采集到的包装清单', () => {
  const withPack = { ...product, packList: '魔芋爽麻辣味165g+15g' };
  assert.equal(buildPublishPlan({ product: withPack, edits: {}, settings: DEFAULT_SETTINGS, schema }).packList, '魔芋爽麻辣味165g+15g');
  const settings = mergeSettings({ packList: '商品×1' });
  assert.equal(buildPublishPlan({ product: withPack, edits: {}, settings, schema }).packList, '商品×1');
});

test('buildPublishPlan: 源页面的建议零售价没有数字时用公式，属性覆盖仍然优先', () => {
  const noNumber = { ...product, params: [...product.params, { name: '建议零售价', value: '详见页面' }] };
  assert.equal(buildPublishPlan({ product: noNumber, edits: {}, settings: DEFAULT_SETTINGS, schema }).skuAttrValues['建议零售价'], '55.9');
  const withRetail = { ...product, params: [...product.params, { name: '建议零售价', value: '99' }] };
  const edits = { attrOverrides: { 建议零售价: '88' } };
  assert.equal(buildPublishPlan({ product: withRetail, edits, settings: DEFAULT_SETTINGS, schema }).skuAttrValues['建议零售价'], '88');
});
