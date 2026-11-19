// 上传的表格（纯函数）：认出是上架表还是发布前检查表；发布前检查表读出所有附表里的商品行，
// 导入后按新的编辑内容检查，齐全的发布、还缺东西的不发布（留在任务列表）
import { BASE_SHEET, META_SHEET, REVIEW_BOOK_FORMAT } from './review-workbook.js';
import { parseReviewSheet, REVIEW_HEADER_MISSING } from './vc-review-sheet.js';
import { parseListingBook } from './listing-sheet.js';
import { buildReview, reviewTemplate } from './vc-review.js';
import { isArchived } from './brand-folders.js';

export const UNKNOWN_TABLE =
  '认不出这个表格：上架表要有一列表头以“参考链接”开头；发布前检查表请上传插件导出的那份（不要删除隐藏的 _meta 工作表，也可以是「表格导入价格/ERP」的表）';
const PUBLISHABLE = new Set(['collected', 'failed', 'need_action']);
const BUSY_REASONS = { pending: '还没采集', collecting: '正在采集', publishing: '正在发布' };
export const TEMPLATE_CHANGED = '换了上架模板，这一轮不发布：请重新生成发布前检查表，核对新模板的属性后再上传';

/** 表格里换了上架模板的商品：新模板的属性列不在这张表里，用户还没看过，这一轮不发布 */
export const templateChangedIds = (updates) => new Map(updates.filter((u) => u.changes.includes('上架模板')).map((u) => [u.id, TEMPLATE_CHANGED]));

/**
 * 插件导出的发布前检查表里隐藏的 _meta 表
 * @param {{name: string, rows: string[][]}[]} sheets
 * @returns {{batchId: string, source: string, exportedAt: string, editable: string[]}|null}
 */
export function readBookMeta(sheets) {
  const meta = sheets.find((s) => s.name === META_SHEET);
  const pairs = (meta?.rows ?? []).slice(1).filter((r) => r?.[0]);
  const get = (k) => String(pairs.find((r) => r[0] === k)?.[1] ?? '');
  if (get('format') !== REVIEW_BOOK_FORMAT) return null;
  return { batchId: get('batchId'), source: get('source'), exportedAt: get('exportedAt'), editable: pairs.filter((r) => r[0] === 'editable').map((r) => String(r[1] ?? '')) };
}

/**
 * 导出时每个商品每个格子写的值（隐藏的 _base 表）：上传时和它一样的格子不算修改。旧表没有时为空
 * @returns {Map<string, {template: string, values: Map<string, string>}>}
 */
export function readBookBase(sheets) {
  const base = sheets.find((s) => s.name === BASE_SHEET);
  const out = new Map();
  for (const [sku, json] of (base?.rows ?? []).slice(1)) {
    try {
      const data = JSON.parse(json);
      out.set(String(sku), { template: String(data.template ?? ''), values: new Map(Object.entries(data.values ?? {}).map(([k, v]) => [k, String(v)])) });
    } catch {
      // 被改坏的行：这个商品按现在的值比较
    }
  }
  return out;
}

/**
 * 上传的表格是哪一种：发布前检查表（有 _meta，或旧的单表格式/价格ERP表）、上架表（有“参考链接”列）
 * @returns {{kind: 'review'|'listing'|null, meta?: object|null, error?: string}}
 */
export function workbookKind(sheets) {
  const meta = readBookMeta(sheets);
  if (meta) return { kind: 'review', meta };
  if (!parseListingBook(sheets).error) return { kind: 'listing' };
  if (sheets.some((s) => !s.hidden && !parseReviewSheet(s.rows).error)) return { kind: 'review', meta: null };
  return { kind: null, error: UNKNOWN_TABLE };
}

/**
 * 发布前检查表里所有附表的商品行（汇总、可选值、填写说明这些表没有可填写的列，自动跳过）
 * @returns {{entries: object[], errors: {sheet: string, row: number, message: string}[], blank: number, sheets: string[],
 *   lost: string[], meta: object|null, base: ReturnType<typeof readBookBase>, error?: string}}
 *   lost：导出时有、上传的文件里找不到的附表（改了名字或删了）；base：导出时写的值（给 planReviewImport）
 */
export function parseReviewBook(sheets) {
  const meta = readBookMeta(sheets);
  const parsed = sheets.filter((s) => !s.hidden && !s.error).map((s) => ({ name: s.name, ...parseReviewSheet(s.rows, { sheet: s.name }) }));
  const used = parsed.filter((p) => !p.error);
  const lost = (meta?.editable ?? []).filter((n) => !sheets.some((s) => s.name === n));
  if (!used.length) return { entries: [], errors: [], blank: 0, sheets: [], lost, meta, base: new Map(), error: REVIEW_HEADER_MISSING };
  return {
    base: readBookBase(sheets),
    entries: used.flatMap((p) => p.entries),
    errors: used.flatMap((p) => p.errors),
    blank: used.reduce((n, p) => n + p.blank, 0),
    sheets: used.map((p) => p.name),
    lost,
    meta,
  };
}

/**
 * 导入后发布哪些：表格里导入了的商品，按导入后的编辑内容检查（和发布前检查弹窗同一套规则），齐全的发布
 * @param {{ids: string[], items: object[], drafts: Map<string, object>, catalog: object, settings: object, held?: Map<string, string>}} input
 *   ids：表格里导入了的商品；drafts：导入后的编辑内容（没有修改的商品用它自己的）；held：这一轮不发布的商品和原因（如换了模板）
 * @returns {{ready: string[], incomplete: {id: string, title: string, problems: string[], reason: string}[], skipped: {id: string, reason: string}[]}}
 *   incomplete.reason：这次不发布的原因（缺什么，或换了模板）
 */
export function publishPlan({ ids, items, drafts, catalog, settings, held = new Map() }) {
  const byId = new Map(items.map((i) => [i.id, i]));
  const out = { ready: [], incomplete: [], skipped: [] };
  for (const id of new Set(ids)) {
    const item = byId.get(id);
    if (!item || isArchived(item)) out.skipped.push({ id, reason: '已发布' });
    else if (!item.product) out.skipped.push({ id, reason: '还没采集' });
    else if (!PUBLISHABLE.has(item.status)) out.skipped.push({ id, reason: BUSY_REASONS[item.status] ?? '状态不对' });
    else if (held.has(id)) out.incomplete.push({ id, title: drafts.get(id)?.title || item.product.title || '', problems: [], reason: held.get(id) });
    else {
      const edits = drafts.get(id) ?? item.edits ?? {};
      const { template } = reviewTemplate({ product: item.product, edits, settings, catalog });
      const review = buildReview({ product: item.product, edits, settings, template });
      if (review.ready) out.ready.push(id);
      else {
        const problems = review.problems.length ? review.problems : review.blockers;
        out.incomplete.push({ id, title: edits.title || item.product.title || '', problems, reason: `缺 ${problems.join('、')}` });
      }
    }
  }
  return out;
}
