// 「发布选中」先打开的发布前检查弹窗：每个选中的商品一张卡片，按它的上架模板列出发布页要填的内容，缺的标红、可以直接补；
// 没匹配到模板的可以自己选模板；商品多时下载表格批量填写再导回来。点“保存并发布”才保存修改并发布勾选的商品，
// “只保存修改”只保存不发布。修改存进商品的编辑内容（和「编辑」弹窗同一份），只改插件里的数据
import { h, openDialog } from './dom.js';
import { createReviewCard } from './review-card.js';
import { loadVcCatalog } from '../lib/vc-templates.js';
import { applyTemplateChoice, templateChoices } from '../shared/vc-review.js';
import { parseReviewSheet, planReviewImport, reviewSheets } from '../shared/vc-review-sheet.js';
import { readTableFile } from '../shared/table-file.js';
import { buildXlsx } from '../shared/xlsx-write.js';
import { editsEqual } from '../shared/store.js';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const ACCEPT = '.xlsx,.csv,.tsv,.txt,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv';
const PROBLEMS_MAX = 200;
const DISCARD_CONFIRM = '弹窗里的修改还没保存，确定关闭吗？';

const dateStamp = (d = new Date()) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;

function download(bytes, name) {
  const url = URL.createObjectURL(new Blob([bytes], { type: XLSX_MIME }));
  h('a', { href: url, download: name }).click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/** 弹窗顶部的汇总：齐全 / 缺项 / 没有模板，以及勾选了几个 */
function summaryText(states) {
  const ready = states.filter((s) => s.review.ready).length;
  const noTpl = states.filter((s) => !s.match.template).length;
  const picked = states.filter((s) => s.picked).length;
  return [`共 ${states.length} 个商品`, `齐全 ${ready}`, `有缺项 ${states.length - ready}`, noTpl ? `没有模板 ${noTpl}` : '', `勾选发布 ${picked}`].filter(Boolean).join(' · ');
}

function importReport(box, fileName, res) {
  const { plan } = res;
  const filled = plan.updates.reduce((n, u) => n + u.changes.length, 0);
  const notes = [res.sheet.blank ? `${res.sheet.blank} 行没填值` : '', plan.unchanged ? `${plan.unchanged} 个和现在一样` : ''].filter(Boolean);
  const problems = [...res.sheet.errors.map((p) => ({ ...p, level: 'error', text: p.message })), ...plan.problems].sort((a, b) => a.row - b.row);
  box.replaceChildren(
    ...[
      h('p', { class: 'import-summary' }, `${fileName}：填入 ${plan.updates.length} 个商品共 ${filled} 项${notes.length ? `（${notes.join('，')}）` : ''}。还没保存，核对后点“保存并发布”或“只保存修改”。`),
      problems.length
        ? h('ul', { class: 'import-problems' }, ...problems.slice(0, PROBLEMS_MAX).map((p) => h('li', { class: p.level }, `第 ${p.row} 行：${p.text}`)))
        : null,
      problems.length > PROBLEMS_MAX ? h('small', { class: 'muted' }, `只显示前 ${PROBLEMS_MAX} 条，还有 ${problems.length - PROBLEMS_MAX} 条没显示：请分批导入，或先改好前面的行`) : null,
    ].filter(Boolean),
  );
  box.hidden = false;
}

/** 表格：下载这批商品的填写表 / 选择填好的表导回弹窗（只改弹窗里的内容，保存时才写进插件） */
function sheetTools({ items, drafts, cards, catalog, settings, onLog, onImported }) {
  const report = h('div', { class: 'rv-report', hidden: true });
  const file = h('input', { type: 'file', accept: ACCEPT, hidden: true });
  const rows = () => items.map((item, i) => ({ item, edits: drafts.get(item.id), ...cards[i].state() }));
  const downloadBtn = h('button', { type: 'button' }, '下载填写表格');
  downloadBtn.addEventListener('click', () => {
    download(buildXlsx(reviewSheets({ rows: rows(), catalog })), `发布前检查填写表-${dateStamp()}.xlsx`);
    onLog(`发布前检查：已下载填写表格（${items.length} 个商品）`);
  });
  file.addEventListener('change', async () => {
    const f = file.files?.[0];
    file.value = '';
    if (!f) return;
    try {
      const sheet = parseReviewSheet((await readTableFile(new Uint8Array(await f.arrayBuffer()))).rows);
      if (sheet.error) throw new Error(sheet.error);
      const plan = planReviewImport(sheet.entries, { items, drafts, catalog, settings });
      plan.updates.forEach((u) => drafts.set(u.id, u.edits));
      onImported(new Set(plan.updates.map((u) => u.id)));
      importReport(report, f.name, { sheet, plan });
      onLog(`发布前检查：表格 ${f.name} 填入 ${plan.updates.length} 个商品，${plan.problems.length} 行有问题`);
    } catch (e) {
      report.replaceChildren(h('p', { class: 'import-error' }, `${f.name}：${e.message}`));
      report.hidden = false;
    }
  });
  const importBtn = h('button', { type: 'button', onclick: () => file.click() }, '导入填好的表格');
  return { node: h('div', { class: 'rv-tools' }, downloadBtn, importBtn, file), report };
}

/** 批量设模板：把没有模板的商品都设成同一个模板 */
function bulkTemplate({ items, drafts, cards, catalog, onDone }) {
  const select = h(
    'select',
    {},
    h('option', { value: '' }, '选择模板…'),
    ...templateChoices(catalog).map((g) => h('optgroup', { label: g.group }, ...g.options.map((o) => h('option', { value: o.value }, o.label)))),
  );
  const btn = h('button', { type: 'button' }, '设给没有模板的商品');
  btn.addEventListener('click', () => {
    if (!select.value) return select.focus();
    const targets = items.filter((_, i) => !cards[i].state().match.template);
    targets.forEach((item) => drafts.set(item.id, applyTemplateChoice(drafts.get(item.id), catalog, select.value)));
    onDone(new Set(targets.map((i) => i.id)));
  });
  return h('div', { class: 'rv-tools' }, h('span', { class: 'sub' }, '批量设置模板'), select, btn);
}

/**
 * @param {{items: object[], settings: object, onLog: (line: string) => void}} opts items：要发布的商品（都已采集）
 * @returns {Promise<{changes: {id: string, before: object, edits: object}[], publishIds: string[]} | null>} 取消时为 null；
 *   changes：编辑内容有变化的商品（before 为弹窗打开时的编辑内容，保存时用 rebaseEdits 合并）；
 *   publishIds：要发布的商品（点“只保存修改”时为空）
 */
export async function openPublishReview({ items, settings, onLog }) {
  const { catalog, errors } = await loadVcCatalog();
  errors.forEach(onLog);
  const drafts = new Map(items.map((i) => [i.id, i.edits ?? {}]));
  const summary = h('div', { class: 'rv-summary' });
  const publishBtn = h('button', { type: 'button', class: 'primary' }, '保存并发布');
  const dirty = () => items.some((i) => !editsEqual(i.edits, drafts.get(i.id)));
  const update = () => {
    const states = cards.map((c) => c.state());
    summary.textContent = summaryText(states);
    const n = states.filter((s) => s.picked).length;
    publishBtn.textContent = `保存并发布勾选的 ${n} 个`;
    publishBtn.disabled = n === 0;
  };
  const cards = [];
  items.forEach((item) => {
    cards.push(createReviewCard({ item, catalog, settings, getEdits: () => drafts.get(item.id), setEdits: (e) => drafts.set(item.id, e), onChange: () => cards.length === items.length && update() }));
  });
  const rebuildSome = (ids) => {
    items.forEach((item, i) => ids.has(item.id) && cards[i].rebuild());
    update();
  };
  const ctx = { items, drafts, cards, catalog, settings, onLog };
  const sheet = sheetTools({ ...ctx, onImported: rebuildSome });

  const dialog = h('dialog', { class: 'wide review' });
  const finish = (value) => {
    const bad = cards.find((c) => c.invalidInput());
    if (bad) {
      bad.expand();
      bad.invalidInput().reportValidity();
      return;
    }
    dialog.close(value);
  };
  const pickAll = (on) => {
    cards.forEach((c) => c.setPicked(on && c.state().review.ready));
    update();
  };
  dialog.append(
    h(
      'form',
      { method: 'dialog' },
      h('div', { class: 'dlg-head' }, `发布前检查（${items.length} 个商品）`),
      h(
        'div',
        { class: 'dlg-body' },
        h('p', { class: 'muted' }, '按每个商品的上架模板列出发布页要填的内容：红色是缺的或填不上的，橙色是用了默认值/推断、请核对。没自己填的项显示发布时会用的值（灰色提示）。在这里填的内容保存到商品的「编辑」里，只改插件里的数据。'),
        h('div', { class: 'rv-bar' }, summary, bulkTemplate({ ...ctx, onDone: rebuildSome }), sheet.node, h('div', { class: 'rv-tools' }, h('button', { type: 'button', class: 'link', onclick: () => pickAll(true) }, '只勾选齐全的'), h('button', { type: 'button', class: 'link', onclick: () => pickAll(false) }, '全不勾选'))),
        sheet.report,
        ...cards.map((c) => c.node),
      ),
      h(
        'div',
        { class: 'dlg-foot' },
        h('button', { type: 'button', onclick: () => (!dirty() || confirm(DISCARD_CONFIRM)) && dialog.close('cancel') }, '取消'),
        h('button', { type: 'button', onclick: () => finish('save') }, '只保存修改'),
        publishBtn,
      ),
    ),
  );
  publishBtn.addEventListener('click', () => finish('publish'));
  // 有修改时按 Esc / 取消先确认，免得填了半天一下关掉
  dialog.addEventListener('cancel', (e) => dirty() && !confirm(DISCARD_CONFIRM) && e.preventDefault());
  update();
  const result = await openDialog(dialog);
  if (result !== 'save' && result !== 'publish') return null;
  const changes = items.filter((i) => !editsEqual(i.edits, drafts.get(i.id))).map((i) => ({ id: i.id, before: i.edits ?? {}, edits: drafts.get(i.id) }));
  const publishIds = result === 'publish' ? items.filter((_, i) => cards[i].state().picked).map((i) => i.id) : [];
  return { changes, publishIds };
}
