// 真实商品页回归：2026-11-08 在浏览器里抓的 6 个不同店铺/域名的商品数据（tests/fixtures/item-pages/，
// 只留采集脚本会读的字段），用真实的采集脚本跑一遍，再归一化、生成 VC 发布前检查。
// 以后遇到采集/发布出错的新链接，就照这个格式加一个样本和一行期望。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fiber, loadItemPage, plain } from './helpers/item-page.js';
import { normalizeProduct } from '../src/shared/product-normalize.js';
import { vcSourceFields } from '../src/shared/vc-source.js';
import { vcPreflight } from '../src/shared/vc-plan.js';
import { mergeSettings } from '../src/shared/settings.js';

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/item-pages/${name}.json`, import.meta.url), 'utf8'));
const PRICES = { marketPrice: 99, jdPrice: 89, costPrice: 50 };
// 样本里没有详情区（详情图要页面在前台才加载），检查发布前缺项时补一张
const DETAIL = ['https://img30.360buyimg.com/sku/jfs/t1/1/2/3/d.jpg'];

async function collect(name) {
  const { url, biz } = fixture(name);
  const raw = await loadItemPage({ url, tree: fiber(biz) }).extractItem({ scrollDetail: false, detailWaitMs: 0 });
  return { raw: plain(raw), product: normalizeProduct(plain(raw)) };
}

const blockersOf = (product) =>
  vcPreflight({ product: { ...product, detailImages: DETAIL }, edits: { vc: PRICES }, settings: mergeSettings({}) }).blockers;

const CASES = [
  {
    name: 'self-100114866451',
    what: '自营：主数据齐全，四级类目',
    cateIds: ['15901', '15902', '15908', '31403'],
    brandId: 17519,
    model: ['V2833-D', '型号'],
    dims: [408, 310, 280, 4.33],
    upc: '6901236326411',
    blockers: [],
  },
  {
    name: 'pop-3level-10077221167161',
    what: 'POP 专营店：老商品只有三级类目（抽纸 15908 在 VC 不是末级，发布时再选子类目），型号空、有货号',
    cateIds: ['15901', '15902', '15908'],
    brandId: 17519,
    model: ['V2055/V2002', '货号'],
    dims: [225, 115, 240, 1.2],
    upc: '6901236371800',
    blockers: [],
  },
  {
    name: 'pop-nodims-30235277278',
    what: 'POP 官方旗舰店：主数据长宽高是 0',
    cateIds: ['15901', '15902', '15908', '31403'],
    brandId: 17519,
    model: ['V2182-A', '货号'],
    dims: [null, null, null, 5],
    upc: '6901236351840',
    blockers: [/^缺少包装长宽高\/毛重：长、宽、高（源商品主数据里没有/],
  },
  {
    name: 'jingxi-placeholder-10120802107169',
    what: '京喜自营官方店：长宽高 1×1×1 mm、毛重 0.01 kg 是占位值，没有条形码',
    cateIds: ['36574', '37003', '37063'],
    brandId: 35247,
    model: ['零食大礼包', '货号'],
    dims: [null, null, null, null],
    placeholders: ['长宽高 1×1×1 mm', '毛重 0.01 kg'],
    upc: '',
    blockers: [/^缺少包装长宽高\/毛重：长、宽、高、毛重（源商品主数据里是占位值/],
  },
  {
    name: 'jdhk-100094541482',
    what: '全球购：跳到 npcitem.jd.hk，条形码有两个（分号分隔）',
    cateIds: ['1316', '1381', '1391'],
    brandId: 18972,
    model: ['智妍紧塑精华面霜75ml', '型号'],
    dims: [79, 79, 77, 0.35],
    upc: '8871675395256',
    blockers: [],
  },
  {
    name: 'health-100200187696',
    what: '京东大药房：跳到 item.jingdonghealth.cn，单规格商品没有 colorSizeVO',
    cateIds: ['13314', '21909', '21919', '21953'],
    brandId: 235513,
    model: ['复方感冒灵颗粒', '型号'],
    dims: [145, 96, 44, 0.169],
    upc: '6930077801306',
    blockers: [],
  },
];

for (const c of CASES) {
  test(`真实商品页 ${c.name}：${c.what}`, async () => {
    const { raw, product } = await collect(c.name);
    assert.equal(raw.pageType, 'item');
    assert.equal(raw.source, 'react', '应从页面的商品数据里读，而不是退回 HTML');
    assert.equal(product.skuId, c.name.split('-').at(-1));
    assert.ok(product.title, '标题');
    assert.ok(product.mainImages.length > 0, '主图');
    assert.ok(product.price > 0, '价格');
    assert.ok(product.crumbs.length >= 3, '面包屑');
    assert.deepEqual(product.vc.cateIds, c.cateIds);
    assert.equal(product.vc.brandId, c.brandId);
    assert.equal(product.upc, c.upc);

    const f = vcSourceFields(product);
    assert.deepEqual([f.model, f.modelFrom], c.model);
    assert.deepEqual([f.lengthMm, f.widthMm, f.heightMm, f.weightKg], c.dims);
    assert.deepEqual(f.placeholders, c.placeholders ?? []);

    const blockers = blockersOf(product);
    assert.equal(blockers.length, c.blockers.length, blockers.join('\n'));
    c.blockers.forEach((re, i) => assert.match(blockers[i], re));
  });
}

test('真实商品页：只采集链接对应的规格；单规格商品没有规格', async () => {
  const self = (await collect('self-100114866451')).product;
  assert.deepEqual(self.variants, [{ skuId: '100114866451', values: { 规格: '【王牌囤货装】 3层 100抽*36包' } }]);
  const health = (await collect('health-100200187696')).product;
  assert.deepEqual([health.variants, health.saleDims], [[], []]);
});
