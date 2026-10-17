import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeChrome } from './helpers/fake-chrome.js';
import { crawlShop } from '../src/lib/shop-crawler.js';

const SEARCH_URL = 'https://mall.jd.com/view_search-646206-0-99-1-24-1.html';
const NO_DELAY = { min: 0, max: 0 };
const ids = (from, n) => Array.from({ length: n }, (_, i) => String(from + i));
const pageNoOf = (url) => Number((url.match(/-(\d+)\.html$/) || [])[1]);
const isDisarm = ({ func }) => func.name === 'disarmBeforeUnloadInPage';

/** 模拟一个共 total 件商品的店铺：第 n 页返回对应的 24 个 SKU */
function shopPages(total, { links = [] } = {}) {
  return (call) => {
    if (isDisarm(call)) return undefined;
    const url = call.tab.url;
    if (!url.includes('view_search-')) return { pageType: 'shop', links };
    const start = (pageNoOf(url) - 1) * 24;
    const n = Math.max(0, Math.min(24, total - start));
    return { pageType: 'shop', skus: ids(100000 + start, n), totalText: `共${total}条记录 上一页 1 2 下一页` };
  };
}

const openedUrls = (fake) => fake.calls.filter((c) => c.op === 'tabs.create' || c.op === 'tabs.update').map((c) => c.url);

test('crawlShop: 逐页打开直到最后一页，合并所有 SKU', async () => {
  const fake = installFakeChrome({ page: shopPages(30) });
  const pages = [];
  const res = await crawlShop(SEARCH_URL, { delaySec: NO_DELAY, onPage: (s) => pages.push(s.added.length) });
  assert.equal(res.status, 'ok');
  assert.equal(res.state.skus.length, 30);
  assert.equal(res.state.reason, 'last');
  assert.deepEqual(pages, [24, 6]);
  assert.deepEqual(openedUrls(fake), [
    'https://mall.jd.com/view_search-646206-0-99-1-24-1.html',
    'https://mall.jd.com/view_search-646206-0-99-1-24-2.html',
  ]);
});

test('crawlShop: 店铺首页链接先从首页找 appId，再抓“全部商品”', async () => {
  const links = ['https://mall.jd.com/view_search-646206-5634328-99-1-24-1.html', 'https://mall.jd.com/view_search-646206-0-99-1-24-1.html'];
  const fake = installFakeChrome({ page: shopPages(5, { links }) });
  const res = await crawlShop('https://mall.jd.com/index-1000078502.html', { delaySec: NO_DELAY });
  assert.equal(res.status, 'ok');
  assert.equal(res.state.skus.length, 5);
  assert.deepEqual(openedUrls(fake), ['https://mall.jd.com/index-1000078502.html', 'https://mall.jd.com/view_search-646206-0-0-1-24-1.html']);
});

test('crawlShop: 首页找不到 appId 时报错，提示改用“全部商品”页链接', async () => {
  installFakeChrome({ page: shopPages(5) });
  const res = await crawlShop('https://mall.jd.com/index-1000078502.html', { delaySec: NO_DELAY });
  assert.equal(res.status, 'error');
  assert.match(res.message, /全部商品/);
});

test('crawlShop: 不是店铺链接时直接报错，不打开页面', async () => {
  const fake = installFakeChrome();
  const res = await crawlShop('https://item.jd.com/100035179134.html');
  assert.equal(res.status, 'error');
  assert.match(res.message, /店铺链接/);
  assert.deepEqual(openedUrls(fake), []);
});

test('crawlShop: 翻页途中触发频控时暂停，保留已抓到的 SKU', async () => {
  const resolveUrl = (u) => (pageNoOf(u) === 2 ? 'https://cfe.m.jd.com/privatedomain/risk_handler/03101900/' : u);
  installFakeChrome({ resolveUrl, page: shopPages(60) });
  const res = await crawlShop(SEARCH_URL, { delaySec: NO_DELAY });
  assert.equal(res.status, 'throttle');
  assert.equal(res.state.skus.length, 24);
});

test('crawlShop: 商家账号被拦截时提示改用消费者账号', async () => {
  installFakeChrome({ resolveUrl: () => 'https://bizsafe-intercept.jd.com/x', page: shopPages(10) });
  const res = await crawlShop(SEARCH_URL, { delaySec: NO_DELAY });
  assert.equal(res.status, 'login');
  assert.match(res.message, /消费者/);
});

test('crawlShop: 页面脚本报告频控页时同样暂停', async () => {
  installFakeChrome({ page: (call) => (isDisarm(call) ? undefined : { pageType: 'throttle', skus: [], totalText: '' }) });
  const res = await crawlShop(SEARCH_URL, { delaySec: NO_DELAY });
  assert.equal(res.status, 'throttle');
});

test('crawlShop: 请求停止后不再翻页', async () => {
  installFakeChrome({ page: shopPages(100) });
  let stop = false;
  const res = await crawlShop(SEARCH_URL, {
    delaySec: NO_DELAY,
    shouldStop: () => stop,
    onPage: () => {
      stop = true;
    },
  });
  assert.equal(res.status, 'stopped');
  assert.equal(res.state.pageNo, 1);
});
