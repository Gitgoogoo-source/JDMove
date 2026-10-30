// 京东万商（b2b.jd.com）商品页模板：用真实商品数据（2026-10）验证 goodsData → 原始数据 → 归一化
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import '../src/inject/jd-detail.js';
import '../src/inject/b2b-goods.js';
import { normalizeProduct, validateProduct } from '../src/shared/product-normalize.js';

const { b2bSkuFromPath, b2bGoodsState, b2bPriceInfo, b2bRawFromGoods, b2bMiniImages } = globalThis.__JDMOVE__;

const goods = JSON.parse(readFileSync(new URL('./fixtures/b2b-100289450311.goods.json', import.meta.url), 'utf8'));
const SKU = '100289450311';
const IMG = 'https://img14.360buyimg.com/sku/jfs/t1';

const normalize = (gd, opts) =>
  normalizeProduct({ ...b2bRawFromGoods(gd), skuId: SKU, url: `https://b2b.jd.com/goods/goods-detail/${SKU}` }, opts);

test('b2bSkuFromPath: 只认商品详情路径', () => {
  assert.equal(b2bSkuFromPath(`/goods/goods-detail/${SKU}`), SKU);
  assert.equal(b2bSkuFromPath(`/trade/goods-detail/${SKU}/`), SKU);
  assert.equal(b2bSkuFromPath('/index/search'), '');
});

test('b2bGoodsState: 数据没到 / 其他商品的旧数据时继续等', () => {
  assert.equal(b2bGoodsState(null, SKU), 'pending');
  assert.equal(b2bGoodsState({}, SKU), 'pending');
  assert.equal(b2bGoodsState({ viewCommonDTO: { skuId: '1' }, viewTitleDTO: { title: '旧商品' } }, SKU), 'pending');
});

test('b2bGoodsState: 有标题可以采集；账号无权限的商品没有标题', () => {
  assert.equal(b2bGoodsState(goods, SKU), 'ready');
  assert.equal(b2bGoodsState({ viewCommonDTO: { skuId: SKU }, viewTitleDTO: { productTag: [] } }, SKU), 'denied');
  assert.equal(b2bGoodsState({ code: -10000 }, SKU), 'denied');
});

test('b2bPriceInfo: 取页面主价格（采购价），不取建议零售价', () => {
  assert.deepEqual(b2bPriceInfo(goods), { price: '7.1', label: '万商采购价' });
});

test('b2bPriceInfo: 无购买权限时价格是 **，当作没有价格', () => {
  assert.equal(b2bPriceInfo({ viewPriceDTO: { mainPositionPrice: { value: '**' } } }).price, '');
  assert.equal(b2bPriceInfo({}).price, '');
});

test('b2bMiniImages: 切片列表转成 jfs 路径，跳过空项和无关地址', () => {
  assert.deepEqual(b2bMiniImages('/sku/jfs/t1/1/a.jpg,,/sku/jfs/t1/2/b.jpg,/other/c.gif'), ['jfs/t1/1/a.jpg', 'jfs/t1/2/b.jpg']);
  assert.deepEqual(b2bMiniImages(null), []);
});

test('真实商品：归一化出标题、品牌、类目、价格、主图、参数、条形码', () => {
  const p = normalize(goods);
  assert.equal(p.skuId, SKU);
  assert.equal(p.title, '【整盒】卫龙魔芋爽165g+15g（加量装）麻辣味休闲解馋零食素毛肚（内约14小包/盒）');
  assert.deepEqual(p.brand, { id: 177127, name: '卫龙（WEI-LONG）' });
  assert.deepEqual(p.crumbs, ['（京喜通）休闲零食', '素食肉脯', '素类小食']);
  assert.equal(p.leafCategory, '素类小食');
  assert.equal(p.price, 7.1);
  assert.equal(p.isSelf, true);
  assert.equal(p.upc, '6935284401752');
  assert.equal(p.mainImages.length, 7);
  assert.equal(p.mainImages[0], `${IMG}/457108/6/11543/39778/6a3906e7F9e2929f6/008332032012282c.jpg`);
  const param = (name) => p.params.find((x) => x.name === name)?.value;
  assert.equal(param('净含量'), '180g');
  assert.equal(param('规格'), '165g');
  assert.equal(param('保质期'), '240天');
  assert.equal(param('包装'), '盒装');
  assert.equal(param('销售单位'), '盒');
  assert.equal(param('生产日期'), '2026年08月');
  assert.equal(p.params.filter((x) => x.name === '规格').length, 1);
  assert.deepEqual(p.saleDims, []);
  assert.deepEqual(p.variants, []);
});

test('真实商品：采集包装清单', () => {
  const gd = { ...goods, viewGraphicDetailDTO: { ...goods.viewGraphicDetailDTO, wareQD: ' 魔芋爽麻辣味165g+15g ' } };
  assert.equal(normalize(gd).packList, '魔芋爽麻辣味165g+15g');
  assert.equal(normalize(goods).packList, '');
});

test('真实商品：详情图就绪后可以发布', () => {
  const raw = { ...b2bRawFromGoods(goods), skuId: SKU, detailImages: ['jfs/t1/1/a.jpg'], detailState: 'ok' };
  assert.deepEqual(validateProduct(normalizeProduct(raw), { detailState: 'ok' }), []);
});

const popGoods = {
  ...goods,
  viewCommonDTO: { skuId: '10159832951369' },
  viewTitleDTO: { title: '卫龙魔芋爽 魔芋爽(香辣味) 散装称重1包', productTag: [{ tagProperty: 'isSelf', tagText: 'false' }] },
  viewSelectedDTO: {
    colorSize: [
      {
        title: '规格',
        dimensionNumber: 1,
        buttons: [
          { text: '魔芋爽(香辣味)', skuList: ['10159832951369'] },
          { text: '魔芋爽(麻辣味)', skuList: ['10159832951370'] },
        ],
      },
      {
        title: '口味',
        dimensionNumber: 2,
        buttons: [{ text: '散装称重1包', skuList: ['10159832951369', '10159832951370'] }],
      },
    ],
  },
  viewGraphicDetailDTO: {
    specification: {
      specificationList: [
        {
          AttributeList: [
            { attributeName: '口味', attributes: 'ㅤ' },
            { attributeName: '规格', attributes: '规格' },
            { attributeName: '净含量', attributes: '散装称重' },
          ],
        },
      ],
    },
  },
};

test('多规格商品：按 skuList 汇总每个 SKU 的规格组合', () => {
  const raw = b2bRawFromGoods(popGoods);
  assert.deepEqual(raw.pageConfig.colorSize, [
    { skuId: '10159832951369', 规格: '魔芋爽(香辣味)', 口味: '散装称重1包' },
    { skuId: '10159832951370', 规格: '魔芋爽(麻辣味)', 口味: '散装称重1包' },
  ]);
  const p = normalizeProduct({ ...raw, skuId: '10159832951370' });
  assert.deepEqual(p.variants, [{ skuId: '10159832951370', values: { 规格: '魔芋爽(麻辣味)', 口味: '散装称重1包' } }]);
  assert.equal(normalizeProduct({ ...raw, skuId: '10159832951370' }, { allVariants: true }).variants.length, 2);
});

test('商家没填的占位参数不采集；非自营商品不标记自营', () => {
  const raw = b2bRawFromGoods(popGoods);
  assert.deepEqual(raw.params, [['净含量', '散装称重']]);
  assert.equal(raw.isSelf, false);
});

test('数据不完整时不抛错', () => {
  const raw = b2bRawFromGoods({ viewTitleDTO: { title: 'x' } });
  assert.equal(raw.domTitle, 'x');
  assert.deepEqual(raw.crumbs, []);
  assert.deepEqual(raw.params, []);
  assert.deepEqual(raw.pageConfig.imageList, []);
  assert.equal(raw.wareInfo.upc_code, '');
});

test('b2bGoodsState: 上一个商品的无权限结果不影响站内跳转后的新商品', () => {
  assert.equal(b2bGoodsState({ code: -10000, viewCommonDTO: { skuId: '1' } }, SKU), 'pending');
  assert.equal(b2bGoodsState({ code: -10000, viewCommonDTO: { skuId: SKU } }, SKU), 'denied');
});
