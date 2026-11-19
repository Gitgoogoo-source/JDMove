// 「上传表格」的两个确认弹窗：上架表（加入任务列表并采集）、发布前检查表（保存修改并发布齐全的商品）
import { h, openDialog } from './dom.js';
import { isArchived } from '../shared/brand-folders.js';

const LIST_MAX = 200;
const ROWS_SHOWN = 20;

/** 问题的位置：多张表时带上表名 */
export const whereText = (p) => `${p.sheet ? `「${p.sheet}」` : ''}第 ${p.row} 行`;

function problemList(title, problems) {
  if (!problems.length) return null;
  const shown = problems.slice(0, LIST_MAX);
  return h(
    'div',
    {},
    h('strong', {}, `${title}（${problems.length}）`),
    h('ul', { class: 'import-problems' }, ...shown.map((p) => h('li', { class: p.level ?? 'error' }, `${whereText(p)}：${p.text ?? p.message}`))),
    problems.length > shown.length ? h('small', { class: 'muted' }, `只显示前 ${shown.length} 条`) : null,
  );
}

function dialogShell(title, body, buttons) {
  return h(
    'dialog',
    { class: 'wide' },
    h('form', { method: 'dialog' }, h('div', { class: 'dlg-head' }, title), h('div', { class: 'dlg-body' }, ...body.filter(Boolean)), h('div', { class: 'dlg-foot' }, ...buttons)),
  );
}

/** 上架表里的链接和任务列表对照：新加入 / 已在列表（已采集的直接用）/ 已发布 */
function listingStats(parsed, items) {
  const byId = new Map(items.map((i) => [i.id, i]));
  const known = parsed.links.map((l) => byId.get(l.skuId)).filter(Boolean);
  const archived = known.filter(isArchived).length;
  const tasks = known.filter((i) => !isArchived(i));
  return { fresh: parsed.links.length - known.length, existing: tasks.length, collected: tasks.filter((i) => i.product).length, archived };
}

/**
 * 上架表预览：读到多少个链接、哪些已在任务列表、哪些行有问题；确认后加入任务列表并开始采集
 * @param {{fileName: string, parsed: ReturnType<typeof import('../shared/listing-sheet.js').parseListingBook>, items: object[]}} input
 * @returns {Promise<{recollect: boolean}|null>}
 */
export async function confirmListingUpload({ fileName, parsed, items }) {
  const st = listingStats(parsed, items);
  const recollect = h('input', { type: 'checkbox' });
  const noLinkRows = parsed.noLink.slice(0, ROWS_SHOWN).map(whereText).join('、');
  const lines = [
    `新加入任务列表：${st.fresh} 个（以前发布过的会跳过）`,
    st.existing ? `已在任务列表：${st.existing} 个，其中已采集 ${st.collected} 个（直接用已有的数据，不重新采集）` : '',
    st.archived ? `已发布：${st.archived} 个（跳过）` : '',
    parsed.values.length ? `${parsed.values.length} 个商品带了价格 / ERP / 条形码 / 型号，会写进它们的「编辑」` : '',
    parsed.noLink.length ? `参考链接为空的行：${parsed.noLink.length} 行（${noLinkRows}${parsed.noLink.length > ROWS_SHOWN ? '…' : ''}），不加入` : '',
  ].filter(Boolean);
  const ok = h('button', { value: 'ok', class: 'primary', disabled: !parsed.links.length }, '加入并开始采集');
  const dialog = dialogShell(
    '上传上架表',
    [
      h('p', { class: 'import-summary' }, `${fileName}：在「${parsed.sheets.join('」「')}」里读到 ${parsed.links.length} 个商品链接（一个格子里的多个链接各算一个，同一个链接出现在多行只算一个）`),
      h('ul', {}, ...lines.map((l) => h('li', {}, l))),
      problemList('需要留意的行', parsed.problems),
      h('label', { class: 'check' }, recollect, '已采集过的商品也重新采集（覆盖商品信息和图片，编辑内容保留）'),
      h('p', { class: 'muted' }, '加入后自动开始采集；这批商品都采集完后，自动生成并下载「发布前检查」表（设置了存储位置时另存一份到 存储位置/发布前检查/）。'),
    ],
    [h('button', { value: 'cancel', formnovalidate: true }, '取消'), ok],
  );
  if ((await openDialog(dialog)) !== 'ok') return null;
  return { recollect: recollect.checked };
}

function changesBox(updates, itemsById) {
  if (!updates.length) return null;
  const shown = updates.slice(0, LIST_MAX);
  return h(
    'details',
    {},
    h('summary', {}, `查看修改（${updates.length} 个商品）`),
    h('ul', {}, ...shown.map((u) => h('li', {}, `SKU ${u.id} ${itemsById.get(u.id)?.product?.title?.slice(0, 30) ?? ''}：${u.changes.join('、')}`))),
  );
}

function incompleteBox(incomplete, onDownload) {
  if (!incomplete.length) return null;
  const shown = incomplete.slice(0, LIST_MAX);
  return h(
    'div',
    {},
    h('strong', {}, `还缺东西、这次不发布：${incomplete.length} 个（留在任务列表）`),
    h('ul', { class: 'import-problems' }, ...shown.map((x) => h('li', { class: 'warn' }, `SKU ${x.id} ${x.title.slice(0, 30)}：${x.reason}`))),
    h('button', { type: 'button', onclick: onDownload }, `下载这 ${incomplete.length} 个商品的发布前检查表`),
  );
}

/**
 * 发布前检查表上传后的确认：改了什么、发布哪些、哪些还缺、哪些行没导入
 * @param {{fileName: string, book: object, plan: object, pub: ReturnType<typeof import('../shared/review-workbook-import.js').publishPlan>,
 *   items: object[], notes: string[], onDownloadIncomplete: () => void}} input  notes：表格本身的提醒（不是最新导出的、找不到附表）
 * @returns {Promise<'publish'|'save'|null>}
 */
export async function confirmReviewUpload({ fileName, book, plan, pub, items, notes, onDownloadIncomplete }) {
  const itemsById = new Map(items.map((i) => [i.id, i]));
  const filled = plan.updates.reduce((n, u) => n + u.changes.length, 0);
  const skipped = pub.skipped.length ? `；${pub.skipped.length} 个不发布（${[...new Set(pub.skipped.map((s) => s.reason))].join('、')}）` : '';
  const problems = [...book.errors.map((e) => ({ ...e, level: 'error', text: e.message })), ...plan.problems];
  const publish = h('button', { value: 'publish', class: 'primary', disabled: !pub.ready.length }, `保存并发布 ${pub.ready.length} 个`);
  const save = h('button', { value: 'save', disabled: !plan.updates.length }, '只保存修改');
  const dialog = dialogShell(
    '上传发布前检查表',
    [
      h('p', { class: 'import-summary' }, `${fileName}：读了 ${book.sheets.length} 张表（${book.sheets.join('、')}），${plan.matched.length} 个商品；修改 ${plan.updates.length} 个商品共 ${filled} 项${plan.unchanged ? `，${plan.unchanged} 个没改` : ''}`),
      ...notes.map((n) => h('p', { class: 'import-error' }, n)),
      h('p', {}, h('strong', {}, `齐全、将发布：${pub.ready.length} 个`), skipped),
      changesBox(plan.updates, itemsById),
      incompleteBox(pub.incomplete, onDownloadIncomplete),
      problemList('没有导入的行 / 提醒', problems),
      h('p', { class: 'muted' }, '“保存并发布”：保存表格里的修改，然后在当前窗口新开标签页打开 VC 发布页逐个填写（按设置里的“填写完成后”点“发布商品”，记下京东分配的 SKU）。'),
    ],
    [h('button', { value: 'cancel', formnovalidate: true }, '取消'), save, publish],
  );
  const res = await openDialog(dialog);
  return res === 'publish' || res === 'save' ? res : null;
}
