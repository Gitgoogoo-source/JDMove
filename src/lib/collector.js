// 采集：在页面中运行抓取脚本并归一化
import { normalizeProduct, validateProduct } from '../shared/product-normalize.js';
import { classifyPageUrl } from '../shared/url-utils.js';
import { ITEM_FILES, runInPage, openWorkTab, navigateTab, sleep } from './chrome-env.js';

const COLLECT_TAB_KEY = 'collectTabId';
const MERCHANT_BLOCK_MSG =
  '当前浏览器登录的是商家账号，京东不允许查看其他店铺商品。请开启“无痕窗口采集”并在无痕窗口登录消费者账号，或在另一个 Chrome 用户中采集后导出/导入';

/**
 * 对已打开的商品页执行采集
 * @returns {Promise<{status: 'ok'|'throttle'|'login'|'setup'|'error', product?: object, warnings?: string[], message?: string}>}
 */
export async function collectFromTab(tabId, { scrollDetail = true, allVariants = false } = {}) {
  const tab = await chrome.tabs.get(tabId);
  const kind = classifyPageUrl(tab.url);
  if (kind === 'merchant_block') return { status: 'login', message: MERCHANT_BLOCK_MSG };
  if (kind === 'throttle') return { status: 'throttle', message: '京东触发了访问频控/验证，请在该页面手动完成验证后再继续' };
  if (kind === 'login') return { status: 'login', message: '需要登录京东账号' };
  if (kind !== 'item') return { status: 'error', message: '当前页面不是京东商品详情页' };

  const raw = await runInPage(tabId, ITEM_FILES, (opts) => window.__JDMOVE__.extractItem(opts), [{ scrollDetail }]);
  if (!raw) return { status: 'error', message: '页面脚本未返回数据' };
  if (raw.pageType === 'throttle') return { status: 'throttle', message: '京东触发了访问频控/验证，请手动处理后继续' };
  if (raw.pageType === 'merchant_block') return { status: 'login', message: MERCHANT_BLOCK_MSG };
  if (raw.pageType === 'login') return { status: 'login', message: '需要登录京东账号' };
  const product = normalizeProduct(raw, { allVariants });
  return { status: 'ok', product, warnings: validateProduct(product) };
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

/** 在采集窗口（可选无痕）的标签页中打开链接并采集 */
export async function collectUrl(url, opts = {}) {
  let tab = await collectTab();
  if (tab && tab.incognito !== Boolean(opts.useIncognito)) tab = null;
  try {
    tab = tab ? await navigateTab(tab.id, url) : await openWorkTab(url, { incognito: Boolean(opts.useIncognito) });
  } catch (e) {
    // 无痕权限未开启等环境问题：整体暂停，而不是逐条失败
    return { status: /无痕/.test(e.message) ? 'setup' : 'error', message: e.message };
  }
  await chrome.storage.session.set({ [COLLECT_TAB_KEY]: tab.id });
  await sleep(1500);
  return collectFromTab(tab.id, opts);
}

export async function extractListSkus(tabId) {
  return runInPage(tabId, ITEM_FILES, () => window.__JDMOVE__.extractListSkus(), []);
}
