// 发布前检查表的读回（纯函数）：表格的生成见 review-workbook.js（按上架模板分附表，格子里是发布时会用的值）。
// 每个工作表里的商品行 → 按商品的模板校验 → 写进编辑内容。规则和「表格导入价格/ERP」一致：按商品链接对应、
// 空格子不修改、一行里有一个值不对整行不导入（写明哪张表第几行、为什么）；格子和发布时会用的值一样不算修改
// （导出时写的是采集值，原样导回不会变成“手动填写”）。旧的单表格式、「表格导入价格/ERP」的表也能导
import { extractSkuIds } from './url-utils.js';
import { normalizeHeader, parsePrice, skuFromCell } from './vc-import.js';
import { VC_PRICE_LABELS } from './vc-plan.js';
import { applyReviewValue, applyTemplateChoice, buildReview, currentChoice, reviewOwnValue, reviewTemplate, reviewValueError, REVIEW_FIELDS, templateChoices } from './vc-review.js';
import { attrKey, pickOption } from './vc-review-attrs.js';
import { normalizeUpc } from './sku-attrs.js';
import { vcTemplateAttrs, vcTemplateLabel, vcTemplateSkuAttrs } from './vc-templates.js';

export const NOT_APPLICABLE = '—';
// 属性列的表头：“商品属性:层数”“SKU属性:纸张尺寸”（必填的前面带 *），旧表是“属性:层数”
const ATTR_HEADER_RE = /^\s*[*＊]?\s*(?:商品属性|sku属性|属性)\s*[:：]\s*(.+?)\s*$/i;
const HEADER_SCAN_ROWS = 10;
const AUTO_WORDS = new Set(['自动', '自动匹配']);
export const HEAD = { link: '商品链接', sku: 'SKU', sourceTitle: '源商品标题（核对用，不导入）', missing: '还缺（核对用，不导入）', template: '上架模板' };
// 发布标题单独起名：「表格导入价格/ERP」那张表的“商品标题”列是源标题（仅供核对），不能当发布标题导入
const SHEET_LABELS = { title: '发布标题（留空=按源标题生成）' };
export const sheetLabel = (f) => SHEET_LABELS[f.key] ?? f.label;
// 和「表格导入价格/ERP」的表头通用：那张表填好的也能直接导进来
const ALIASES = {
  link: ['商品链接', '链接', '样品链接', '样品商品链接', '源商品链接', '商品地址', '网址', 'url'],
  sku: ['sku', 'skuid', 'sku编号', '商品sku', '商品编号'],
  template: ['上架模板', '模板', '类目模板'],
  buyer: ['采购员', '采购员erp', '采购erp'],
  saler: ['销售员', '销售员erp', '销售erp'],
  upc: ['商品条形码', '条形码', 'upc'],
  title: ['发布标题', 'vc标题'],
};
const SKIP_HEADERS = new Set([HEAD.sourceTitle, HEAD.missing, '商品标题'].map(normalizeHeader));

const fieldKeyOf = (name) =>
  Object.keys(ALIASES).find((k) => ALIASES[k].includes(name)) ??
  REVIEW_FIELDS.find((f) => !SHEET_LABELS[f.key] && normalizeHeader(f.label) === name)?.key ??
  null;

/** 模板里的属性（商品属性在前、SKU属性在后），where 标明在哪 */
export const templateAttrs = (template) => [...vcTemplateAttrs(template).map((a) => ({ ...a, where: '商品属性' })), ...vcTemplateSkuAttrs(template).map((a) => ({ ...a, where: 'SKU属性' }))];

/** 模板下拉的选项文字（表格里填这个） */
function choiceLabel(catalog, value) {
  return templateChoices(catalog).flatMap((g) => g.options).find((o) => o.value === value)?.label ?? '';
}

/** 商品现在的模板在表格里怎么写：手动选的写选项文字，自动匹配的写模板名 */
export function templateCell(catalog, match) {
  if (!match.template) return '';
  const choice = currentChoice(match);
  return choice ? choiceLabel(catalog, choice) : match.template.categoryName;
}

/** “可选值”表里属性的填写格式 */
export const attrFormat = (a) => {
  if (/MultiInputUnit/i.test(a.type)) {
    const parts = (a.options ?? []).map((o) => o.label).filter(Boolean);
    return parts.length > 1 ? `${parts.join('×')}，${parts.length} 个数字，如 195×133` : `数字${a.suffix ? `（单位 ${a.suffix}）` : ''}`;
  }
  if (a.kind === 'select' || a.kind === 'multi') return (a.options ?? []).map((o) => o.label).filter(Boolean).join('、');
  return a.suffix ? `数字（单位 ${a.suffix}）` : '文字';
};

/** 找表头：有商品列（链接/SKU）和至少一个可导入的列 */
function findReviewHeader(rows) {
  for (let r = 0; r < Math.min(rows.length, HEADER_SCAN_ROWS); r++) {
    const columns = { attrs: {} };
    (rows[r] ?? []).forEach((cell, c) => {
      const attr = String(cell ?? '').match(ATTR_HEADER_RE);
      if (attr) {
        columns.attrs[attr[1]] ??= c;
        return;
      }
      const name = normalizeHeader(cell);
      const key = SKIP_HEADERS.has(name) ? null : fieldKeyOf(name);
      if (key && columns[key] == null) columns[key] = c;
    });
    const hasKey = columns.link != null || columns.sku != null;
    const valueCols = Object.keys(columns).filter((k) => !['link', 'sku', 'attrs'].includes(k)).length + Object.keys(columns.attrs).length;
    if (hasKey && valueCols) return { row: r, columns };
  }
  return null;
}

export const REVIEW_HEADER_MISSING = '没找到表头：表格里要有“商品链接”列（或 SKU 列）和至少一个要填写的列。可以先点“下载填写表格”，在那张表里填写';

const cell = (cells, col) => (col == null ? '' : String(cells[col] ?? '').trim());

function rowSku(cells, columns) {
  const link = cell(cells, columns.link);
  const sku = cell(cells, columns.sku);
  const fromLink = link ? extractSkuIds(link) : [];
  if (link && fromLink.length !== 1) return { error: fromLink.length ? '一个格子里有多个商品链接' : `商品链接“${link.slice(0, 60)}”里找不到商品编号` };
  const fromSku = sku ? skuFromCell(sku) : {};
  if (!fromLink.length) return fromSku.error ? { error: fromSku.error } : fromSku.id ? { skuId: fromSku.id } : { error: '没有填商品链接' };
  if (fromSku.id && fromSku.id !== fromLink[0]) return { error: `商品链接（SKU ${fromLink[0]}）和 SKU 列（${fromSku.id}）不一致` };
  return { skuId: fromLink[0] };
}

/**
 * 表格行 → 每个商品填了什么（还没校验值，校验要按商品的模板，见 planReviewImport）
 * @param {string[][]} rows
 * @param {{sheet?: string}} [opts] sheet：工作表名（多张附表一起导入时写进问题里）
 * @returns {{entries: {sheet: string, row: number, skuId: string, template: string, values: Record<string, string>, attrs: Record<string, string>}[],
 *   errors: {sheet: string, row: number, message: string}[], blank: number, error?: string}}
 */
export function parseReviewSheet(rows, { sheet = '' } = {}) {
  const header = findReviewHeader(rows ?? []);
  if (!header) return { entries: [], errors: [], blank: 0, error: REVIEW_HEADER_MISSING };
  const { columns } = header;
  const fieldKeys = REVIEW_FIELDS.map((f) => f.key).filter((k) => columns[k] != null);
  const entries = [];
  const errors = [];
  let blank = 0;
  for (let r = header.row + 1; r < rows.length; r++) {
    const cells = rows[r] ?? [];
    if (!cells.some((c) => String(c ?? '').trim())) continue;
    const values = Object.fromEntries(fieldKeys.map((k) => [k, cell(cells, columns[k])]).filter(([, v]) => v));
    const attrs = Object.fromEntries(Object.entries(columns.attrs).map(([t, c]) => [t, cell(cells, c)]).filter(([, v]) => v && v !== NOT_APPLICABLE));
    const template = cell(cells, columns.template);
    if (!template && !Object.keys(values).length && !Object.keys(attrs).length) {
      blank++;
      continue;
    }
    const key = rowSku(cells, columns);
    if (key.error) errors.push({ sheet, row: r + 1, message: key.error });
    else entries.push({ sheet, row: r + 1, skuId: key.skuId, template, values, attrs });
  }
  return { entries, errors, blank };
}

const squash = (s) => normalizeHeader(s).replace(/[>＞]/g, '');

/**
 * 表格里写的模板 → 下拉的值；'' 表示改回自动匹配，null 表示找不到或有重名。
 * 先认完整写法（“抽纸 > 悬挂式抽纸”、三级类目名/ID/路径），再认只写四级类目名或ID的；
 * 只写名字对上多个模板时（“乳霜纸”既是三级类目、又是抽纸下的四级类目）按三级类目算，四级之间重名时不猜
 */
export function resolveTemplateCell(catalog, text) {
  const want = squash(text);
  if (AUTO_WORDS.has(String(text).trim())) return '';
  const groups = templateChoices(catalog).map((g) => ({ ...g, template: catalog.byId.get(g.options[0]?.value.split(':')[0]) }));
  const full = groups.flatMap((g) => {
    const t = g.template;
    const fallback = g.options.find((o) => o.value.endsWith(`:${t?.publishCategoryId}`)) ?? g.options[0];
    const whole = t && [t.categoryName, t.categoryId, vcTemplateLabel(t)].some((n) => squash(n) === want) ? [fallback.value] : [];
    const exact = g.options.filter((o) => squash(o.label) === want || squash(`${vcTemplateLabel(t)} > ${o.label.split('>').at(-1)}`) === want);
    return [...whole, ...exact.map((o) => o.value)];
  });
  if (full.length) return full[0];
  const leaf = groups.flatMap((g) => g.options.filter((o) => [o.label.split('>').at(-1), o.value.split(':')[1]].some((n) => squash(n) === want)).map((o) => o.value));
  return leaf.length === 1 ? leaf[0] : null;
}

/**
 * 表格里的模板和商品现在的是不是同一个：原样留着导出时的写法、或者写的就是现在用的类目，都不算修改
 * （否则自动匹配的商品导入一次就变成了“手动指定类目”）
 */
function templateChanged(catalog, match, text, choice) {
  if (String(text).trim() === templateCell(catalog, match)) return false;
  if (choice === '') return match.from === 'manual';
  const [templateId, leafId] = choice.split(':');
  return !(match.template?.categoryId === templateId && match.category?.categoryId === leafId);
}

/** 价格（可带 ¥、元、千分位）按「表格导入价格/ERP」的规则读；其他值按弹窗里的规则检查 */
function readValue(key, raw, template) {
  if (key in VC_PRICE_LABELS) {
    const res = parsePrice(key, raw);
    return res.error ? { error: res.error } : { value: String(res.value) };
  }
  const label = REVIEW_FIELDS.find((f) => f.key === key).label;
  const error = reviewValueError(key, raw, template);
  return error ? { error: `${label}“${raw}”${error}` } : { value: raw };
}

/** 属性值：下拉的要对上选项（存成选项原文），数字类的要有数字 */
function readAttr(attr, raw) {
  if (/MultiInputUnit/i.test(attr.type)) {
    const need = Math.max(1, (attr.options ?? []).filter((o) => o.label).length);
    return (String(raw).match(/\d+(?:\.\d+)?/g) ?? []).length >= need ? { value: raw } : { error: `${attr.title}“${raw}”要有 ${need} 个数字` };
  }
  if (attr.kind === 'select') {
    const hit = pickOption((attr.options ?? []).map((o) => o.label).filter(Boolean), raw);
    return hit ? { value: hit } : { error: `${attr.title}“${raw}”不是可选值（见“可选值”表）` };
  }
  if (attr.suffix && !/\d/.test(raw)) return { error: `${attr.title}“${raw}”要填数字` };
  return { value: raw };
}

const NUMBER_KEYS = new Set(REVIEW_FIELDS.filter((f) => f.input === 'number').map((f) => f.key));

/** 表格里的值和发布时会用的值是不是同一个（数字按数值比，条形码按规范化后比） */
function sameValue(key, a, b) {
  const x = String(a ?? '').trim();
  const y = String(b ?? '').trim();
  if (x === y) return true;
  if (!x || !y) return false;
  if (NUMBER_KEYS.has(key)) return Number(x) === Number(y);
  return key === 'upc' && normalizeUpc(x) !== '' && normalizeUpc(x) === normalizeUpc(y);
}

/** 发布时会用的值：自己填的 > 采集到的/自动值（同名属性取第一个有值的） */
function effectiveValues(item, edits, template, settings) {
  const review = buildReview({ product: item.product, edits, settings, template });
  const attrs = new Map();
  for (const a of [...review.props, ...review.skuAttrs]) if (!attrs.get(a.title)) attrs.set(a.title, a.value ?? '');
  return { fields: new Map(review.fields.map((f) => [f.key, f.value])), attrs };
}

/**
 * 一个格子没改过就不动（不校验：导出时写的就是它，填不上的在检查里标红）：有导出时的值（_base）时和它比——
 * 导出之后在插件里改的、重新采集到的值不会被旧表冲掉；没有时（旧表）和发布时会用的值比。
 * 改过的校验，合规就存成自己填的
 */
function applyCell({ key, raw, current, exported, read, errors }, next) {
  if (sameValue(key, raw, exported !== undefined ? exported : current)) return next;
  const res = read();
  if (res.error) {
    errors.push(res.error);
    return next;
  }
  return sameValue(key, res.value, current) ? next : applyReviewValue(next, key, res.value);
}

function applyRow(entry, item, edits, ctx) {
  const errors = [];
  const ignored = [];
  const base = ctx.base?.get(item.id);
  let next = edits;
  if (entry.template && !(base && entry.template === base.template)) {
    const choice = resolveTemplateCell(ctx.catalog, entry.template);
    if (choice == null) errors.push(`上架模板“${entry.template}”找不到或有重名（可以写成“抽纸 > 常规抽纸”这样，见“填写说明”）`);
    else if (templateChanged(ctx.catalog, reviewTemplate({ product: item.product, edits, settings: ctx.settings, catalog: ctx.catalog }), entry.template, choice)) {
      next = applyTemplateChoice(next, ctx.catalog, choice);
    }
  }
  const { template } = reviewTemplate({ product: item.product, edits: next, settings: ctx.settings, catalog: ctx.catalog });
  const current = effectiveValues(item, next, template, ctx.settings);
  for (const [key, raw] of Object.entries(entry.values)) {
    next = applyCell({ key, raw, current: current.fields.get(key), exported: base?.values.get(key), read: () => readValue(key, raw, template), errors }, next);
  }
  const attrs = new Map(templateAttrs(template).map((a) => [a.title, a]));
  for (const [title, raw] of Object.entries(entry.attrs)) {
    const attr = attrs.get(title);
    if (!attr) {
      ignored.push(title);
      continue;
    }
    next = applyCell({ key: attrKey(title), raw, current: current.attrs.get(title), exported: base?.values.get(attrKey(title)), read: () => readAttr(attr, raw), errors }, next);
  }
  return { edits: next, errors, ignored, template };
}

const changedKeys = (before, after) =>
  [...REVIEW_FIELDS.map((f) => [f.key, f.label]), ...[...new Set([...Object.keys(before?.attrOverrides ?? {}), ...Object.keys(after?.attrOverrides ?? {})])].map((t) => [attrKey(t), t])]
    .filter(([key]) => reviewOwnValue(before, key) !== reviewOwnValue(after, key))
    .map(([, label]) => label);

/** 另一行的位置：同一张表写“第 n 行”，不同表写“表名 第 n 行” */
const rowRef = (at, entry) => `${at.sheet && at.sheet !== entry.sheet ? `「${at.sheet}」` : ''}第 ${at.row} 行`;

/**
 * 表格内容对照要发布的商品：每个商品改成什么、哪些行有问题
 * @param {ReturnType<typeof parseReviewSheet>['entries']} entries 可以来自多张工作表（按表、行的顺序）
 * @param {{items: object[], drafts: Map<string, object>, catalog: object, settings: object, missingText?: string,
 *   base?: Map<string, {template: string, values: Map<string, string>}>}} ctx
 *   drafts：正在改的编辑内容（弹窗里的；没有时用商品的）；missingText：表格里的商品不在 items 里时怎么说；
 *   base：导出时写的值（readBookBase），和它一样的格子不算修改
 * @returns {{updates: {id: string, sheet: string, row: number, edits: object, changes: string[]}[],
 *   problems: {sheet: string, row: number, level: 'error'|'warn', text: string}[], unchanged: number, matched: string[]}}
 *   matched：表格里有、这一行导入了（有修改或没修改）的商品
 */
export function planReviewImport(entries, ctx) {
  const byId = new Map(ctx.items.flatMap((i) => [[i.id, i], ...(i.product?.skuId ? [[String(i.product.skuId), i]] : [])]));
  const updates = [];
  const problems = [];
  const seen = new Map();
  const matched = [];
  let unchanged = 0;
  entries.forEach((entry, order) => {
    const at = { sheet: entry.sheet ?? '', row: entry.row, order };
    const item = byId.get(entry.skuId);
    const err = (text) => problems.push({ ...at, level: 'error', text: `${text}（SKU ${entry.skuId}）` });
    if (!item) return err(ctx.missingText ?? '这个商品不在这次发布的商品里');
    if (seen.has(item.id)) return err(`和${rowRef(seen.get(item.id), at)}是同一个商品，这一行没有导入`);
    seen.set(item.id, at);
    const before = ctx.drafts.get(item.id) ?? item.edits ?? {};
    const res = applyRow(entry, item, before, ctx);
    if (res.errors.length) return err(`${res.errors.join('；')}，这一行没有导入`);
    matched.push(item.id);
    if (res.ignored.length) {
      const name = res.template?.categoryName ?? '（没有模板）';
      problems.push({ ...at, level: 'warn', text: `模板「${name}」没有这些属性，已忽略：${res.ignored.join('、')}（SKU ${entry.skuId}）` });
    }
    const templateChanged = JSON.stringify(before.cateList ?? null) !== JSON.stringify(res.edits.cateList ?? null);
    const changes = [...(templateChanged ? ['上架模板'] : []), ...changedKeys(before, res.edits)];
    if (changes.length) updates.push({ id: item.id, sheet: at.sheet, row: entry.row, edits: res.edits, changes });
    else unchanged++;
  });
  const sorted = problems.sort((a, b) => a.order - b.order).map(({ order, ...p }) => p);
  return { updates, problems: sorted, unchanged, matched };
}
