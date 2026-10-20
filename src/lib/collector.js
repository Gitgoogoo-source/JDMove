// 采集：在页面中运行抓取脚本并归一化
import { normalizeProduct, validateProduct } from '../shared/product-normalize.js';
import { parsePrice } from '../shared/pricing.js';
import { classifyPageUrl } from '../shared/url-utils.js';
import { ITEM_FILES, runInPage, openWorkTab, navigateTab, closeTab, sleep } from './chrome-env.js';

const COLLECT_TAB_KEY = 'collectTabId';
export const MERCHANT_BLOCK_MSG =
  '当前浏览器登录的是商家账号，京东不允许查看其他店铺商品。请开启“无痕窗口采集”并在无痕窗口登录消费者账号，或在另一个 Chrome 用户中采集后导出/导入';

/** 频控/验证、登录拦截等需要整体暂停的页面；正常页面返回 null */
function blockedResult(kind) {
  if (kind === 'merchant_block') return { status: 'login', message: MERCHANT_BLOCK_MSG };
  if (kind === 'throttle') return { status: 'throttle', message: '京东触发了访问频控/验证，请在该页面手动完成验证后再继续' };
  if (kind === 'login') return { status: 'login', message: '需要登录京东账号' };
  return null;
}

/** 标签页当前是否是可以读取的商品页；不是时返回对应的结果 */
async function itemPageProblem(tabId) {
  const tab = await chrome.tabs.get(tabId);
  const kind = classifyPageUrl(tab.url);
  return blockedResult(kind) ?? (kind === 'item' ? null : { status: 'error', message: '当前页面不是京东商品详情页' });
}

/**
 * 对已打开的商品页执行采集
 * @returns {Promise<{status: 'ok'|'throttle'|'login'|'setup'|'error', product?: object, warnings?: string[], message?: string}>}
 */
export async function collectFromTab(tabId, { scrollDetail = true, allVariants = false } = {}) {
  const problem = await itemPageProblem(tabId);
  if (problem) return problem;
  const raw = await runInPage(tabId, ITEM_FILES, (opts) => window.__JDMOVE__.extractItem(opts), [{ scrollDetail }]);
  if (!raw) return { status: 'error', message: '页面脚本未返回数据' };
  const blocked = blockedResult(raw.pageType);
  if (blocked) return blocked;
  const product = normalizeProduct(raw, { allVariants });
  return { status: 'ok', product, warnings: validateProduct(product) };
}

/**
 * 对已打开的商品页只读取当前显示的价格
 * @returns {Promise<{status: 'ok'|'throttle'|'login'|'setup'|'error', price?: number, label?: string, message?: string}>}
 */
export async function priceFromTab(tabId) {
  const problem = await itemPageProblem(tabId);
  if (problem) return problem;
  const raw = await runInPage(tabId, ITEM_FILES, () => window.__JDMOVE__.extractPrice(), []);
  if (!raw) return { status: 'error', message: '页面脚本未返回数据' };
  const blocked = blockedResult(raw.pageType);
  if (blocked) return blocked;
  const price = parsePrice(raw.priceText);
  if (!(price > 0)) return { status: 'error', message: '商品页没有显示价格（可能已下架或无货）' };
  return { status: 'ok', price, label: raw.label || '' };
}

async function collectTab() {
  const { [COLLECT_TAB_KEY]: id } = await chrome.storage.session.get(COLLECT_TAB_KEY);
  if (!id) return null;
  try {
    return await chrome.tabs.get(id);
  } catch {
    return null;
  }
}

/** 打开工作标签页失败时的状态：无痕权限未开启等环境问题需要整体暂停，而不是逐条失败 */
export const openErrorStatus = (e) => (/无痕/.test(e?.message ?? '') ? 'setup' : 'error');

/** 在复用的采集标签页（可选无痕窗口）中打开链接，返回加载完成的标签页 */
export async function openInCollectTab(url, { useIncognito = false } = {}) {
  let tab = await collectTab();
  if (tab && tab.incognito !== Boolean(useIncognito)) tab = null;
  tab = tab ? await navigateTab(tab.id, url) : await openWorkTab(url, { incognito: Boolean(useIncognito) });
  await chrome.storage.session.set({ [COLLECT_TAB_KEY]: tab.id });
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
