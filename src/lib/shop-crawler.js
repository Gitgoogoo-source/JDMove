// 抓取店铺全部商品：在采集标签页里打开店铺“全部商品”页，等页面自己渲染后读取 SKU。
// 店铺装修模板差异很大（见 src/inject/jd-shop-list.js 顶部说明），这里的策略是：
// 1. appId 优先从页面隐藏字段读取（有些首页没有“全部商品”链接）；
// 2. 页面上每个带分页栏的列表模块分别抓取，跟着模块里的“下一页”翻页，最后合并去重；
// 3. 抓到的数量少于模块显示的总数时（默认排序翻页会漂移），换“上架时间”“销量”排序补抓；
// 4. “全部商品”页一个列表都没有时，改用店内搜索兜底（可能不完整，会明确提示）。
import {
  parseShopInput,
  buildShopSearchUrl,
  parseTotalCount,
  pickShopInfo,
  buildFallbackSearchUrl,
  resolveNextUrl,
  SORT_FALLBACKS,
} from '../shared/shop-url.js';
import { createCrawlState, applyPage, finishCrawl, DEFAULT_MAX_PAGES } from '../shared/shop-crawl.js';
import { classifyPageUrl } from '../shared/url-utils.js';
import { SHOP_FILES, runInPage, sleep, randomBetween } from './chrome-env.js';
import { openInCollectTab, openErrorStatus, MERCHANT_BLOCK_MSG } from './collector.js';

/** 翻页间隔（秒）：每页只打开一次列表，比逐个采集商品的间隔短 */
export const SHOP_PAGE_DELAY_SEC = Object.freeze({ min: 3, max: 6 });
const STOP_POLL_MS = 250;
const NO_APP_ID_MSG = '没有在页面上找到店铺的商品列表，请打开店铺的“全部商品”页后复制该页链接';

const BLOCKED = {
  merchant_block: { status: 'login', message: MERCHANT_BLOCK_MSG },
  throttle: { status: 'throttle', message: '京东触发了访问频控/验证，请在店铺页手动完成验证后再继续' },
  login: { status: 'login', message: '需要登录京东账号' },
  // 列表接口被京东限流（返回 403）时，页面一直停在“努力加载中”
  loading_failed: {
    status: 'throttle',
    message: '店铺商品列表一直显示“加载中”（京东接口限流），请等几分钟后重新点“抓取店铺”，已抓到的商品会保留',
  },
};

class CrawlHalt extends Error {
  constructor({ status, message }) {
    super(message);
    this.status = status;
  }
}
class CrawlStopped extends Error {}

function assertNotBlocked(kind) {
  if (BLOCKED[kind]) throw new CrawlHalt(BLOCKED[kind]);
}

// 页面主世界里执行的函数：命名后便于测试区分
function extractShopPageInTab(o) {
  return window.__JDMOVE__.extractShopPage(o);
}
function nextShopPageInTab(o) {
  return window.__JDMOVE__.nextShopPage(o);
}
function sortShopModuleInTab(o) {
  return window.__JDMOVE__.sortShopModule(o);
}
function readShopInfoInTab() {
  return window.__JDMOVE__.readShopInfo();
}

/** 复用的采集标签页：打开地址、在页面里执行脚本（被频控/登录/商家账号拦截时抛出 CrawlHalt） */
function createTab(tabOpts) {
  let tabId = null;
  return {
    async open(url) {
      tabId = (await openInCollectTab(url, tabOpts)).id;
    },
    async run(func, arg = {}) {
      const tab = await chrome.tabs.get(tabId);
      assertNotBlocked(classifyPageUrl(tab.url));
      const res = await runInPage(tabId, SHOP_FILES, func, [arg]);
      if (!res) throw new CrawlHalt({ status: 'error', message: '页面脚本未返回数据' });
      assertNotBlocked(res.pageType);
      return res;
    },
  };
}

/** 全局进度：跨模块、跨补抓轮次合并去重，并负责翻页间隔与停止 */
function createControl({ maxPages = DEFAULT_MAX_PAGES, delaySec = SHOP_PAGE_DELAY_SEC, shouldStop = () => false, onPage = () => {} }) {
  const seen = new Set();
  return {
    maxPages,
    count: () => seen.size,
    result: () => ({ skus: [...seen] }),
    async report(state, label) {
      const added = state.added.filter((id) => !seen.has(id));
      added.forEach((id) => seen.add(id));
      await onPage({ label, pageNo: state.pageNo, pageCount: state.pageCount, total: state.total, added, skus: [...seen] });
    },
    async pause() {
      const end = Date.now() + randomBetween(delaySec.min, delaySec.max) * 1000;
      while (Date.now() < end && !shouldStop()) await sleep(Math.min(STOP_POLL_MS, end - Date.now()));
      if (shouldStop()) throw new CrawlStopped('已停止');
    },
  };
}

const toPage = (res) => ({ skus: res.skus, total: parseTotalCount(res.totalText), hasNext: res.hasNext, pagerMax: res.pagerMax });

/**
 * 抓取一个列表模块的一轮（从当前页开始一直翻到最后一页）
 * @param {{module: number, params: object|null, label: string}} pass params 为按地址翻页时使用的排序等参数
 */
async function crawlPass(tab, ctl, { module, params, label }) {
  let state = createCrawlState();
  let mode = null;
  let res = await tab.run(extractShopPageInTab, { module });
  for (;;) {
    state = applyPage(state, toPage(res), { maxPages: ctl.maxPages });
    await ctl.report(state, label);
    if (state.done) break;
    await ctl.pause();
    const nav = await tab.run(nextShopPageInTab, { module });
    if (nav.action === 'end') {
      state = finishCrawl(state, 'last');
      break;
    }
    if (nav.action === 'navigate') {
      const url = resolveNextUrl(nav.url, params);
      if (!url) throw new CrawlHalt({ status: 'error', message: `翻页地址无法识别：${nav.url}` });
      await tab.open(url);
    }
    mode = nav.action;
    res = await tab.run(extractShopPageInTab, { module });
  }
  return { state, mode };
}

/** 切换到补抓用的排序并回到第 1 页；模块不支持排序时返回 false */
async function openSorted(tab, shop, module, sort, mode) {
  if (mode === 'navigate') {
    await tab.open(buildShopSearchUrl({ ...shop, orderBy: sort.orderBy }, 1));
    return true;
  }
  await tab.open(buildShopSearchUrl(shop, 1));
  const res = await tab.run(sortShopModuleInTab, { module, label: sort.label });
  if (res.action === 'none') return false;
  if (res.action === 'navigate') {
    const url = resolveNextUrl(res.url, null);
    if (!url) return false;
    await tab.open(url);
  }
  return true;
}

/** 抓取第 module 个列表模块；数量不足总数时换排序补抓 */
async function crawlModule(tab, ctl, shop, module, moduleCount) {
  // 前一个模块可能已翻页或换了地址，回到第 1 页再开始
  if (module > 0) await tab.open(buildShopSearchUrl(shop, 1));
  const label = moduleCount > 1 ? `列表${module + 1}` : '';
  const first = await crawlPass(tab, ctl, { module, params: shop, label });
  const covered = new Set(first.state.skus);
  const { total } = first.state;
  for (const sort of SORT_FALLBACKS) {
    if (total == null || covered.size >= total || first.state.pageNo < 2) break;
    await ctl.pause();
    if (!(await openSorted(tab, shop, module, sort, first.mode))) break;
    const params = { ...shop, orderBy: sort.orderBy };
    const pass = await crawlPass(tab, ctl, { module, params, label: `${label}补抓（按${sort.label}）` });
    pass.state.skus.forEach((id) => covered.add(id));
  }
  return { label: label || '商品列表', total, found: covered.size };
}

/** “全部商品”页没有任何列表时，用关键词留空的店内搜索兜底 */
async function crawlFallback(tab, ctl, shop, info) {
  const known = info ?? pickShopInfo(await tab.run(readShopInfoInTab));
  const url = buildFallbackSearchUrl({ ...known, appId: known.appId ?? shop.appId });
  await ctl.pause();
  await tab.open(url);
  const { state } = await crawlPass(tab, ctl, { module: 0, params: null, label: '店内搜索' });
  const totalNote = state.total != null ? `（共 ${state.total} 件）` : '';
  return `店铺“全部商品”页没有商品列表，已改用店内搜索抓取${totalNote}，店内搜索结果可能不完整，请核对数量`;
}

async function resolveShop(input, tab) {
  const parsed = parseShopInput(input);
  if (!parsed) throw new CrawlHalt({ status: 'error', message: '不是京东店铺链接，请填写店铺首页或“全部商品”页的链接' });
  if (parsed.kind === 'search') {
    const { kind, ...shop } = parsed;
    return { shop, info: null };
  }
  await tab.open(parsed.homeUrl);
  const info = pickShopInfo(await tab.run(readShopInfoInTab));
  if (!info.appId) throw new CrawlHalt({ status: 'error', message: NO_APP_ID_MSG });
  return { shop: { appId: info.appId, categoryId: '0', orderBy: '0', direction: '1' }, info };
}

function summarize(results, count) {
  const short = results.filter((r) => r.total != null && r.found < r.total);
  const notes = short.map((r) => `${r.label}显示共 ${r.total} 件，实际抓到 ${r.found} 件`);
  return [`共找到 ${count} 个商品`, ...notes].join('；');
}

/**
 * @param {string} input 店铺首页、“全部商品”页或店内搜索页链接
 * @param {{useIncognito?: boolean, maxPages?: number, delaySec?: {min: number, max: number},
 *   shouldStop?: () => boolean,
 *   onPage?: (p: {label: string, pageNo: number, pageCount: number|null, total: number|null, added: string[], skus: string[]}) => any}} [opts]
 * @returns {Promise<{status: 'ok'|'stopped'|'throttle'|'login'|'setup'|'error', state: {skus: string[]}, message: string, partial?: boolean}>}
 */
export async function crawlShop(input, opts = {}) {
  const ctl = createControl(opts);
  const tab = createTab({ useIncognito: Boolean(opts.useIncognito) });
  try {
    const { shop, info } = await resolveShop(input, tab);
    await tab.open(buildShopSearchUrl(shop, 1));
    const { moduleCount } = await tab.run(extractShopPageInTab, { module: 0 });
    const results = [];
    for (let m = 0; m < moduleCount; m += 1) results.push(await crawlModule(tab, ctl, shop, m, moduleCount));
    if (ctl.count() === 0) {
      const message = await crawlFallback(tab, ctl, shop, info);
      return { status: 'ok', state: ctl.result(), message, partial: true };
    }
    return { status: 'ok', state: ctl.result(), message: summarize(results, ctl.count()) };
  } catch (e) {
    if (e instanceof CrawlStopped) return { status: 'stopped', state: ctl.result(), message: e.message };
    const status = e instanceof CrawlHalt ? e.status : openErrorStatus(e);
    return { status, state: ctl.result(), message: e.message };
  }
}
