// 表格批量填写 VC 自营的 5 个手动字段（纯函数）：市场价、京东价、采购价、采购员ERP、销售员ERP。
// 按“商品链接”（没有链接时按 SKU）对应任务列表里的商品；空格子表示不修改。
// 一行里有一个值不合规就整行不导入（价格之间互相关联，只改一半更容易出错），并写明第几行、哪一列、为什么
import { extractSkuIds } from './url-utils.js';
import { VC_PRICE_LABELS } from './vc-plan.js';
import { vcNumberRule } from './vc-form-values.js';
import { ERP_LABELS, ERP_FORMAT_HINT, isErpCode, ownErp, withErp } from './vc-erp.js';
import { isArchived } from './brand-folders.js';

/** 可导入的字段（buyer/saler 是采购员/销售员 ERP） */
export const VC_IMPORT_FIELDS = { ...VC_PRICE_LABELS, buyer: ERP_LABELS.buyer, saler: ERP_LABELS.saler };
const VALUE_KEYS = Object.keys(VC_IMPORT_FIELDS);
const PRICE_KEYS = Object.keys(VC_PRICE_LABELS);

// 表头别名（去掉空格、*、括号里的内容并转小写后比较，如“京东价（元）”“*采购员 ERP”）
const HEADER_ALIASES = {
  link: ['商品链接', '链接', '样品链接', '样品商品链接', '源商品链接', '商品地址', '网址', 'url'],
  sku: ['sku', 'skuid', 'sku编号', '商品sku', '商品编号'],
  marketPrice: ['市场价'],
  jdPrice: ['京东价'],
  costPrice: ['采购价'],
  buyer: ['采购员', '采购员erp', '采购员erp账号', '采购员erp代码', '采购erp'],
  saler: ['销售员', '销售员erp', '销售员erp账号', '销售员erp代码', '销售erp'],
};
// 表头可以不在第一行（上面有标题、说明行），往下最多找这么多行
const HEADER_SCAN_ROWS = 10;
// 消除表格公式带来的浮点误差（如 69.900000000000006）
const FLOAT_NOISE_DIGITS = 8;
const SHOW_MAX = 60;

export const HEADER_MISSING =
  '没找到表头：表格里要有“商品链接”列（或 SKU 列），以及市场价、京东价、采购价、采购员ERP、销售员ERP 中的至少一列。可以先点“下载模板”，在模板里填写';

/**
 * @typedef {{marketPrice?: number, jdPrice?: number, costPrice?: number, buyer?: string, saler?: string}} VcImportValues
 * @typedef {{row: number, skuId: string, values: VcImportValues}} VcImportEntry  row：Excel 里的行号（从 1 开始）
 * @typedef {{row: number, skuId?: string, message: string}} VcImportProblem
 */

const short = (s) => {
  const text = String(s ?? '');
  return text.length > SHOW_MAX ? `${text.slice(0, SHOW_MAX)}…` : text;
};

export const normalizeHeader = (s) =>
  String(s ?? '')
    .replace(/[（(【[][^）)】\]]*[）)】\]]/g, '')
    .replace(/[\s*＊:：]/g, '')
    .toLowerCase();

function headerColumns(cells) {
  const columns = {};
  cells.forEach((cell, c) => {
    const name = normalizeHeader(cell);
    const key = Object.keys(HEADER_ALIASES).find((k) => HEADER_ALIASES[k].includes(name));
    if (key && columns[key] == null) columns[key] = c;
  });
  return columns;
}

/**
 * 找表头行：同时有商品列（链接/SKU）和至少一个字段列的第一行
 * @param {string[][]} rows
 * @returns {{row: number, columns: Record<string, number>} | null} row：下标（从 0 开始）
 */
export function findHeader(rows) {
  for (let r = 0; r < Math.min(rows.length, HEADER_SCAN_ROWS); r++) {
    const columns = headerColumns(rows[r] ?? []);
    const hasKey = columns.link != null || columns.sku != null;
    if (hasKey && VALUE_KEYS.some((k) => columns[k] != null)) return { row: r, columns };
  }
  return null;
}

const cellText = (cells, col) => (col == null ? '' : String(cells[col] ?? '').trim());

/** SKU 列：纯数字；Excel 把长数字存成“1.00114866451E+11”时还原，显示成“1.00115E+11”（丢了后几位）时报错 */
export function skuFromCell(raw) {
  const text = String(raw ?? '').replace(/\s/g, '');
  if (/^\d{6,}$/.test(text)) return { id: text };
  if (/^\d{6,}\.0+$/.test(text)) return { id: text.split('.')[0] };
  const sci = text.match(/^(\d)(?:\.(\d+))?e\+?(\d+)$/i);
  if (sci && (sci[2] ?? '').length === Number(sci[3])) return { id: `${sci[1]}${sci[2] ?? ''}` };
  if (sci) {
    return { error: `SKU“${raw}”被 Excel 显示成了科学计数法，后几位已经丢了：请填“商品链接”列，或把 SKU 列设成“文本”格式后重新填写` };
  }
  return { error: `SKU“${short(raw)}”不是商品编号` };
}

/** 这一行对应的商品：以商品链接为准，SKU 列只用来核对 */
function rowSku(cells, columns) {
  const link = cellText(cells, columns.link);
  const sku = cellText(cells, columns.sku);
  if (!link && !sku) return { error: '没有填商品链接' };
  const fromLink = link ? extractSkuIds(link) : [];
  if (link && fromLink.length > 1) return { error: `一个格子里有多个商品：${short(link)}` };
  if (link && !fromLink.length) return { error: `商品链接“${short(link)}”里找不到商品编号` };
  const fromSku = sku ? skuFromCell(sku) : {};
  if (!fromLink.length) return fromSku.error ? { error: fromSku.error } : { skuId: fromSku.id };
  if (fromSku.id && fromSku.id !== fromLink[0]) return { error: `商品链接（SKU ${fromLink[0]}）和 SKU 列（${fromSku.id}）不一致` };
  return { skuId: fromLink[0] };
}

const THOUSANDS_RE = /^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/;
const NUMBER_RE = /^\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i;
const decimalsOf = (n) => (String(n).split('.')[1] ?? '').length;

/** 价格：可以带 ¥、元、千分位逗号；按 VC 页面的规则检查范围和小数位数 */
export function parsePrice(key, raw) {
  const rule = vcNumberRule(key);
  const label = VC_PRICE_LABELS[key];
  const stripped = String(raw ?? '').replace(/[¥￥元\s]/g, '');
  const text = THOUSANDS_RE.test(stripped) ? stripped.replace(/,/g, '') : stripped;
  if (!NUMBER_RE.test(text)) return { error: `${label}“${short(raw)}”不是数字` };
  const value = Number(Number(text).toFixed(FLOAT_NOISE_DIGITS));
  if (!(value >= rule.min && value <= rule.max)) return { error: `${label}“${short(raw)}”超出范围（${rule.min}~${rule.max} 元）` };
  if (decimalsOf(value) > rule.decimals) return { error: `${label}“${short(raw)}”最多 ${rule.decimals} 位小数` };
  return { value };
}

function parseErp(key, raw) {
  const value = String(raw ?? '').trim();
  return isErpCode(value) ? { value } : { error: `${ERP_LABELS[key]}“${short(raw)}”格式不对：${ERP_FORMAT_HINT}` };
}

function rowValues(cells, columns) {
  const values = {};
  const errors = [];
  for (const key of VALUE_KEYS) {
    const raw = cellText(cells, columns[key]);
    if (!raw) continue;
    const res = PRICE_KEYS.includes(key) ? parsePrice(key, raw) : parseErp(key, raw);
    if (res.error) errors.push(res.error);
    else values[key] = res.value;
  }
  return { values, errors };
}

/** 同一个商品出现在多行：值都一样时只留第一行；不一样时都不导入（不知道该用哪一行） */
function dedupe(entries) {
  const groups = new Map();
  for (const e of entries) groups.set(e.skuId, [...(groups.get(e.skuId) ?? []), e]);
  const kept = [];
  const errors = [];
  for (const [skuId, group] of groups) {
    const same = group.every((e) => JSON.stringify(e.values) === JSON.stringify(group[0].values));
    if (same) {
      kept.push(group[0]);
      continue;
    }
    const rows = group.map((e) => e.row).join('、');
    errors.push(...group.map((e) => ({ row: e.row, skuId, message: `第 ${rows} 行是同一个商品，填的值不一样，这几行都没有导入` })));
  }
  return { entries: kept.sort((a, b) => a.row - b.row), errors };
}

/**
 * 表格行 → 每个商品要填的值
 * @param {string[][]} rows
 * @returns {{entries: VcImportEntry[], errors: VcImportProblem[], blank: number, columns: string[], error?: string}}
 *   blank：有商品但一个值都没填的行（不修改）；columns：识别到的字段列；error：整张表不能用的原因
 */
export function parseVcSheet(rows) {
  const header = findHeader(rows ?? []);
  if (!header) return { entries: [], errors: [], blank: 0, columns: [], error: HEADER_MISSING };
  const entries = [];
  const errors = [];
  let blank = 0;
  for (let r = header.row + 1; r < rows.length; r++) {
    const cells = rows[r] ?? [];
    if (!cells.some((c) => String(c ?? '').trim())) continue;
    const row = r + 1;
    const { values, errors: bad } = rowValues(cells, header.columns);
    if (!Object.keys(values).length && !bad.length) {
      blank++;
      continue;
    }
    const key = rowSku(cells, header.columns);
    if (key.error) errors.push({ row, message: key.error });
    else if (bad.length) errors.push({ row, skuId: key.skuId, message: bad.join('；') });
    else entries.push({ row, skuId: key.skuId, values });
  }
  const deduped = dedupe(entries);
  const columns = VALUE_KEYS.filter((k) => header.columns[k] != null).map((k) => VC_IMPORT_FIELDS[k]);
  return { entries: deduped.entries, errors: [...errors, ...deduped.errors].sort((a, b) => a.row - b.row), blank, columns };
}

/**
 * 导入的值合并进编辑里的 vc（返回新对象）：表格里填了的覆盖，没填的保留
 * @param {object|undefined} vc
 * @param {VcImportValues} values
 */
export function mergeVcImport(vc, values) {
  const prices = Object.fromEntries(PRICE_KEYS.filter((k) => values[k] != null).map((k) => [k, values[k]]));
  const own = ownErp(vc);
  return withErp({ ...(vc ?? {}), ...prices }, { buyer: values.buyer ?? own.buyer, saler: values.saler ?? own.saler });
}

/** 整份编辑内容：只改 vc（返回新对象） */
export const applyVcImport = (edits, values) => ({ ...(edits ?? {}), vc: mergeVcImport(edits?.vc, values) });

/**
 * 真正保存时用的修改函数（给 itemRepo.saveEditsMany）：按存储里的最新条目再检查一遍——
 * 预览之后才发布成功的、合并后京东价高于市场价的，原样不改
 * @param {VcImportValues} values
 * @returns {(edits: object, item: object) => object}
 */
export function importEdit(values) {
  return (edits, item) => {
    if (isArchived(item)) return edits;
    const next = applyVcImport(edits, values);
    return priceConflict(next.vc, values) ? edits : next;
  };
}

const FIELD_VIEWS = [
  ...PRICE_KEYS.map((k) => ({ label: VC_PRICE_LABELS[k], get: (vc) => vc?.[k] })),
  { label: ERP_LABELS.buyer, get: (vc) => ownErp(vc).buyer },
  { label: ERP_LABELS.saler, get: (vc) => ownErp(vc).saler },
];

/** @returns {{label: string, from: string, to: string}[]} 有变化的字段 */
export function vcChanges(before, after) {
  return FIELD_VIEWS.map((f) => ({ label: f.label, from: String(f.get(before) ?? ''), to: String(f.get(after) ?? '') })).filter((c) => c.from !== c.to);
}

/** 京东价高于市场价：只在这一行填了其中一个价格时检查（只导入 ERP 的行不因为原来的价格被拦） */
function priceConflict(vc, values) {
  if (values.marketPrice == null && values.jdPrice == null) return '';
  if (!(vc.marketPrice > 0 && vc.jdPrice > vc.marketPrice)) return '';
  return `京东价 ¥${vc.jdPrice} 高于市场价 ¥${vc.marketPrice}（VC 页面不允许），这一行没有导入`;
}

function marginWarning(vc) {
  if (!(vc.costPrice > 0 && vc.jdPrice > 0 && vc.costPrice >= vc.jdPrice)) return '';
  return `采购价 ¥${vc.costPrice} 不低于京东价 ¥${vc.jdPrice}，毛利为负，请核对`;
}

/**
 * 对照任务列表：哪些商品会被修改。已发布的商品不改（改了也不会作用到店铺）
 * @param {VcImportEntry[]} entries
 * @param {object[]} items
 * @returns {{updates: {id: string, row: number, skuId: string, title: string, values: VcImportValues, changes: object[]}[],
 *   unchanged: VcImportEntry[], missing: VcImportEntry[], archived: VcImportEntry[], errors: VcImportProblem[], warnings: VcImportProblem[]}}
 */
export function planVcImport(entries, items) {
  const byId = new Map(items.map((i) => [i.id, i]));
  const byProductSku = new Map(items.filter((i) => i.product?.skuId).map((i) => [String(i.product.skuId), i]));
  const result = { updates: [], unchanged: [], missing: [], archived: [], errors: [], warnings: [] };
  const seen = new Map();
  for (const e of entries) {
    const item = byId.get(e.skuId) ?? byProductSku.get(e.skuId);
    if (!item) result.missing.push(e);
    else if (isArchived(item)) result.archived.push(e);
    else if (seen.has(item.id)) result.errors.push({ row: e.row, skuId: e.skuId, message: `和第 ${seen.get(item.id)} 行是任务列表里的同一个商品，这一行没有导入` });
    else {
      seen.set(item.id, e.row);
      planOne(result, e, item);
    }
  }
  return result;
}

function planOne(result, e, item) {
  const before = item.edits?.vc;
  const after = mergeVcImport(before, e.values);
  const conflict = priceConflict(after, e.values);
  if (conflict) return result.errors.push({ row: e.row, skuId: e.skuId, message: conflict });
  const changes = vcChanges(before, after);
  if (!changes.length) return result.unchanged.push(e);
  const warning = marginWarning(after);
  if (warning) result.warnings.push({ row: e.row, skuId: e.skuId, message: warning });
  return result.updates.push({ id: item.id, row: e.row, skuId: e.skuId, title: item.edits?.title || item.product?.title || '', values: e.values, changes });
}

export const TEMPLATE_HEADER = ['商品链接', 'SKU', '商品标题（仅供核对，导入时不读）', '市场价（元）', '京东价（元）', '采购价（元）', '采购员ERP', '销售员ERP'];
const TEMPLATE_NOTES = [
  '表格批量填写 VC 自营字段：按“商品链接”对应插件任务列表里的商品',
  '1. 在“商品”工作表里填写市场价、京东价、采购价（元）和采购员ERP、销售员ERP；不改的格子留空，已经填过的值会保留。',
  '2. 市场价、京东价最多 2 位小数，采购价最多 4 位小数；京东价不能高于市场价。',
  '3. ERP 填京东员工的 ERP 账号（字母、数字、点、下划线、横线，如 xudezhi.6），不是姓名；采购员和销售员是同一个人时两列填同一个。',
  '4. 第一行表头不要改；可以删掉不需要的行、调整顺序，也可以新增商品行（插件任务列表里要先有这个商品，可用“添加链接”加入）。',
  '5. 以“商品链接”为准，SKU 列只用来核对；已发布的商品不会被修改。',
  '6. 保存后在插件任务面板点“表格导入价格/ERP”→“选择表格文件”，核对预览后点“导入”。也可以另存为 CSV 再导入。',
];

/**
 * 模板：每个商品一行，已经填过的值预先填好
 * @param {object[]} items
 * @returns {import('./xlsx-write.js').SheetSpec[]}
 */
export function vcTemplateSheets(items) {
  const rows = items.map((i) => {
    const vc = i.edits?.vc ?? {};
    const erp = ownErp(vc);
    return [i.url, i.skuId, i.edits?.title || i.product?.title || '', vc.marketPrice, vc.jdPrice, vc.costPrice, erp.buyer, erp.saler];
  });
  return [
    { name: '商品', rows: [TEMPLATE_HEADER, ...rows], widths: [46, 16, 50, 12, 12, 12, 16, 16], textColumns: [1, 6, 7] },
    { name: '填写说明', rows: TEMPLATE_NOTES.map((line) => [line]), widths: [120] },
  ];
}
