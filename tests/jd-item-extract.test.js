// 商品页采集脚本（src/inject/jd-item-extract.js）在 Node 里用假的页面跑：
// 京东新版商品页是 React，商品数据挂在组件状态里（useRef 的 current），脚本遍历 fiber 树找它
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ITEM_HOSTS } from '../src/shared/url-utils.js';
import { fiber, loadItemPage as loadPage } from './helpers/item-page.js';

const loadItemPage = ({ hostname = 'item.jd.com', tree = null } = {}) => loadPage({ url: `https://${hostname}/100200187696.html`, tree });

// 2026-11 京东大药房 100200187696（跳到 item.jingdonghealth.cn）的商品数据节选：单规格商品，没有 colorSizeVO
const HEALTH_BIZ = {
  skuHeadVO: { skuTitle: '宝瑞坦 复方感冒灵颗粒14g/袋*10袋/盒' },
  crumbInfoVO: { crumbs: [{ text: '医药' }, { text: '非处方药' }, { text: '感冒用药' }, { text: '风热感冒' }, { text: '寳瑞坦' }] },
  productAttributeVO: {
    attributes: [
      { labelName: '品牌', labelValue: '寳瑞坦' },
      { labelName: '商品编号', labelValue: '100200187696' },
      { labelName: '产品规格', labelValue: '14g/袋*10袋/盒' },
    ],
  },
  price: { id: '100200187696', m: '23.00', op: '22.50', p: '22.50' },
  itemShopInfo: { shopName: '京东大药房' },
  mainImageVO: { mainImageArea: { imageUrl: '//img14.360buyimg.com/n1/jfs/t1/1/2/3/a.jpg' }, carouselArea: [] },
  pageConfigVO: { brand: 235513 },
  wareInfoReadMap: {
    category_id1: '13314',
    category_id2: '21909',
    category_id: '21919',
    category_id4: '21953',
    brand_id: '235513',
    cn_brand: '寳瑞坦',
    model: '复方感冒灵颗粒',
    item_num: '',
    weight: '0.169',
    length: '145',
    width: '96',
    height: '44',
    upc_code: '6930077801306',
    vender_name: '京东大药房',
  },
};
// 同一棵树上还有只带标题的半成品状态（页面先渲染标题，商品数据后到）
const PARTIAL = { skuHeadVO: { skuTitle: '宝瑞坦 复方感冒灵颗粒14g/袋*10袋/盒' }, ext: {}, abData: {} };
const healthTree = () => fiber(PARTIAL, { child: fiber({ skuHeadVO: PARTIAL.skuHeadVO, pageConfigVO: {} }, { sibling: fiber(HEALTH_BIZ) }) });

test('采集脚本认得所有商品页域名（与 url-utils 的 ITEM_HOSTS 一致）', async () => {
  for (const hostname of ITEM_HOSTS) {
    const NS = loadItemPage({ hostname, tree: healthTree() });
    assert.equal((await NS.extractPrice()).pageType, 'item', hostname);
  }
  assert.equal((await loadItemPage({ hostname: 'www.jd.hk' }).extractPrice()).pageType, 'unknown');
});

test('没有 colorSizeVO 的单规格商品（京东健康）也能读到商品数据，跳过只有标题的半成品状态', async () => {
  const NS = loadItemPage({ hostname: 'item.jingdonghealth.cn', tree: healthTree() });
  const price = await NS.extractPrice();
  assert.equal(price.priceText, '22.50');
  assert.equal(price.skuId, '100200187696');

  const raw = await NS.extractItem({ scrollDetail: false, detailWaitMs: 0 });
  assert.equal(raw.source, 'react');
  assert.equal(raw.domTitle, '宝瑞坦 复方感冒灵颗粒14g/袋*10袋/盒');
  assert.deepEqual(Array.from(raw.crumbs), ['医药', '非处方药', '感冒用药', '风热感冒', '寳瑞坦']);
  assert.equal(raw.wareInfo.category_id4, '21953');
  assert.equal(raw.wareInfo.model, '复方感冒灵颗粒');
  assert.deepEqual(Array.from(raw.pageConfig.colorSize), []);
  assert.equal(raw.detailState, 'not_loaded');

  const ids = await NS.extractSkuIds({ timeoutMs: 0 });
  assert.deepEqual(Array.from(ids.skuIds), ['100200187696']);
});

test('商品主数据带上货号（POP 商品的型号常是空的，货号有值），并保留完整主数据备查', async () => {
  const biz = { ...HEALTH_BIZ, wareInfoReadMap: { ...HEALTH_BIZ.wareInfoReadMap, model: '', item_num: 'V2182-A' } };
  const raw = await loadItemPage({ tree: fiber(biz) }).extractItem({ scrollDetail: false, detailWaitMs: 0 });
  assert.equal(raw.wareInfo.item_num, 'V2182-A');
  assert.equal(raw.wareInfoAll.vender_name, '京东大药房');
  assert.equal(raw.wareInfoAll.category_id4, '21953');
});

test('同时有没带主数据的商品数据和带 wareInfoReadMap 的商品数据时，用带主数据的那份', async () => {
  const { wareInfoReadMap, ...noReadMap } = HEALTH_BIZ;
  const rendered = { ...noReadMap, pageConfigVO: { brand: '1', cat: [1, 2, 3] } };
  const NS = loadItemPage({ hostname: 'item.jingdonghealth.cn', tree: fiber(rendered, { child: fiber(HEALTH_BIZ) }) });
  const raw = await NS.extractItem({ scrollDetail: false, detailWaitMs: 0 });
  assert.equal(raw.wareInfo.category_id4, wareInfoReadMap.category_id4);
  assert.equal(raw.wareInfo.brand_id, '235513');
  assert.equal(raw.offShelf, '');
});

test('在售商品的主数据晚到（先渲染出没有 wareInfoReadMap 的商品数据）时等主数据，不提前用残缺的数据', async () => {
  const { wareInfoReadMap, ...noReadMap } = HEALTH_BIZ;
  const tree = fiber({ ...noReadMap, pageConfigVO: { brand: '235513', cat: [13314, 21909, 21919] } });
  setTimeout(() => {
    tree.child = fiber(HEALTH_BIZ);
  }, 2000);
  const NS = loadItemPage({ hostname: 'item.jingdonghealth.cn', tree });
  const raw = await NS.extractItem({ scrollDetail: false, detailWaitMs: 0 });
  assert.equal(raw.wareInfo.category_id4, wareInfoReadMap.category_id4);
  assert.equal(raw.wareInfo.upc_code, wareInfoReadMap.upc_code);
  assert.ok(raw.wareInfoAll, '完整主数据写进原始数据.json');
});
