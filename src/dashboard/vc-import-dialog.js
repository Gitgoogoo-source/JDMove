// “表格导入价格/ERP”弹窗：下载模板 → 选择填好的表格 → 预览每个商品要改什么、哪些行有问题 → 导入。
// 只在预览里有可修改的商品时才能点“导入”；导入只改插件里的编辑内容，不会动店铺后台
import { h, openDialog } from './dom.js';
import { readTableFile } from '../shared/table-file.js';
import { parseVcSheet, planVcImport, vcTemplateSheets } from '../shared/vc-import.js';
import { buildXlsx } from '../shared/xlsx-write.js';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
// 预览里最多显示多少行修改 / 问题（全部数量写在摘要里）
const PREVIEW_MAX = 300;
const ACCEPT = '.xlsx,.csv,.tsv,.txt,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv';

const dateStamp = (d = new Date()) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;

function downloadTemplate(list, onLog) {
  const url = URL.createObjectURL(new Blob([buildXlsx(vcTemplateSheets(list))], { type: XLSX_MIME }));
  h('a', { href: url, download: `VC价格ERP填写模板-${dateStamp()}.xlsx` }).click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  onLog(`已下载表格模板（${list.length} 个商品）`);
}

/**
 * 弹窗里展示的所有问题：表格本身的错误、和任务列表对不上的、毛利提醒，按行号排序
 * @returns {{row: number, level: 'error'|'warn', text: string}[]}
 */
export function importProblems(sheet, plan) {
  const sku = (p) => (p.skuId ? `（SKU ${p.skuId}）` : '');
  return [
    ...sheet.errors.map((p) => ({ row: p.row, level: 'error', text: `${p.message}${sku(p)}` })),
    ...plan.errors.map((p) => ({ row: p.row, level: 'error', text: `${p.message}${sku(p)}` })),
    ...plan.missing.map((p) => ({ row: p.row, level: 'error', text: `任务列表里没有这个商品${sku(p)}，请先用“添加链接”把它加进来再导入` })),
    ...plan.warnings.map((p) => ({ row: p.row, level: 'warn', text: `${p.message}${sku(p)}` })),
  ].sort((a, b) => a.row - b.row);
}

/** 不修改的行分别是什么情况 */
export function importNotes(sheet, plan) {
  const bad = sheet.errors.length + plan.errors.length + plan.missing.length;
  return [
    plan.unchanged.length ? `${plan.unchanged.length} 个和现在一样` : '',
    sheet.blank ? `${sheet.blank} 行没填值（不修改）` : '',
    plan.archived.length ? `${plan.archived.length} 个已发布（不修改）` : '',
    bad ? `${bad} 行有问题没有导入` : '',
    plan.warnings.length ? `${plan.warnings.length} 个需要核对` : '',
  ].filter(Boolean);
}

/** 摘要：会改多少个，其余的分别是什么情况 */
export function importSummary(sheet, plan) {
  const notes = importNotes(sheet, plan);
  return `将修改 ${plan.updates.length} 个商品${notes.length ? `；${notes.join('，')}` : ''}`;
}

const changeText = (c) => `${c.label} ${c.from || '（空）'} → ${c.to || '（空）'}`;

function changesTable(updates) {
  const shown = updates.slice(0, PREVIEW_MAX);
  return h(
    'table',
    { class: 'items plan' },
    h('thead', {}, h('tr', {}, ...['行', '商品', '修改内容'].map((t) => h('th', {}, t)))),
    h(
      'tbody',
      {},
      ...shown.map((u) =>
        h(
          'tr',
          {},
          h('td', {}, String(u.row)),
          h('td', {}, h('div', { class: 'title clamp' }, u.title || `SKU ${u.skuId}`), h('div', { class: 'sub' }, `SKU ${u.skuId}`)),
          h('td', {}, ...u.changes.map((c) => h('div', {}, changeText(c)))),
        ),
      ),
    ),
    updates.length > shown.length ? h('caption', { class: 'muted' }, `只显示前 ${shown.length} 个，共 ${updates.length} 个`) : null,
  );
}

function problemList(problems) {
  if (!problems.length) return null;
  const shown = problems.slice(0, PREVIEW_MAX);
  return h(
    'div',
    {},
    h('strong', {}, `需要处理的行（${problems.length}）`),
    h('ul', { class: 'import-problems' }, ...shown.map((p) => h('li', { class: p.level }, `第 ${p.row} 行：${p.text}`))),
    problems.length > shown.length ? h('small', { class: 'muted' }, `只显示前 ${shown.length} 条`) : null,
  );
}

function renderPreview(box, fileName, sheet, plan) {
  if (sheet.error) return box.replaceChildren(h('p', { class: 'import-error' }, `${fileName}：${sheet.error}`));
  const problems = importProblems(sheet, plan);
  return box.replaceChildren(
    h('p', { class: 'import-summary' }, `${fileName}：识别到 ${sheet.columns.join('、')} 列。${importSummary(sheet, plan)}`),
    plan.updates.length ? changesTable(plan.updates) : null,
    problemList(problems),
  );
}

/**
 * @param {{items: object[], templateItems: object[], onLog: (line: string) => void}} opts
 *   items：全部条目（用来对照）；templateItems：模板里列出的商品
 * @returns {Promise<{updates: object[], notes: string[], problems: object[]} | null>} 点了“导入”时返回要修改的商品
 */
export async function openVcImportDialog({ items, templateItems, onLog }) {
  let current = null;
  const fileInput = h('input', { type: 'file', accept: ACCEPT });
  const preview = h('div', { class: 'import-preview' }, h('p', { class: 'muted' }, '还没有选择表格文件'));
  const okBtn = h('button', { value: 'ok', class: 'primary', disabled: true }, '导入');
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    current = null;
    okBtn.disabled = true;
    okBtn.textContent = '导入';
    if (!file) return;
    preview.replaceChildren(h('p', { class: 'muted' }, `正在读取 ${file.name}…`));
    try {
      const { rows } = await readTableFile(new Uint8Array(await file.arrayBuffer()));
      const sheet = parseVcSheet(rows);
      const plan = sheet.error ? null : planVcImport(sheet.entries, items);
      renderPreview(preview, file.name, sheet, plan);
      if (!plan) return;
      current = { updates: plan.updates, notes: importNotes(sheet, plan), problems: importProblems(sheet, plan) };
      okBtn.disabled = plan.updates.length === 0;
      okBtn.textContent = plan.updates.length ? `导入（修改 ${plan.updates.length} 个商品）` : '没有需要修改的商品';
    } catch (e) {
      preview.replaceChildren(h('p', { class: 'import-error' }, `${file.name} 读取失败：${e.message}`));
      onLog(`表格导入：${file.name} 读取失败：${e.message}`);
    }
  });
  const templateBtn = h(
    'button',
    { type: 'button', disabled: !templateItems.length, onclick: () => downloadTemplate(templateItems, onLog) },
    templateItems.length ? `下载模板（${templateItems.length} 个商品）` : '下载模板（任务列表里没有商品）',
  );
  const dialog = h(
    'dialog',
    { class: 'wide' },
    h(
      'form',
      { method: 'dialog' },
      h('div', { class: 'dlg-head' }, '表格导入：市场价 / 京东价 / 采购价 / 采购员ERP / 销售员ERP'),
      h(
        'div',
        { class: 'dlg-body' },
        h(
          'p',
          { class: 'muted' },
          '按表格里的“商品链接”找到任务列表里的商品，把这 5 项写到该商品的「编辑 → VC 自营」里（只改插件里的数据，不动店铺后台）。空着的格子不修改；一行里有一个值不对，这一行就不导入。',
        ),
        h(
          'div',
          { class: 'import-step' },
          h('strong', {}, '① 下载模板'),
          templateBtn,
          h('small', { class: 'muted' }, '模板列出任务列表里的商品（勾选了就只列勾选的），已经填过的值会预先填好；用 Excel 或 WPS 打开填写后保存。'),
        ),
        h(
          'label',
          { class: 'import-step' },
          h('strong', {}, '② 选择填好的表格'),
          fileInput,
          h('small', { class: 'muted' }, '支持 .xlsx 和 .csv（UTF-8 / GBK 编码都可以）；读第一个工作表，第一行是表头。'),
        ),
        preview,
      ),
      h('div', { class: 'dlg-foot' }, h('button', { value: 'cancel', formnovalidate: true }, '取消'), okBtn),
    ),
  );
  if ((await openDialog(dialog)) !== 'ok' || !current?.updates.length) return null;
  return current;
}
