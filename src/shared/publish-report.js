// 发布结果汇总（纯函数）：一轮发布结束后，哪些商品发布成功、哪些没成功（含暂停/停止后没轮到的），
// 以及“失败表格”（发布失败-<日期-时间>.xlsx）的内容
import { formatMasterTime } from './master-sheet.js';

/**
 * 队列里每个商品的发布结果（queue.js 记下、随 onRunEnd 带出）
 * @typedef {{id: string, status: string, message: string, title: string, refUrl: string, skus: string[], name?: string}} PublishResult
 *   status：发布流程返回的状态（published/filled/need_action/failed/throttle）；skus：京东分配的 SKU；name：上架名称（成功时）
 * @typedef {PublishResult & {statusText: string, reason: string}} ReportEntry
 * @typedef {{total: number, succeeded: ReportEntry[], failed: ReportEntry[]}} PublishReport
 */

export const STATUS_TEXT = Object.freeze({
  published: '成功',
  filled: '已填写，未点发布',
  need_action: '需处理',
  failed: '失败',
  throttle: '限流',
  skipped: '没有执行',
});

export const FAILURE_SHEET_NAME = '发布失败';
export const FAILURE_HEADER = Object.freeze(['序号', '参考SKU', '商品名称', '上架参考链接', '结果', '失败原因', '发布时间']);
const FAILURE_WIDTHS = [6, 16, 46, 42, 16, 60, 18];
const FAILURE_TEXT_COLUMNS = [1, 3];

/** 没轮到的商品：为什么没执行 */
function skipReason({ paused, stopped, aborted, pauseReason }) {
  if (aborted) return '任务异常中止，没有发布这个商品';
  if (paused) return `任务暂停（${pauseReason || '需要人工处理'}），没有发布这个商品`;
  if (stopped) return '任务被停止，没有发布这个商品';
  return '没有发布这个商品';
}

const toEntry = (r) => ({ ...r, skus: r.skus ?? [], statusText: STATUS_TEXT[r.status] ?? r.status, reason: r.message ?? '' });

/** 任务列表里还在、但这轮没轮到的商品 → 结果 */
function skippedEntry(item, why) {
  return toEntry({ id: item.id, status: 'skipped', message: why, title: item.edits?.title || item.product?.title || '', refUrl: item.url ?? '', skus: [] });
}

/**
 * @param {{ids: string[], results: PublishResult[], items?: object[], paused?: boolean, stopped?: boolean, aborted?: boolean, pauseReason?: string}} run
 *   items：任务结束后的任务列表（没轮到的商品从这里取名称和链接；不在列表里的视为已删掉，不算）
 * @returns {PublishReport}
 */
export function publishReport({ ids, results, items = [], paused = false, stopped = false, aborted = false, pauseReason = '' }) {
  const byResult = new Map((results ?? []).map((r) => [r.id, r]));
  const byItem = new Map(items.map((i) => [i.id, i]));
  const why = skipReason({ paused, stopped, aborted, pauseReason });
  const entries = [...new Set(ids ?? [])]
    .map((id) => (byResult.has(id) ? toEntry(byResult.get(id)) : byItem.has(id) ? skippedEntry(byItem.get(id), why) : null))
    .filter(Boolean);
  return {
    total: entries.length,
    succeeded: entries.filter((e) => e.status === 'published'),
    failed: entries.filter((e) => e.status !== 'published'),
  };
}

/**
 * 失败表格的工作表（给 buildXlsx）
 * @param {ReportEntry[]} failed
 * @param {Date} [now]
 * @returns {import('./xlsx-write.js').SheetSpec}
 */
export function failureSheet(failed, now = new Date()) {
  const time = formatMasterTime(now.getTime());
  const body = failed.map((e, i) => [i + 1, e.id, e.title, e.refUrl, e.statusText, e.reason, time]);
  return { name: FAILURE_SHEET_NAME, rows: [[...FAILURE_HEADER], ...body], widths: FAILURE_WIDTHS, textColumns: FAILURE_TEXT_COLUMNS };
}

const pad = (n) => String(n).padStart(2, '0');

/** 文件名：发布失败-<日期-时间>.xlsx */
export const failureFileName = (now = new Date()) =>
  `发布失败-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}.xlsx`;
