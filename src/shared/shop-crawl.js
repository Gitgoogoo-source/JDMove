// 店铺翻页抓取的状态推进（纯函数）：每抓完一页调用 applyPage，决定是否继续翻页。
// 不同店铺模板每页条数不同（24/20），翻页方式也不同，所以是否到最后一页以页面分页栏的“下一页”为准。

/** 没有总数时的安全上限：200 页 × 24 = 4800 个商品 */
export const DEFAULT_MAX_PAGES = 200;

export const CRAWL_STOP_REASONS = Object.freeze({
  last: '已到最后一页',
  empty: '本页没有商品',
  repeat: '本页商品都已抓过（翻页没有生效或已越过最后一页）',
  limit: '已达到页数上限',
});

/**
 * @typedef {{pageNo: number, skus: string[], added: string[], total: number|null, pageCount: number|null,
 *   done: boolean, reason: ''|keyof typeof CRAWL_STOP_REASONS}} CrawlState
 */

/** @returns {CrawlState} */
export function createCrawlState() {
  return { pageNo: 0, skus: [], added: [], total: null, pageCount: null, done: false, reason: '' };
}

function stopReason({ pageSkus, added, pageNo, hasNext, maxPages }) {
  if (pageSkus.length === 0) return 'empty';
  if (added.length === 0) return 'repeat';
  if (hasNext === false) return 'last';
  if (pageNo >= maxPages) return 'limit';
  return '';
}

const positiveInt = (v) => (Number.isInteger(v) && v > 0 ? v : null);

/**
 * 合并一页的抓取结果
 * @param {CrawlState} state
 * @param {{skus: string[], total?: number|null, hasNext?: boolean, pagerMax?: number|null}} page
 *   hasNext：分页栏里有可点的“下一页”；pagerMax：分页栏里出现的最大页码（只用于显示进度）
 * @param {{maxPages?: number}} [opts]
 * @returns {CrawlState}
 */
export function applyPage(state, page, { maxPages = DEFAULT_MAX_PAGES } = {}) {
  if (state.done) return state;
  const pageSkus = [...new Set((page?.skus ?? []).map(String))];
  const known = new Set(state.skus);
  const added = pageSkus.filter((id) => !known.has(id));
  const total = state.total ?? (Number.isInteger(page?.total) ? page.total : null);
  const pagerMax = positiveInt(page?.pagerMax);
  const pageCount = pagerMax == null ? state.pageCount : Math.max(state.pageCount ?? 0, pagerMax);
  const pageNo = state.pageNo + 1;
  const reason = stopReason({ pageSkus, added, pageNo, hasNext: page?.hasNext, maxPages });
  return { pageNo, skus: [...state.skus, ...added], added, total, pageCount, done: reason !== '', reason };
}

/**
 * 翻页时才发现已经结束（如点“下一页”时按钮已不可用）
 * @param {CrawlState} state
 * @param {keyof typeof CRAWL_STOP_REASONS} reason
 * @returns {CrawlState}
 */
export function finishCrawl(state, reason) {
  return state.done ? state : { ...state, done: true, reason };
}
