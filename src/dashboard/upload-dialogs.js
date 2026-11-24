// 「上传表格」的确认弹窗：采集缺少数据的商品，或保存发布前检查表的修改并发布。
import { h, openDialog } from './dom.js';

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

/** 列出上架表里缺少采集记录的商品，确认后才开始采集。 */
export async function confirmMissingCollection({ fileName, parsed, missing, notes }) {
  const noLinkRows = parsed.noLink.slice(0, ROWS_SHOWN).map(whereText).join('、');
  const rows = missing.map((link) =>
    h('li', {}, `${link.refs.map(whereText).join('、')} · SKU ${link.skuId}${link.label ? ` · ${link.label}` : ''} · ${link.url}`),
  );
  const dialog = dialogShell(
    '存在未采集商品，是否采集？',
    [
      h('p', { class: 'import-summary' }, `「${fileName}」共 ${parsed.links.length} 个商品，已匹配 ${parsed.links.length - missing.length} 个，未找到采集记录 ${missing.length} 个。`),
      ...notes.map((note) => h('p', { class: 'muted' }, note)),
      h('ol', { class: 'import-problems' }, rows),
      parsed.noLink.length ? h('p', { class: 'muted' }, `有 ${parsed.noLink.length} 行的参考链接为空（${noLinkRows}${parsed.noLink.length > ROWS_SHOWN ? '…' : ''}）。`) : null,
      problemList('需要留意的行', parsed.problems),
      h('p', { class: 'muted' }, '确认后采集下列商品，结束后为这张上架表生成「发布前检查表」。'),
    ],
    [h('button', { value: 'cancel', formnovalidate: true }, '取消'), h('button', { value: 'collect', class: 'primary' }, `采集 ${missing.length} 个商品`)],
  );
  return (await openDialog(dialog)) === 'collect';
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
