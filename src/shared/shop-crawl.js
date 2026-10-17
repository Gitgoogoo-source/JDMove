// 店铺翻页抓取的状态推进（纯函数）：每抓完一页调用 applyPage，决定是否继续翻页
import { SHOP_PAGE_SIZE } from './shop-url.js';

/** 没有总数时的安全上限：200 页 × 24 = 4800 个商品 */
export const DEFAULT_MAX_PAGES = 200;

export const CRAWL_STOP_REASONS = Object.freeze({
  last: '已到最后一页',
  empty: '本页没有商品',
  repeat: '本页商品都已抓过（已越过最后一页）',
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

function stopReason({ pageSkus, added, pageNo, pageCount, maxPages }) {
  if (pageSkus.length === 0) return 'empty';
  if (added.length === 0) return 'repeat';
  if (pageCount != null && pageNo >= pageCount) return 'last';
  if (pageNo >= maxPages) return 'limit';
  return '';
}

/**
 * 合并一页的抓取结果
 * @param {CrawlState} state
 * @param {{skus: string[], total?: number|null}} page
 * @param {{maxPages?: number}} [opts]
 * @returns {CrawlState}
 */
export function applyPage(state, page, { maxPages = DEFAULT_MAX_PAGES } = {}) {
  if (state.done) return state;
  const pageSkus = [...new Set((page?.skus ?? []).map(String))];
  const known = new Set(state.skus);
  const added = pageSkus.filter((id) => !known.has(id));
  const total = state.total ?? (Number.isInteger(page?.total) ? page.total : null);
  const pageCount = total == null ? null : Math.ceil(total / SHOP_PAGE_SIZE);
  const pageNo = state.pageNo + 1;
  const reason = stopReason({ pageSkus, added, pageNo, pageCount, maxPages });
  return { pageNo, skus: [...state.skus, ...added], added, total, pageCount, done: reason !== '', reason };
}
