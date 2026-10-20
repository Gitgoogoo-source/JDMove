import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeProduct, validateProduct } from '../src/shared/product-normalize.js';

const legacyRaw = {
  url: 'https://item.jd.com/100001.html',
  skuId: '100001',
  pageConfig: {
    skuid: 100001,
    name: '德芙 丝滑牛奶巧克力 252g',
    imageList: ['jfs/t1/1/a.jpg', 'jfs/t1/1/b.jpg', 'jfs/t1/1/a.jpg'],
    brand: 5962,
    colorSize: [
      { skuId: 100001, 口味: '牛奶', 规格: '252g' },
      { skuId: 100002, 口味: '黑巧', 规格: '252g' },
      { skuId: 100003, 口味: '牛奶', 规格: '504g' },
    ],
  },
  domTitle: '  德芙（Dove）丝滑牛奶巧克力 252g碗装  ',
  docTitle: '【德芙】德芙巧克力【行情 报价 价格 评测】-京东',
  crumbs: ['食品饮料', '休闲食品', '巧克力', '德芙（Dove）'],
  brandText: '德芙（Dove）',
  params: [
    ['商品名称', '德芙丝滑牛奶巧克力'],
    ['商品编号', '100001'],
    ['原产地', '中国大陆'],
    ['净含量', '252g'],
    ['原产地', '重复的会被忽略'],
    ['', '空名称忽略'],
  ],
  mainImages: ['//img14.360buyimg.com/n5/jfs/t1/1/zzz.jpg'],
  priceText: '￥59.90',
  saleDims: [],
  detailImages: [
    '//img30.360buyimg.com/sku/jfs/t1/2/d1.jpg',
    'https://misc.360buyimg.com/lib/img/e/blank.gif',
    'data:image/png;base64,xxx',
    '//img30.360buyimg.com/sku/jfs/t1/2/d1.jpg',
    '//img30.360buyimg.com/sku/jfs/t1/2/d2.jpg!q70.dpg.webp',
  ],
  isSelf: true,
};

test('normalizeProduct prefers pageConfig images and dedupes', () => {
  const p = normalizeProduct(legacyRaw);
  assert.deepEqual(p.mainImages, [
    'https://img14.360buyimg.com/sku/jfs/t1/1/a.jpg',
    'https://img14.360buyimg.com/sku/jfs/t1/1/b.jpg',
  ]);
});

test('normalizeProduct cleans title, brand, price and crumbs', () => {
  const p = normalizeProduct(legacyRaw);
  assert.equal(p.title, '德芙（Dove）丝滑牛奶巧克力 252g碗装');
  assert.deepEqual(p.brand, { id: 5962, name: '德芙（Dove）' });
  assert.equal(p.price, 59.9);
  assert.deepEqual(p.crumbs, ['食品饮料', '休闲食品', '巧克力', '德芙（Dove）']);
  assert.equal(p.leafCategory, '巧克力');
});

test('normalizeProduct keeps first param value and drops noise', () => {
  const p = normalizeProduct(legacyRaw);
  assert.deepEqual(p.params, [
    { name: '商品名称', value: '德芙丝滑牛奶巧克力' },
    { name: '原产地', value: '中国大陆' },
    { name: '净含量', value: '252g' },
  ]);
});

test('normalizeProduct builds sale dims and variants from colorSize', () => {
  const p = normalizeProduct(legacyRaw, { allVariants: true });
  assert.deepEqual(p.saleDims, [
    { name: '口味', values: ['牛奶', '黑巧'] },
    { name: '规格', values: ['252g', '504g'] },
  ]);
  assert.equal(p.variants.length, 3);
  assert.deepEqual(p.variants[1], { skuId: '100002', values: { 口味: '黑巧', 规格: '252g' } });
});

test('normalizeProduct keeps only the current SKU variant unless allVariants', () => {
  const single = normalizeProduct(legacyRaw, { allVariants: false });
  assert.deepEqual(single.variants, [{ skuId: '100001', values: { 口味: '牛奶', 规格: '252g' } }]);
  assert.deepEqual(single.saleDims, [
    { name: '口味', values: ['牛奶'] },
    { name: '规格', values: ['252g'] },
  ]);
  const unknown = normalizeProduct({ ...legacyRaw, skuId: '999999', pageConfig: { ...legacyRaw.pageConfig, skuid: 999999 } }, { allVariants: false });
  assert.deepEqual(unknown.variants, []);
  assert.deepEqual(unknown.saleDims, []);
});

test('normalizeProduct filters placeholder detail images', () => {
  const p = normalizeProduct(legacyRaw);
  assert.deepEqual(p.detailImages, [
    'https://img30.360buyimg.com/sku/jfs/t1/2/d1.jpg',
    'https://img30.360buyimg.com/sku/jfs/t1/2/d2.jpg',
  ]);
});

test('normalizeProduct falls back to DOM data when pageConfig missing', () => {
  const p = normalizeProduct({
    url: 'https://item.jd.com/9.html',
    skuId: '9',
    pageConfig: null,
    domTitle: '',
    docTitle: '【奥利奥】奥利奥饼干 原味 349g【行情 报价 价格 评测】-京东',
    crumbs: [],
    brandText: '',
    params: [['品牌', '奥利奥（Oreo）']],
    mainImages: ['//img14.360buyimg.com/n5/s54x54_jfs/t1/9/x.jpg'],
    priceText: '',
    saleDims: [{ name: '口味', values: [{ text: '原味', skuId: '9', selected: true }, { text: '巧克力味', skuId: '10' }] }],
    detailImages: [],
  }, { allVariants: true });
  assert.equal(p.title, '奥利奥饼干 原味 349g');
  assert.deepEqual(p.brand, { id: null, name: '奥利奥（Oreo）' });
  assert.deepEqual(p.mainImages, ['https://img14.360buyimg.com/sku/jfs/t1/9/x.jpg']);
  assert.equal(p.price, null);
  assert.deepEqual(p.saleDims, [{ name: '口味', values: ['原味', '巧克力味'] }]);
  assert.deepEqual(p.variants, [
    { skuId: '9', values: { 口味: '原味' } },
    { skuId: '10', values: { 口味: '巧克力味' } },
  ]);
});

test('normalizeProduct handles missing everything gracefully', () => {
  const p = normalizeProduct({});
  assert.equal(p.title, '');
  assert.deepEqual(p.mainImages, []);
  assert.deepEqual(p.saleDims, []);
  assert.equal(p.leafCategory, '');
});

test('validateProduct reports missing essentials', () => {
  assert.deepEqual(validateProduct(normalizeProduct(legacyRaw)), []);
  const errs = validateProduct(normalizeProduct({}));
  assert.ok(errs.includes('缺少标题'));
  assert.ok(errs.includes('缺少主图'));
  assert.ok(errs.includes('缺少价格'));
});

test('validateProduct: 没有采到详情图时提示（发布时会被拦下）', () => {
  assert.ok(!validateProduct(normalizeProduct(legacyRaw)).some((e) => e.includes('详情图')));
  const errs = validateProduct(normalizeProduct({ ...legacyRaw, detailImages: [] }));
  assert.ok(errs.some((e) => e.includes('缺少详情图')));
});

test('源页面参数里没有保质期时，取 wareInfoReadMap.shelf_life（天）', () => {
  const p = normalizeProduct({ ...legacyRaw, wareInfo: { shelf_life: '364', IsYouShelfLife: '1' } });
  assert.deepEqual(p.params.find((x) => x.name === '保质期'), { name: '保质期', value: '364天' });
});

test('参数里已有保质期时以参数为准；shelf_life 为 0 或缺失时不补', () => {
  const withParam = normalizeProduct({
    ...legacyRaw,
    params: [...legacyRaw.params, ['保质期', '12个月']],
    wareInfo: { shelf_life: '364' },
  });
  assert.equal(withParam.params.find((x) => x.name === '保质期').value, '12个月');
  for (const wareInfo of [{ shelf_life: '0' }, { shelf_life: '' }, {}, undefined]) {
    const p = normalizeProduct({ ...legacyRaw, wareInfo });
    assert.equal(p.params.find((x) => x.name === '保质期'), undefined);
  }
});

test('取 wareInfoReadMap.upc_code 作为商品条形码', () => {
  const p = normalizeProduct({ ...legacyRaw, wareInfo: { shelf_life: '364', upc_code: '6914973609563' } });
  assert.equal(p.upc, '6914973609563');
});

test('upc_code 缺失或不是 8~14 位数字时 upc 为空', () => {
  for (const wareInfo of [{ upc_code: '' }, { upc_code: '无' }, { upc_code: '123' }, {}, undefined]) {
    assert.equal(normalizeProduct({ ...legacyRaw, wareInfo }).upc, '', JSON.stringify(wareInfo));
  }
});

test('京东没有条形码时 upc_code 填的是 SKU 编号本身：不当作条形码', () => {
  // 实例：item.jd.com/100229520979 的 wareInfoReadMap.upc_code === '100229520979'
  const raw = { ...legacyRaw, skuId: '100229520979', pageConfig: { ...legacyRaw.pageConfig, skuid: 100229520979, colorSize: [] } };
  assert.equal(normalizeProduct({ ...raw, wareInfo: { upc_code: '100229520979' } }).upc, '');
  // 同款其它规格的 SKU 编号也不是条形码
  assert.equal(normalizeProduct({ ...legacyRaw, wareInfo: { upc_code: '100002' } }, { allVariants: true }).upc, '');
  assert.equal(normalizeProduct({ ...legacyRaw, wareInfo: { upc_code: '10000200' } }).upc, '10000200');
});

test('upc_code 为“SKU编号;条形码”多值格式时取出条形码', () => {
  const raw = { ...legacyRaw, skuId: '100050587042', pageConfig: { ...legacyRaw.pageConfig, skuid: 100050587042, colorSize: [] } };
  assert.equal(normalizeProduct({ ...raw, wareInfo: { upc_code: '100050587042;6914973600058' } }).upc, '6914973600058');
});
