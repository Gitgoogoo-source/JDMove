// 改价：打开店铺商品编辑页 -> 核对是不是这个商品 -> 已启用 SKU 的京东价统一改成新价格 -> 按设置提交
import { buildEditUrl, pricesMatch, salePriceOf } from '../shared/price-watch.js';
import { callBackend, openWorkTab, closeTab, sleep } from './chrome-env.js';

export const LOGIN_MSG = '商家后台需要重新登录';
const EDIT_NOT_READY_MSG = '商品编辑页没有打开或没有 SKU 价格表：请核对店铺商品编号，以及设置里的“商品编辑页地址”';
// 写入新价格后等一会儿再读一次，确认没有被页面随后加载的数据改回去
const RECHECK_DELAY_MS = 1500;

/** 等编辑页的 SKU 价格表出现；编辑页不一定和发布页是同一套表单，所以只看 SKU 表 */
async function waitEditable(tabId, timeoutMs = 40000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const st = await callBackend(tabId, 'status').catch(() => null);
    if (st?.loginRequired) return { login: true };
    const rows = await callBackend(tabId, 'skuRowCount').catch(() => 0);
    if (rows > 0) return { ready: true };
    await sleep(1000);
  }
  return { ready: false };
}

function failureDetail(result) {
  return [result?.error, ...(result?.errors ?? []), ...(result?.messages ?? [])].filter(Boolean).join('；') || '提交未成功';
}

const priceList = (prices) => [...new Set(prices.filter(Boolean))].join('/') || '—';

/**
 * 编辑页上的原价必须和记录的店铺售价对得上，否则可能打开的是别的商品（编号填错/记错），不改
 * @returns {Promise<{ok: true, from: string} | {ok: false, status: string, message: string}>}
 */
async function verifyProduct(tabId, expected, verify) {
  const current = await callBackend(tabId, 'readSkuPrices');
  if (!current?.ok) return { ok: false, status: 'failed', message: current?.error || '读不到编辑页上的京东价' };
  const from = priceList(current.prices);
  if (verify && !pricesMatch(current.prices, expected)) {
    const message = `编辑页上的京东价 ¥${from} 与记录的售价 ¥${expected ?? '—'} 对不上，可能打开的不是这个商品，已停止改价。请核对店铺商品编号；确认无误的话，在批量改价窗口取消勾选“核对原价”后再改`;
    return { ok: false, status: 'need_action', message };
  }
  return { ok: true, from };
}

/** keepTab：需要人工查看的情况保留标签页 */
async function repriceInTab(tabId, job, log) {
  const { price, action } = job;
  try {
    const page = await waitEditable(tabId);
    if (page.login) return { status: 'login', message: LOGIN_MSG, keepTab: true };
    if (!page.ready) return { status: 'failed', message: EDIT_NOT_READY_MSG, keepTab: true };
    const check = await verifyProduct(tabId, job.expected, job.verify);
    if (!check.ok) return { status: check.status, message: check.message, keepTab: true };
    const { from } = check;
    const set = await callBackend(tabId, 'setSkuPrices', price);
    if (!set?.ok) return { status: 'failed', message: set?.error || '京东价写入失败', from, keepTab: true };
    await sleep(RECHECK_DELAY_MS);
    const after = await callBackend(tabId, 'readSkuPrices');
    if (!after?.ok || after.prices.some((p) => Number(p) !== Number(price))) {
      return { status: 'failed', message: `京东价写入后被页面改成了 ¥${priceList(after?.prices ?? [])}，已停止保存`, from, keepTab: true };
    }
    log(`京东价 ${from} → ${price}（${set.rows} 个 SKU）`);
    if (action === 'none') return { status: 'filled', message: '已填写新价格，请在页面检查后手动提交', from, keepTab: true };
    const result = await callBackend(tabId, 'runAction', action);
    if (result?.confirmText) return { status: 'need_action', message: `页面弹出确认：${result.confirmText}`, from, keepTab: true };
    if (!result?.ok) return { status: 'failed', message: failureDetail(result), from, keepTab: true };
    return { status: 'ok', message: (result.messages ?? []).join('；'), from, draft: action === 'draft' };
  } catch (e) {
    return { status: 'failed', message: e.message, keepTab: true };
  }
}

/**
 * 改一个已发布商品的价格
 * @param {object} item 条目（需要 shopWareId）
 * @param {number} price 新售价
 * @param {object} settings
 * @param {(msg: string) => void} log
 * @param {{verify?: boolean}} [opts] verify：先核对编辑页上的原价与记录的售价一致（默认开启）
 * @returns {Promise<{status: 'ok'|'filled'|'need_action'|'failed'|'login', message: string, from?: string, draft?: boolean}>}
 */
export async function repriceItem(item, price, settings, log, { verify = true } = {}) {
  if (!(price > 0)) return { status: 'need_action', message: '新售价无效' };
  if (!item.shopWareId) return { status: 'need_action', message: '缺少店铺商品编号，请在“编辑”或批量改价窗口中填写' };
  let url;
  try {
    url = buildEditUrl(settings.priceWatch.editUrlTemplate, item.shopWareId);
  } catch (e) {
    return { status: 'need_action', message: e.message };
  }
  let tab;
  try {
    tab = await openWorkTab(url);
  } catch (e) {
    return { status: 'failed', message: `编辑页打不开：${e.message}` };
  }
  const job = { price, action: settings.priceWatch.repriceAction, expected: salePriceOf(item, settings.price), verify };
  const { keepTab, ...res } = await repriceInTab(tab.id, job, log);
  if (!keepTab) await closeTab(tab.id);
  return res;
}
