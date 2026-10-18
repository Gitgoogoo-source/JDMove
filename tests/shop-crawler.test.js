import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeChrome } from './helpers/fake-chrome.js';
import { crawlShop } from '../src/lib/shop-crawler.js';

const SEARCH_URL = 'https://mall.jd.com/view_search-646206-0-99-1-24-1.html';
const NO_DELAY = { min: 0, max: 0 };
const ids = (from, n) => Array.from({ length: n }, (_, i) => String(from + i));
const isDisarm = ({ func }) => func.name === 'disarmBeforeUnloadInPage';
const SHORT_RE = /view_search-(\d+)-(\d+)-(\d+)-(\d+)-\d+-(\d+)\.html/;
// 店内搜索页：view_search- 后至少 8 段数字，倒数第二段是页码
const LONG_RE = /view_search-(?:\d+-){7,}(\d+)-\d+\.html/;

/**
 * 模拟店铺页面。modules 是“全部商品”页上的列表模块：
 * - mode 'url'：页码由地址决定（德芙模板），“下一页”链接会丢掉排序参数（和京东一样）
 * - mode 'inline'：地址页码无效，只能点页面上的“下一页”（亿滋/卫龙模板），换模块/重新打开页面后回到第 1 页
 * - driftPages：默认排序下这些页会重复上一页最后一个商品（排序漂移），导致漏抓
 * info：页面隐藏字段里的店铺信息；fallback：店内搜索页的商品
 */
function fakeShop({ appId = '646206', modules = [], info = {}, links = [], fallback = null }) {
  const inline = new Map(); // module -> {page, sorted}
  const resetInline = () => inline.clear();
  const inlineOf = (m) => inline.get(m) ?? { page: 1, sorted: false };

  const listOf = (mod, sorted) => {
    const all = ids(mod.base ?? 100000, mod.total);
    return { all, drift: sorted ? [] : (mod.driftPages ?? []) };
  };
  function pageItems(mod, page, sorted) {
    const { all, drift } = listOf(mod, sorted);
    const per = mod.perPage ?? 24;
    const shift = drift.includes(page) ? 1 : 0;
    return all.slice((page - 1) * per - shift, page * per - shift);
  }
  function locate(url, m) {
    const long = url.match(LONG_RE);
    if (long) return { mod: fallback, page: Number(long[1]), sorted: false, count: fallback ? 1 : 0, kind: 'fallback' };
    const short = url.match(SHORT_RE);
    if (!short) return { mod: null, count: 0, kind: 'home' };
    const mod = modules[m];
    if (!mod) return { mod: null, count: modules.length, kind: 'list' };
    if (mod.mode === 'inline') return { mod, ...inlineOf(m), count: modules.length, kind: 'list' };
    return { mod, page: Number(short[5]), sorted: short[3] === '1', count: modules.length, kind: 'list' };
  }

  const handler = (call) => {
    if (isDisarm(call)) return undefined;
    const name = call.func.name;
    const arg = call.args[0] ?? {};
    const m = arg.module ?? 0;
    if (name === 'readShopInfoInTab') return { pageType: 'shop', appId: '', venderId: '', shopId: '', links, ...info };
    const at = locate(call.tab.url, m);
    const per = at.mod?.perPage ?? 24;
    const pageCount = at.mod ? Math.ceil(at.mod.total / per) : 0;
    if (name === 'nextShopPageInTab') {
      if (!at.mod || at.page >= pageCount) return { pageType: 'shop', action: 'end' };
      if (at.kind === 'fallback') {
        const url = call.tab.url.replace(/-(\d+)-(\d+)\.html/, (x, p, size) => `-${Number(p) + 1}-${size}.html`);
        return { pageType: 'shop', action: 'navigate', url };
      }
      if (at.mod.mode !== 'inline') return { pageType: 'shop', action: 'navigate', url: `//shop.jd.com/view_search-${appId}-0-0-1-24-${at.page + 1}.html` };
      inline.set(m, { ...inlineOf(m), page: at.page + 1 });
      return { pageType: 'shop', action: 'clicked', changed: true };
    }
    if (name === 'sortShopModuleInTab') {
      if (!at.mod || at.mod.mode !== 'inline') return { pageType: 'shop', action: 'none' };
      inline.set(m, { page: 1, sorted: true });
      return { pageType: 'shop', action: 'clicked', changed: true };
    }
    if (!at.mod) return { pageType: 'shop', moduleCount: at.count, skus: [], totalText: '', hasNext: false, pagerMax: null };
    return {
      pageType: 'shop',
      moduleCount: at.count,
      skus: pageItems(at.mod, at.page, at.sorted),
      totalText: `共${at.mod.total}件商品`,
      hasNext: at.page < pageCount,
      pagerMax: pageCount,
    };
  };
  return { handler, resetInline };
}

function install(shop, opts = {}) {
  const resolveUrl = (u) => {
    shop.resetInline();
    return opts.resolveUrl ? opts.resolveUrl(u) : u;
  };
  return installFakeChrome({ page: shop.handler, resolveUrl });
}

const openedUrls = (fake) => fake.calls.filter((c) => c.op === 'tabs.create' || c.op === 'tabs.update').map((c) => c.url);

test('crawlShop: “下一页”是普通链接时按地址逐页打开，排序参数前后保持一致', async () => {
  const fake = install(fakeShop({ modules: [{ total: 30, mode: 'url' }] }));
  const added = [];
  const res = await crawlShop(SEARCH_URL, { delaySec: NO_DELAY, onPage: (s) => added.push(s.added.length) });
  assert.equal(res.status, 'ok');
  assert.equal(res.state.skus.length, 30);
  assert.deepEqual(added, [24, 6]);
  assert.deepEqual(openedUrls(fake), [
    'https://mall.jd.com/view_search-646206-0-99-1-24-1.html',
    'https://mall.jd.com/view_search-646206-0-99-1-24-2.html',
  ]);
});

test('crawlShop: “下一页”是页内按钮时在当前页点击翻页（地址页码对这类模板无效）', async () => {
  const fake = install(fakeShop({ appId: '988965', modules: [{ total: 74, perPage: 20, mode: 'inline' }] }));
  const progress = [];
  const res = await crawlShop('https://mall.jd.com/view_search-988965-0-99-1-24-1.html', {
    delaySec: NO_DELAY,
    onPage: (s) => progress.push([s.added.length, s.pageCount, s.total]),
  });
  assert.equal(res.status, 'ok');
  assert.equal(res.state.skus.length, 74);
  assert.deepEqual(progress, [
    [20, 4, 74],
    [20, 4, 74],
    [20, 4, 74],
    [14, 4, 74],
  ]);
  assert.deepEqual(openedUrls(fake), ['https://mall.jd.com/view_search-988965-0-99-1-24-1.html']);
});

test('crawlShop: 页面上有多个列表模块时逐个抓取并合并（卫龙模板）', async () => {
  const modules = [
    { total: 15, perPage: 20, mode: 'inline', base: 100000 },
    { total: 100, perPage: 20, mode: 'inline', base: 200000 },
  ];
  const fake = install(fakeShop({ appId: '1015542', modules }));
  const res = await crawlShop('https://mall.jd.com/view_search-1015542-0-0-1-24-1.html', { delaySec: NO_DELAY });
  assert.equal(res.status, 'ok');
  assert.equal(res.state.skus.length, 115);
  // 第二个模块从第 1 页重新开始
  assert.equal(openedUrls(fake).length, 2);
});

test('crawlShop: 多个模块里重复的商品只算一次', async () => {
  const modules = [
    { total: 10, perPage: 20, mode: 'inline', base: 100000 },
    { total: 30, perPage: 20, mode: 'inline', base: 100000 },
  ];
  install(fakeShop({ modules }));
  const res = await crawlShop(SEARCH_URL, { delaySec: NO_DELAY });
  assert.equal(res.state.skus.length, 30);
});

test('crawlShop: 默认排序翻页漂移导致数量不足时，换“上架时间”排序补抓（地址翻页）', async () => {
  const fake = install(fakeShop({ modules: [{ total: 50, mode: 'url', driftPages: [2] }] }));
  const res = await crawlShop(SEARCH_URL, { delaySec: NO_DELAY });
  assert.equal(res.status, 'ok');
  assert.equal(res.state.skus.length, 50);
  assert.ok(openedUrls(fake).includes('https://mall.jd.com/view_search-646206-0-1-1-24-1.html'), '应按上架时间排序重新打开第 1 页');
});

test('crawlShop: 页内翻页的模块漂移时，点击排序按钮补抓', async () => {
  install(fakeShop({ modules: [{ total: 50, perPage: 20, mode: 'inline', driftPages: [2] }] }));
  const res = await crawlShop(SEARCH_URL, { delaySec: NO_DELAY });
  assert.equal(res.state.skus.length, 50);
});

test('crawlShop: 补抓后仍不足时如实提示数量', async () => {
  // 漂移在所有排序下都存在（模拟京东总数虚高）
  const shop = fakeShop({ modules: [{ total: 30, mode: 'url' }] });
  const handler = (call) => {
    const res = shop.handler(call);
    return call.func.name === 'extractShopPageInTab' && res?.totalText ? { ...res, totalText: '共32件商品' } : res;
  };
  installFakeChrome({ page: handler, resolveUrl: (u) => (shop.resetInline(), u) });
  const res = await crawlShop(SEARCH_URL, { delaySec: NO_DELAY });
  assert.equal(res.status, 'ok');
  assert.equal(res.state.skus.length, 30);
  assert.match(res.message, /32/);
  assert.match(res.message, /30/);
});

test('crawlShop: 店铺首页从隐藏字段读取 appId（首页上没有“全部商品”链接）', async () => {
  const shop = fakeShop({ appId: '2202611', info: { appId: '2202611', venderId: '1000396246', shopId: '1000396246' }, modules: [{ total: 5 }] });
  const fake = install(shop);
  const res = await crawlShop('https://mall.jd.com/index-1000396246.html', { delaySec: NO_DELAY });
  assert.equal(res.status, 'ok');
  assert.equal(res.state.skus.length, 5);
  assert.deepEqual(openedUrls(fake), ['https://mall.jd.com/index-1000396246.html', 'https://mall.jd.com/view_search-2202611-0-0-1-24-1.html']);
});

test('crawlShop: 隐藏字段没有 appId 时从首页链接里找', async () => {
  const links = ['https://mall.jd.com/view_search-646206-5634328-99-1-24-1.html', 'https://mall.jd.com/view_search-646206-0-99-1-24-1.html'];
  const fake = install(fakeShop({ links, modules: [{ total: 5 }] }));
  const res = await crawlShop('https://mall.jd.com/index-1000078502.html', { delaySec: NO_DELAY });
  assert.equal(res.state.skus.length, 5);
  assert.equal(openedUrls(fake)[1], 'https://mall.jd.com/view_search-646206-0-0-1-24-1.html');
});

test('crawlShop: 店内搜索结果页链接同样先读取店铺信息再抓“全部商品”', async () => {
  const shop = fakeShop({ appId: '630935', info: { appId: '630935', venderId: '1000074722', shopId: '1000074722' }, modules: [{ total: 8 }] });
  const fake = install(shop);
  const res = await crawlShop('https://mall.jd.com/view_search-630935-1000074722-1000074722-0-1-0-0-1-1-24.html?keyword=', { delaySec: NO_DELAY });
  assert.equal(res.state.skus.length, 8);
  assert.equal(openedUrls(fake)[1], 'https://mall.jd.com/view_search-630935-0-0-1-24-1.html');
});

test('crawlShop: 找不到 appId 时报错，提示改用“全部商品”页链接', async () => {
  install(fakeShop({ modules: [{ total: 5 }] }));
  const res = await crawlShop('https://mall.jd.com/index-1000078502.html', { delaySec: NO_DELAY });
  assert.equal(res.status, 'error');
  assert.match(res.message, /全部商品/);
});

test('crawlShop: “全部商品”页没有列表模块时改用店内搜索兜底，并提示可能不完整（黄老五模板）', async () => {
  const shop = fakeShop({
    appId: '630935',
    info: { appId: '630935', venderId: '1000074722', shopId: '1000074722' },
    modules: [],
    fallback: { total: 13, perPage: 60, base: 300000 },
  });
  const fake = install(shop);
  const res = await crawlShop('https://mall.jd.com/view_search-630935-0-0-1-24-1.html', { delaySec: NO_DELAY });
  assert.equal(res.status, 'ok');
  assert.equal(res.state.skus.length, 13);
  assert.equal(res.partial, true);
  assert.match(res.message, /店内搜索/);
  assert.ok(openedUrls(fake).includes('https://mall.jd.com/view_search-630935-1000074722-1000074722-0-1-0-0-1-1-60.html?keyword=&isGlobalSearch=0'));
});

test('crawlShop: 店内搜索兜底按分页栏链接翻页', async () => {
  const shop = fakeShop({
    appId: '630935',
    info: { appId: '630935', venderId: '1', shopId: '2' },
    fallback: { total: 70, perPage: 60, base: 300000 },
  });
  const fake = install(shop);
  const res = await crawlShop('https://mall.jd.com/view_search-630935-0-0-1-24-1.html', { delaySec: NO_DELAY });
  assert.equal(res.state.skus.length, 70);
  assert.ok(openedUrls(fake).includes('https://mall.jd.com/view_search-630935-1-2-0-1-0-0-1-2-60.html?keyword=&isGlobalSearch=0'));
});

test('crawlShop: 不是店铺链接时直接报错，不打开页面', async () => {
  const fake = installFakeChrome();
  const res = await crawlShop('https://item.jd.com/100035179134.html');
  assert.equal(res.status, 'error');
  assert.match(res.message, /店铺链接/);
  assert.deepEqual(openedUrls(fake), []);
});

test('crawlShop: 翻页途中触发频控时暂停，保留已抓到的 SKU', async () => {
  const resolveUrl = (u) => (/-24-2\.html$/.test(u) ? 'https://cfe.m.jd.com/privatedomain/risk_handler/03101900/' : u);
  install(fakeShop({ modules: [{ total: 60 }] }), { resolveUrl });
  const res = await crawlShop(SEARCH_URL, { delaySec: NO_DELAY });
  assert.equal(res.status, 'throttle');
  assert.equal(res.state.skus.length, 24);
});

test('crawlShop: 商家账号被拦截时提示改用消费者账号', async () => {
  install(fakeShop({ modules: [{ total: 10 }] }), { resolveUrl: () => 'https://bizsafe-intercept.jd.com/x' });
  const res = await crawlShop(SEARCH_URL, { delaySec: NO_DELAY });
  assert.equal(res.status, 'login');
  assert.match(res.message, /消费者/);
});

test('crawlShop: 页面脚本报告频控页时同样暂停', async () => {
  installFakeChrome({ page: (call) => (isDisarm(call) ? undefined : { pageType: 'throttle', moduleCount: 0, skus: [], totalText: '', hasNext: false }) });
  const res = await crawlShop(SEARCH_URL, { delaySec: NO_DELAY });
  assert.equal(res.status, 'throttle');
});

test('crawlShop: 商品列表一直“加载中”（京东接口限流）时按频控暂停，不改走店内搜索', async () => {
  const fake = installFakeChrome({
    page: (call) => (isDisarm(call) ? undefined : { pageType: 'loading_failed', moduleCount: 0, skus: [], totalText: '', hasNext: false }),
  });
  const res = await crawlShop(SEARCH_URL, { delaySec: NO_DELAY });
  assert.equal(res.status, 'throttle');
  assert.match(res.message, /加载/);
  assert.ok(!openedUrls(fake).some((u) => /isGlobalSearch/.test(u)), '不应打开店内搜索兜底');
});

test('crawlShop: 后面的列表模块加载失败时暂停，前面模块已抓到的商品保留', async () => {
  const shop = fakeShop({ modules: [{ total: 10, mode: 'inline' }, { total: 10, mode: 'inline', base: 200000 }] });
  const handler = (call) =>
    call.func.name === 'extractShopPageInTab' && call.args[0]?.module === 1
      ? { pageType: 'loading_failed', moduleCount: 1, skus: [], totalText: '', hasNext: false }
      : shop.handler(call);
  installFakeChrome({ page: handler, resolveUrl: (u) => (shop.resetInline(), u) });
  const res = await crawlShop(SEARCH_URL, { delaySec: NO_DELAY });
  assert.equal(res.status, 'throttle');
  assert.equal(res.state.skus.length, 10);
});

test('crawlShop: 翻页时页面已没有下一页，正常结束', async () => {
  const shop = fakeShop({ modules: [{ total: 10 }] });
  const handler = (call) => (call.func.name === 'extractShopPageInTab' ? { ...shop.handler(call), hasNext: true } : shop.handler(call));
  installFakeChrome({ page: handler });
  const res = await crawlShop(SEARCH_URL, { delaySec: NO_DELAY });
  assert.equal(res.status, 'ok');
  assert.equal(res.state.skus.length, 10);
});

test('crawlShop: 请求停止后不再翻页', async () => {
  install(fakeShop({ modules: [{ total: 100 }] }));
  let stop = false;
  const res = await crawlShop(SEARCH_URL, {
    delaySec: NO_DELAY,
    shouldStop: () => stop,
    onPage: () => {
      stop = true;
    },
  });
  assert.equal(res.status, 'stopped');
  assert.equal(res.state.skus.length, 24);
});
