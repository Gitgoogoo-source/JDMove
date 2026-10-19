import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPublishPlan, descriptionHtml, publishImagePlan, skuAttrValueMap } from '../src/shared/publish-plan.js';
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

test('skuAttrValueMap maps price and params by label', () => {
  const map = skuAttrValueMap({ ...product, upc: '6901234567890' }, 59.9);
  assert.equal(map['建议零售价'], '59.9');
  assert.equal(map['市场价'], '59.9');
  assert.equal(map['原产地'], '中国大陆');
  assert.equal(map['最小可售单位UPC'], '6901234567890');
});
