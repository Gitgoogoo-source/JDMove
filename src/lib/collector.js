// 采集：在页面中运行抓取脚本并归一化
import { collectWarnings, normalizeProduct, validateProduct } from '../shared/product-normalize.js';
import { classifyPageUrl, isB2bItemUrl } from '../shared/url-utils.js';
import { ITEM_FILES, B2B_ITEM_FILES, runInPage, openWorkTab, navigateTab, closeTab, bringTabToFront, sleep } from './chrome-env.js';

const COLLECT_TAB_KEY = 'collectTabId';
// 与 jd-detail.js 的 DETAIL_STATE.notLoaded 一致
const DETAIL_NOT_LOADED = 'not_loaded';
const DETAIL_RETRY_DELAY_MS = 1500;
export const MERCHANT_BLOCK_MSG =
  '京东拦截了当前账号查看其他店铺商品（商家账号限制），请在浏览器中换用消费者账号登录后再继续';

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
 * @returns {Promise<{status: 'ok'|'throttle'|'login'|'error', product?: object, warnings?: string[], raw?: object, message?: string}>}
 *   raw：页面返回的原始数据（保存到本地时写进 原始数据.json）
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
  const warnings = [...validateProduct(product, { detailState: raw.detailState }), ...collectWarnings(product)];
  return { status: 'ok', product, warnings, raw };
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

/** 在复用的采集标签页（当前窗口）中打开链接，返回加载完成的标签页 */
export async function openInCollectTab(url) {
  const tab = await collectTab();
  const opened = tab ? await navigateTab(tab.id, url) : await openWorkTab(url);
  await chrome.storage.session.set({ [COLLECT_TAB_KEY]: opened.id });
  return opened;
}

/** 在采集标签页中打开链接并采集 */
export async function collectUrl(url, opts = {}) {
  let tab;
  try {
    tab = await openInCollectTab(url);
  } catch (e) {
    return { status: 'error', message: e.message };
  }
  // 采集窗口在后台（被其他窗口挡住）时页面不渲染，详情区不会加载
  await bringTabToFront(tab.id);
  await sleep(1500);
  return collectFromTab(tab.id, opts);
}

/**
 * 采集结束后关闭复用的采集标签页：它开在当前窗口里，切换到商家账号后
 * 京东会把这个商品页拦成“商家账号只允许查看本店商品详情”。
 */
export async function closeCollectTab() {
  const tab = await collectTab();
  if (!tab) return;
  await chrome.storage.session.remove(COLLECT_TAB_KEY);
  await closeTab(tab.id);
}

export async function extractListSkus(tabId) {
  return runInPage(tabId, ITEM_FILES, () => window.__JDMOVE__.extractListSkus(), []);
}
