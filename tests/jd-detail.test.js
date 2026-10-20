// 商品详情区加载状态的判断（2026-10 京东新版商品页）：
// “商品详情”楼层先渲染占位骨架 .imgtext-ske，骨架进入视口后才请求 pc_item_getWareGraphic 并渲染 #detail-main；
// 窗口被遮挡/最小化时 Chrome 不渲染页面，骨架会一直留着。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../src/inject/jd-detail.js';

const { classifyDetail, DETAIL_STATE } = globalThis.__JDMOVE__;

const state = (o) => classifyDetail({ imageCount: 0, hasSection: true, skeleton: false, sectionText: '商品详情', ...o });

test('取到详情图即为 ok', () => {
  assert.equal(state({ imageCount: 11 }), DETAIL_STATE.ok);
  assert.equal(state({ imageCount: 3, hasSection: false }), DETAIL_STATE.ok);
});

test('骨架还在：详情区还没加载，继续等待', () => {
  assert.equal(state({ skeleton: true }), DETAIL_STATE.pending);
});

test('页面写着“本商品暂无商品介绍”：源商品本来就没有详情', () => {
  assert.equal(state({ sectionText: '商品详情 本商品暂无商品介绍' }), DETAIL_STATE.empty);
});

test('详情接口失败（“网络出小差了”）：算作没有加载出来', () => {
  assert.equal(state({ sectionText: '商品详情 网络出小差了，请刷新重试。' }), DETAIL_STATE.notLoaded);
});

test('详情区已渲染完但没有图片：源商品没有详情图', () => {
  assert.equal(state({ skeleton: false }), DETAIL_STATE.empty);
});

test('还没有“商品详情”楼层（页面未渲染完或旧版页面）：继续等待', () => {
  assert.equal(state({ hasSection: false, sectionText: '' }), DETAIL_STATE.pending);
});

// 外部样式表（sku 100239690697）：#detail-main 只有空的 ssd-module 方块和
// <div cssurl="//sku-market-gw.jd.com/css/pc/1178879.css?t=…">，背景图都写在这个样式表里
const { cssBackgrounds, externalCssUrls } = globalThis.__JDMOVE__;

test('有 ssd-module 方块却没解析出图片：解析失败，不是源商品没有详情', () => {
  assert.equal(state({ moduleCount: 7 }), DETAIL_STATE.parseFailed);
  // 没有方块也没有图片才算没有详情
  assert.equal(state({ moduleCount: 0 }), DETAIL_STATE.empty);
  // 骨架还在时继续等待
  assert.equal(state({ moduleCount: 7, skeleton: true }), DETAIL_STATE.pending);
  // 旧版页面没有“商品详情”楼层，但详情区已有方块：同样是解析失败
  assert.equal(state({ moduleCount: 7, hasSection: false, sectionText: '' }), DETAIL_STATE.parseFailed);
});

test('cssBackgrounds: 从外部样式表取出方块 class 对应的背景图', async () => {
  const { readFileSync } = await import('node:fs');
  const css = readFileSync(new URL('./fixtures/detail-1178879.css', import.meta.url), 'utf8');
  const bg = cssBackgrounds(css);
  // 页面上 #detail-main 里的 7 个方块，按 DOM 顺序
  const modules = ['M17526328251908', 'M17526328118802', 'M17526328123773', 'M17526328129304', 'M17526328133255', 'M17526328139406', 'M17526328151217'];
  const urls = modules.map((c) => bg[c]);
  assert.equal(urls.length, 7);
  assert.ok(urls.every((u) => /^\/\/img30\.360buyimg\.com\/sku\/jfs\/.+\.jpg$/.test(u)));
  assert.equal(urls[0], '//img30.360buyimg.com/sku/jfs/t1/301819/26/22848/56049/68770de8F89185604/82c77a60f259467a.jpg');
  assert.equal(urls[6], '//img30.360buyimg.com/sku/jfs/t1/323753/18/835/56885/68905d08F070b4a32/1f76944781f021aa.jpg');
  // 样式表里还有一条页面上没有对应方块的规则（不会被采到，因为按页面方块取）
  assert.ok(bg.M17817791288811);
  // 公共样式（.ssd-module-wrap 等）没有背景图，不会混进来
  assert.equal(bg['ssd-module'], undefined);
});

test('cssBackgrounds: 同一个 class 只取第一条规则；没有背景图的规则忽略', () => {
  const bg = cssBackgrounds('.w .A{background-image:url("//a/1.jpg")} .A{background:#fff url(//a/2.jpg) no-repeat} .B{height:10px}');
  assert.deepEqual(bg, { A: '//a/1.jpg' });
});

test('externalCssUrls: 补全协议、去重，只保留京东域名下的样式表', () => {
  assert.deepEqual(
    externalCssUrls([
      '//sku-market-gw.jd.com/css/pc/1178879.css?t=1765865259963',
      'https://sku-market-gw.jd.com/css/pc/1178879.css?t=1765865259963',
      ' https://img10.360buyimg.com/x.css ',
      'https://evil.example.com/x.css',
      'javascript:alert(1)',
      '',
      null,
    ]),
    ['https://sku-market-gw.jd.com/css/pc/1178879.css?t=1765865259963', 'https://img10.360buyimg.com/x.css'],
  );
});
