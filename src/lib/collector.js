// 采集：在页面中运行抓取脚本并归一化
import { normalizeProduct, validateProduct } from '../shared/product-normalize.js';
import { parsePrice } from '../shared/pricing.js';
import { classifyPageUrl, isB2bItemUrl } from '../shared/url-utils.js';
import { ITEM_FILES, B2B_ITEM_FILES, runInPage, openWorkTab, navigateTab, closeTab, bringTabToFront, sleep } from './chrome-env.js';

const COLLECT_TAB_KEY = 'collectTabId';
// 无痕窗口单独记一个：一批里京东和万商商品交替时，两个窗口各复用自己的标签页
const INCOGNITO_TAB_KEY = 'collectTabIdIncognito';
// 与 jd-detail.js 的 DETAIL_STATE.notLoaded 一致
const DETAIL_NOT_LOADED = 'not_loaded';
const DETAIL_RETRY_DELAY_MS = 1500;
export const MERCHANT_BLOCK_MSG =
  '当前浏览器登录的是商家账号，京东不允许查看其他店铺商品。请开启“无痕窗口采集”并在无痕窗口登录消费者账号，或在另一个 Chrome 用户中采集后导出/导入';

/** 频控/验证、登录拦截等需要整体暂停的页面；正常页面返回 null */
function blockedResult(kind) {
  if (kind === 'merchant_block') return { status: 'login', message: MERCHANT_BLOCK_MSG };
  if (kind === 'throttle') return { status: 'throttle', message: '京东触发了访问频控/验证，请在该页面手动完成验证后再继续' };
  if (kind === 'login') return { status: 'login', message: '需要登录京东账号' };
  if (kind === 'b2b_login') return { status: 'login', message: '需要登录京东万商账号：请在普通窗口打开 b2b.jd.com 登录后再继续' };
  if (kind === 'b2b_denied') return { status: 'error', message: '当前京东万商账号没有这个商品的查看/购买权限，页面没有商品信息' };
  if (kind === 'b2b_no_data') return { status: 'error', message: '京东万商商品页没有返回商品数据（页面加载失败或结构变化），请重新采集' };
  return null;
}

/**
 * 标签页对应的采集模板，以及当前是否是可以读取的商品页
 * @returns {Promise<{files: string[], problem: object|null}>} problem：不是商品页时对应的结果
 */
async function itemPage(tabId) {
  const { url } = await chrome.tabs.get(tabId);
  const kind = classifyPageUrl(url);
  const problem = blockedResult(kind) ?? (kind === 'item' ? null : { status: 'error', message: '当前页面不是京东商品详情页' });
  return { files: isB2bItemUrl(url) ? B2B_ITEM_FILES : ITEM_FILES, problem };
}

const extractRaw = (tabId, files, scrollDetail) =>
  runInPage(tabId, files, (opts) => window.__JDMOVE__.extractItem(opts), [{ scrollDetail }]);

/**
 * 对已打开的商品页执行采集。详情区没加载出来（窗口被遮挡/最小化时页面不渲染）时，
 * 把标签页切到前台再取一次；第二次不整页滚动，只等详情区。
 * @param {number} tabId
 * @param {{scrollDetail?: boolean, allVariants?: boolean, retryDelayMs?: number}} [opts]
 * @returns {Promise<{status: 'ok'|'throttle'|'login'|'setup'|'error', product?: object, warnings?: string[], message?: string}>}
 */
export async function collectFromTab(tabId, { scrollDetail = true, allVariants = false, retryDelayMs = DETAIL_RETRY_DELAY_MS } = {}) {
  const { files, problem } = await itemPage(tabId);
  if (problem) return problem;
  let raw = await extractRaw(tabId, files, scrollDetail);
  if (raw?.pageType === 'item' && raw.detailState === DETAIL_NOT_LOADED) {
    await bringTabToFront(tabId);
    await sleep(retryDelayMs);
    // 重试没拿到结果（如页面脚本异常）时保留第一次的数据
    raw = (await extractRaw(tabId, files, false)) ?? raw;
  }
  if (!raw) return { status: 'error', message: '页面脚本未返回数据' };
  const blocked = blockedResult(raw.pageType);
  if (blocked) return blocked;
  const product = normalizeProduct(raw, { allVariants });
  return { status: 'ok', product, warnings: validateProduct(product, { detailState: raw.detailState }) };
}

/**
 * 对已打开的商品页只读取当前显示的价格
 * @returns {Promise<{status: 'ok'|'throttle'|'login'|'setup'|'error', price?: number, label?: string, message?: string}>}
 */
export async function priceFromTab(tabId) {
  const { files, problem } = await itemPage(tabId);
  if (problem) return problem;
  const raw = await runInPage(tabId, files, () => window.__JDMOVE__.extractPrice(), []);
  if (!raw) return { status: 'error', message: '页面脚本未返回数据' };
  const blocked = blockedResult(raw.pageType);
  if (blocked) return blocked;
  const price = parsePrice(raw.priceText);
  if (!(price > 0)) return { status: 'error', message: '商品页没有显示价格（可能已下架或无货）' };
  return { status: 'ok', price, label: raw.label || '' };
}

async function collectTab(key = COLLECT_TAB_KEY) {
  const { [key]: id } = await chrome.storage.session.get(key);
  if (!id) return null;
  try {
    return await chrome.tabs.get(id);
  } catch {
    return null;
  }
}

/** 打开工作标签页失败时的状态：无痕权限未开启等环境问题需要整体暂停，而不是逐条失败 */
export const openErrorStatus = (e) => (/无痕/.test(e?.message ?? '') ? 'setup' : 'error');

/**
 * 在复用的采集标签页（可选无痕窗口）中打开链接，返回加载完成的标签页。
 * 京东万商的商品固定在普通窗口打开：万商账号登录在这里，也不会被商家账号拦截
 */
export async function openInCollectTab(url, { useIncognito = false } = {}) {
  const incognito = Boolean(useIncognito) && !isB2bItemUrl(url);
  const key = incognito ? INCOGNITO_TAB_KEY : COLLECT_TAB_KEY;
  let tab = await collectTab(key);
  if (tab && tab.incognito !== incognito) tab = null;
  tab = tab ? await navigateTab(tab.id, url) : await openWorkTab(url, { incognito });
  await chrome.storage.session.set({ [key]: tab.id });
  return tab;
}

/** 在采集窗口（可选无痕）的标签页中打开链接并采集 */
export async function collectUrl(url, opts = {}) {
  let tab;
  try {
    tab = await openInCollectTab(url, opts);
  } catch (e) {
    return { status: openErrorStatus(e), message: e.message };
  }
  // 采集窗口在后台（无痕窗口创建时不抢焦点、之后被其他窗口挡住）时页面不渲染，详情区不会加载
  await bringTabToFront(tab.id);
  await sleep(1500);
  return collectFromTab(tab.id, opts);
}

/** 在采集窗口中打开商品页，只读取京东今日价（不滚动、不取图），用于检查已发布商品的价格倒挂 */
export async function checkPriceUrl(url, { useIncognito = false } = {}) {
  let tab;
  try {
    tab = await openInCollectTab(url, { useIncognito });
  } catch (e) {
    return { status: openErrorStatus(e), message: e.message };
  }
  await sleep(800);
  return priceFromTab(tab.id);
}

/**
 * 采集结束后关闭复用的采集标签页：它开在当前窗口里，切换到商家账号后
 * 京东会把这个商品页拦成“商家账号只允许查看本店商品详情”。
 * 无痕标签页保留：关掉最后一个无痕窗口后消费者账号需要重新登录。
 */
export async function closeCollectTab() {
  const tab = await collectTab();
  if (!tab || tab.incognito) return;
  await chrome.storage.session.remove(COLLECT_TAB_KEY);
  await closeTab(tab.id);
}

export async function extractListSkus(tabId) {
  return runInPage(tabId, ITEM_FILES, () => window.__JDMOVE__.extractListSkus(), []);
}
