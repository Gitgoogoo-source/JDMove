// 「发布前检查」表（纯函数）：采集到的商品按上架模板分到不同的附表（附表1-抽纸、附表2-调和油……），
// 每张附表的列是这个模板发布页要填的内容（基本信息、价格与采销、包装与物流、这个模板自己的商品属性和 SKU属性），
// 格子里写发布时会用的值（自己填的 > 采集到的 > 推断/默认值），红底是缺的或填不上的，橙底是默认值/推断请核对。
// 另有汇总（上架表里每个链接的采集和检查结果）、未匹配模板、可选值、填写说明，和插件自己用的两张隐藏表：
// _meta（认出这是发布前检查表）、_base（导出时每个格子写的值：上传时和它一样的格子不算修改，
// 导出之后在插件里改的内容、重新采集到的数据不会被这份旧表冲掉）。读回见 vc-review-sheet.js
import { REVIEW_FIELDS, templateChoices } from './vc-review.js';
import { HEAD, attrFormat, sheetLabel, templateAttrs, templateCell } from './vc-review-sheet.js';
import { attrKey } from './vc-review-attrs.js';
import { vcTemplateLeafLabel } from './vc-templates.js';
import { safeSheetNames } from './xlsx-write.js';

export const REVIEW_BOOK_FORMAT = 'jdmove-review-v1';
export const META_SHEET = '_meta';
export const BASE_SHEET = '_base';
export const SUMMARY_SHEET = '汇总';
export const NO_TEMPLATE_SHEET = '未匹配模板';
const OPTIONS_SHEET = '可选值';
const NOTES_SHEET = '填写说明';
const FIELD_FILL = { missing: 'error', error: 'error', default: 'warn', warn: 'warn' };
const ATTR_FILL = { missing: 'error', error: 'error', guess: 'warn', warn: 'warn' };
const FIXED_WIDTHS = [40, 16, 36, 28, 22];
const SUMMARY_HEADER = ['上架表位置', '参考说明', '商品链接', 'SKU', '源商品标题', '采集结果', '使用的模板', '所在工作表', '检查结果', '缺少 / 请核对'];

/**
 * @typedef {{item: object, edits: object, match: {template: object|null, category: object|null, from: string|null},
 *   review: import('./vc-review.js').Review}} ReviewRow
 */

const templateKey = (t) => (t ? `${t.categoryId}:${t.publishCategoryId}` : '');
const worst = (fills) => (fills.includes('error') ? 'error' : fills.includes('warn') ? 'warn' : null);

/** 附表名里的模板名：末级三级类目是类目名，抽纸这类写成“抽纸-悬挂式抽纸” */
function shortName(t) {
  if (t.isLeaf || !t.publishCategoryName || t.publishCategoryName === t.categoryName) return t.categoryName;
  return `${t.categoryName}-${t.publishCategoryName}`;
}

/** 模板的属性列：同名的只列一列（编辑里的属性覆盖按名字存），有一个必填就算必填 */
function attrColumns(template) {
  const all = templateAttrs(template);
  const titles = [...new Set(all.map((a) => a.title))];
  return titles.map((title) => {
    const same = all.filter((a) => a.title === title);
    return { title, where: same[0].where, required: same.some((a) => a.required) };
  });
}

function fieldCell(f) {
  const numeric = f.input === 'number' && f.value !== '' && Number.isFinite(Number(f.value));
  return { value: numeric ? Number(f.value) : f.value, fill: FIELD_FILL[f.state] ?? null };
}

/** 属性格子：同名属性取第一个有值的；SKU属性不填写（设置里关了）时不标颜色 */
function attrCell(review, title) {
  const cands = [...review.props.filter((a) => a.title === title).map((a) => ({ a, sku: false })), ...review.skuAttrs.filter((a) => a.title === title).map((a) => ({ a, sku: true }))];
  const value = cands.find((c) => c.a.value)?.a.value ?? '';
  const fills = cands.filter((c) => !c.sku || review.skuAttrsOn).map((c) => ATTR_FILL[c.a.state] ?? null);
  return { value, fill: worst(fills) };
}

function fixedCells({ item, match, review }, catalog, templateFill) {
  return [
    { value: item.url },
    { value: item.skuId },
    { value: item.product?.title ?? '' },
    { value: review.problems.join('、') },
    { value: templateCell(catalog, match), fill: templateFill },
  ];
}

/** 一张附表（或“未匹配模板”表）：表头、每个商品一行、底色 */
function productSheet(name, template, rows, catalog) {
  const attrs = template ? attrColumns(template) : [];
  const header = [
    HEAD.link,
    HEAD.sku,
    HEAD.sourceTitle,
    HEAD.missing,
    `${template ? '' : '*'}${HEAD.template}`,
    ...REVIEW_FIELDS.map((f) => `${f.required ? '*' : ''}${sheetLabel(f)}`),
    ...attrs.map((a) => `${a.required ? '*' : ''}${a.where}:${a.title}`),
  ];
  const keys = [...REVIEW_FIELDS.map((f) => f.key), ...attrs.map((a) => attrKey(a.title))];
  const body = rows.map((r) => [
    ...fixedCells(r, catalog, template ? null : 'error'),
    ...REVIEW_FIELDS.map((def) => fieldCell(r.review.fields.find((f) => f.key === def.key))),
    ...attrs.map((a) => attrCell(r.review, a.title)),
  ]);
  const fixed = FIXED_WIDTHS.length;
  // 导出时每个格子写的值（上传时用来判断改没改）
  const base = rows.map((r, i) => [
    r.item.id,
    JSON.stringify({ template: String(body[i][fixed - 1].value ?? ''), values: Object.fromEntries(keys.map((k, c) => [k, String(body[i][fixed + c].value ?? '')])) }),
  ]);
  const fieldStart = FIXED_WIDTHS.length;
  const attrStart = fieldStart + REVIEW_FIELDS.length;
  const textColumns = [1, ...REVIEW_FIELDS.map((f, i) => (f.input === 'text' ? fieldStart + i : -1)).filter((i) => i >= 0), ...attrs.map((_, i) => attrStart + i)];
  return {
    base,
    name,
    rows: [header, ...body.map((cells) => cells.map((c) => c.value))],
    cellStyles: [[], ...body.map((cells) => cells.map((c) => c.fill))],
    widths: [...FIXED_WIDTHS, ...REVIEW_FIELDS.map((f) => (f.key === 'title' ? 36 : 14)), ...attrs.map(() => 16)],
    textColumns,
  };
}

/** 按模板分组（按商品出现的顺序），没有模板的单独一组 */
function groupRows(rows) {
  const groups = new Map();
  const none = [];
  for (const r of rows) {
    const t = r.match.template;
    if (!t) none.push(r);
    else groups.set(templateKey(t), { template: t, rows: [...(groups.get(templateKey(t))?.rows ?? []), r] });
  }
  return { groups: [...groups.values()], none };
}

function refText(refs, multiSheet) {
  const bySheet = new Map();
  for (const r of refs ?? []) bySheet.set(r.sheet, [...(bySheet.get(r.sheet) ?? []), r.row]);
  return [...bySheet].map(([sheet, nums]) => `${multiSheet ? `${sheet} ` : ''}第 ${nums.join('、')} 行`).join('；');
}

/** 没进到附表的商品，采集结果写什么 */
function collectText(item, inBatch) {
  if (!item) return inBatch ? '已发布（写进了上架总表）或已从任务列表删除' : '已发布过，没有加入任务列表';
  if (['pending', 'collecting'].includes(item.status)) return '待采集';
  if (!item.product) return `采集失败：${item.message || '原因未知'}`;
  return item.message || '已采集';
}

function summaryRow(entry, ctx) {
  const row = ctx.rowsById.get(entry.skuId);
  const item = ctx.itemsById.get(entry.skuId) ?? row?.item;
  const base = [refText(entry.refs, ctx.multiSheet), entry.label ?? '', entry.url, entry.skuId, item?.product?.title ?? '', collectText(item, ctx.inBatch(entry.skuId))];
  if (!row) return { cells: [...base, '', '', '没有检查', ''], fill: item?.product ? null : 'warn' };
  const { review, match } = row;
  const checks = review.checks ? `请核对 ${review.checks} 项（橙色）` : '';
  const missing = [review.problems.join('、'), checks].filter(Boolean).join('；');
  const template = match.template ? vcTemplateLeafLabel(match.template) : '没有匹配到模板';
  const result = review.ready ? '齐全' : `缺 ${review.problems.length} 项`;
  return { cells: [...base, template, ctx.sheetOf.get(entry.skuId) ?? '', result, missing], fill: review.ready ? null : 'error' };
}

function summarySheet(name, entries, ctx) {
  const rows = entries.map((e) => summaryRow(e, ctx));
  const resultCol = SUMMARY_HEADER.indexOf('检查结果');
  return {
    name,
    rows: [SUMMARY_HEADER, ...rows.map((r) => r.cells)],
    cellStyles: [[], ...rows.map((r) => r.cells.map((_, c) => (c === resultCol ? r.fill : null)))],
    widths: [16, 28, 40, 16, 36, 24, 26, 22, 12, 60],
    textColumns: [3],
  };
}

function optionsSheet(templates) {
  const rows = templates.flatMap((t) => templateAttrs(t).map((a) => [vcTemplateLeafLabel(t), a.title, a.where, a.required ? '必填' : '', attrFormat(a)]));
  return { name: OPTIONS_SHEET, rows: [['上架模板', '属性', '位置', '必填', '可选值 / 填写格式'], ...rows], widths: [22, 20, 12, 8, 90] };
}

function notesSheet(catalog) {
  const choices = templateChoices(catalog).flatMap((g) => g.options.map((o) => o.label));
  const lines = [
    '发布前检查表：插件按上架模板把商品分到不同的附表，每张附表的列是这个模板发布页要填的内容',
    '1. 格子里是发布时会用的值：你填过的 > 采集到的 > 推断/默认值。红底是缺的或填不上的（必填没有值、超出类目范围、下拉值不对），橙底是用了默认值或推断，请核对。表头带 * 的是必填。',
    '2. 直接在附表里改、补；不改的格子保持原样，空着的格子表示用插件的自动值（不会清空）。和插件算出来的值一样的格子不算修改。',
    '3. “汇总”表是上架表里每个链接的采集和检查结果，只用来核对，上传时不读。“还缺”“源商品标题”列也不读。',
    `4. “上架模板”列可以改成别的模板（换了模板的商品这一轮不发布：新模板的属性列不在这张表里，请上传后重新生成发布前检查表核对新模板的属性）。可选：${choices.join('、')}；填“自动”改回按源商品类目匹配。`,
    '5. “未匹配模板”表里的商品没有找到上架模板，在“上架模板”列填上模板名，上传后再导出一次补属性。',
    '6. 下拉类属性要填“可选值”表里的值；纸张尺寸这类多段数字写成“195×133”。价格：市场价、京东价最多 2 位小数，采购价最多 4 位，京东价不能高于市场价。ERP 填账号，不是姓名。',
    '7. 一行里有一个值不对，这一行都不导入（上传后会写明哪张表第几行、为什么）。',
    '8. 改好后在插件任务面板点“上传表格”选这个文件：插件保存修改，发布齐全的商品（点“发布商品”）；还缺东西的商品不发布，留在任务列表。',
    '9. 不要改工作表名，也不要删除隐藏的 _meta、_base 表（插件靠它们认出这是发布前检查表、判断哪些格子改过）。',
  ];
  return { name: NOTES_SHEET, rows: lines.map((l) => [l]), widths: [140] };
}

/**
 * 生成发布前检查表
 * @param {{rows: ReviewRow[], catalog: object, items?: object[], batch?: import('./batch.js').Batch|null, now?: Date}} input
 *   rows：要检查的已采集商品（按上架表的顺序）；items：任务条目（汇总里写没采集到的商品的原因）；batch：上架表批次（汇总按上架表的链接列）
 * @returns {import('./xlsx-write.js').SheetSpec[]}
 */
export function reviewWorkbook({ rows, catalog, items = [], batch = null, now = new Date() }) {
  const { groups, none } = groupRows(rows);
  const productNames = [...groups.map((g, i) => `附表${i + 1}-${shortName(g.template)}`), ...(none.length ? [NO_TEMPLATE_SHEET] : [])];
  const [summaryName, ...names] = safeSheetNames([SUMMARY_SHEET, ...productNames]);
  const parts = [...groups.map((g, i) => ({ name: names[i], template: g.template, rows: g.rows })), ...(none.length ? [{ name: names.at(-1), template: null, rows: none }] : [])];
  const sheetOf = new Map(parts.flatMap((p) => p.rows.map((r) => [r.item.id, p.name])));
  const entries = batch?.links?.length ? batch.links : rows.map((r) => ({ skuId: r.item.id, url: r.item.url, label: '', refs: [] }));
  const ctx = {
    rowsById: new Map(rows.map((r) => [r.item.id, r])),
    itemsById: new Map(items.map((i) => [i.id, i])),
    sheetOf,
    multiSheet: new Set(entries.flatMap((e) => (e.refs ?? []).map((r) => r.sheet))).size > 1,
    inBatch: (id) => !batch || batch.skuIds.includes(id),
  };
  const meta = [
    ['key', 'value'],
    ['format', REVIEW_BOOK_FORMAT],
    ['batchId', batch?.id ?? ''],
    ['source', batch?.fileName ?? ''],
    ['exportedAt', now.toISOString()],
    ...parts.map((p) => ['editable', p.name]),
  ];
  const products = parts.map((p) => productSheet(p.name, p.template, p.rows, catalog));
  return [
    summarySheet(summaryName, entries, ctx),
    ...products.map(({ base, ...sheet }) => sheet),
    optionsSheet(groups.map((g) => g.template)),
    notesSheet(catalog),
    { name: META_SHEET, rows: meta, hidden: true },
    { name: BASE_SHEET, rows: [['sku', 'values'], ...products.flatMap((p) => p.base)], hidden: true },
  ];
}

// 文件名里上架表名最多留这么多字（存到本地文件夹时文件名有长度限制）
const FILE_BASE_MAX = 40;
const pad = (n) => String(n).padStart(2, '0');
const stamp = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;

/** 文件名：发布前检查-<上架表名>-<日期-时间>.xlsx */
export function reviewFileName(batch, now = new Date()) {
  const base = String(batch?.fileName ?? '')
    .replace(/\.[^.]+$/, '')
    .replace(/[\\/:*?"<>|]/g, '')
    .trim()
    .slice(0, FILE_BASE_MAX);
  return `发布前检查-${base ? `${base}-` : ''}${stamp(now)}.xlsx`;
}
