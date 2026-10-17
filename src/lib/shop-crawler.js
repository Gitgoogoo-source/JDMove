// 抓取店铺全部商品：在采集标签页里逐页打开店铺“全部商品”列表，等页面自己渲染后读取 SKU
import { parseShopInput, buildShopSearchUrl, appIdFromLinks, parseTotalCount } from '../shared/shop-url.js';
import { createCrawlState, applyPage, CRAWL_STOP_REASONS, DEFAULT_MAX_PAGES } from '../shared/shop-crawl.js';
import { classifyPageUrl } from '../shared/url-utils.js';
import { SHOP_FILES, runInPage, sleep, randomBetween } from './chrome-env.js';
import { openInCollectTab, openErrorStatus, MERCHANT_BLOCK_MSG } from './collector.js';

/** 翻页间隔（秒）：每页只打开一次列表，比逐个采集商品的间隔短 */
export const SHOP_PAGE_DELAY_SEC = Object.freeze({ min: 3, max: 6 });
const STOP_POLL_MS = 250;

const BLOCKED = {
  merchant_block: { status: 'login', message: MERCHANT_BLOCK_MSG },
  throttle: { status: 'throttle', message: '京东触发了访问频控/验证，请在店铺页手动完成验证后再继续' },
  login: { status: 'login', message: '需要登录京东账号' },
};

class CrawlHalt extends Error {
  constructor({ status, message }) {
    super(message);
    this.status = status;
  }
}

function assertNotBlocked(kind) {
  if (BLOCKED[kind]) throw new CrawlHalt(BLOCKED[kind]);
}

/** 打开页面并在页面里执行脚本；被拦截（频控/登录/商家账号）时抛出 CrawlHalt */
async function openAndRun(url, func, args, opts) {
  const tab = await openInCollectTab(url, opts);
  assertNotBlocked(classifyPageUrl(tab.url));
  const res = await runInPage(tab.id, SHOP_FILES, func, args);
  if (!res) throw new CrawlHalt({ status: 'error', message: '页面脚本未返回数据' });
  assertNotBlocked(res.pageType);
  return res;
}

async function resolveShop(input, opts) {
  const parsed = parseShopInput(input);
  if (!parsed) throw new CrawlHalt({ status: 'error', message: '不是京东店铺链接，请填写店铺首页或“全部商品”页的链接' });
  if (parsed.kind === 'search') return parsed;
  const res = await openAndRun(parsed.homeUrl, () => window.__JDMOVE__.listShopSearchLinks(), [], opts);
  const appId = appIdFromLinks(res.links);
  if (!appId) throw new CrawlHalt({ status: 'error', message: '没有在店铺首页找到商品列表，请打开店铺的“全部商品”页后复制该页链接' });
  return { kind: 'search', appId, categoryId: '0', orderBy: '0', direction: '1' };
}

async function waitDelay(seconds, shouldStop) {
  const end = Date.now() + seconds * 1000;
  while (Date.now() < end && !shouldStop()) await sleep(Math.min(STOP_POLL_MS, end - Date.now()));
}

/**
 * @param {string} input 店铺首页或“全部商品”页链接
 * @param {{useIncognito?: boolean, maxPages?: number, delaySec?: {min: number, max: number},
 *   shouldStop?: () => boolean, onPage?: (state: import('../shared/shop-crawl.js').CrawlState) => any}} [opts]
 * @returns {Promise<{status: 'ok'|'stopped'|'throttle'|'login'|'setup'|'error',
 *   state: import('../shared/shop-crawl.js').CrawlState, message: string}>}
 */
export async function crawlShop(input, opts = {}) {
  const { maxPages = DEFAULT_MAX_PAGES, delaySec = SHOP_PAGE_DELAY_SEC, shouldStop = () => false, onPage = () => {} } = opts;
  const tabOpts = { useIncognito: Boolean(opts.useIncognito) };
  let state = createCrawlState();
  try {
    const shop = await resolveShop(input, tabOpts);
    while (!state.done) {
      if (state.pageNo > 0) await waitDelay(randomBetween(delaySec.min, delaySec.max), shouldStop);
      if (shouldStop()) return { status: 'stopped', state, message: '已停止' };
      const url = buildShopSearchUrl(shop, state.pageNo + 1);
      const res = await openAndRun(url, (o) => window.__JDMOVE__.extractShopPage(o), [{}], tabOpts);
      state = applyPage(state, { skus: res.skus, total: parseTotalCount(res.totalText) }, { maxPages });
      await onPage(state);
    }
    return { status: 'ok', state, message: CRAWL_STOP_REASONS[state.reason] };
  } catch (e) {
    const status = e instanceof CrawlHalt ? e.status : openErrorStatus(e);
    return { status, state, message: e.message };
  }
}
