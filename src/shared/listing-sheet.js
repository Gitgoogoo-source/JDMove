// 上架表（用户上传的表格）→ 要采集的商品（纯函数）。
// 读每个（没隐藏的）工作表里表头以“参考链接”开头的列（如“参考链接(多包/组合/新规格)”），别的链接列（京东链接等）不读。
// 一个格子可以写多个链接（“名称 + 链接”换行写多条），每个链接是一个商品，链接前面的文字记作说明；
// 同一个链接出现在多行时只采集一次，记下所有行。
// 认得出的标准列（市场价、京东价、采购价、采购员ERP、销售员ERP、条形码、型号）一起导入：只在一行只有一个参考链接、
// 且这个链接只出现在这一行（或几行填的值一样）时导入，否则不知道值属于哪个商品
import { extractItemLinks } from './url-utils.js';
import { parsePrice } from './vc-import.js';
import { ERP_FORMAT_HINT, ERP_LABELS, isErpCode } from './vc-erp.js';
import { normalizeUpc } from './sku-attrs.js';
import { applyReviewValue } from './vc-review.js';
import { isArchived } from './brand-folders.js';

export const LISTING_HEADER_MISSING = '没找到“参考链接”列：上架表里要有一列表头以“参考链接”开头（如“参考链接”“参考链接(多包/组合/新规格)”），每个格子写一个或多个京东商品链接';
const HEADER_SCAN_ROWS = 10;
const LINK_HEADER_RE = /^参考链接/;
const MODEL_MAX = 60;
const SHOW_MAX = 40;
// 列名要一致（只去掉空格、*、单位括号）：“京东价(到手价)”这类写了别的说明的列不读，免得把对标商品的价格当成自己的
const VALUE_HEADERS = {
  marketPrice: ['市场价'],
  jdPrice: ['京东价'],
  costPrice: ['采购价'],
  buyer: ['采购员erp', '采购员'],
  saler: ['销售员erp', '销售员'],
  upc: ['条形码', '商品条形码', 'upc', '69码'],
  model: ['型号'],
};
const VALUE_LABELS = { marketPrice: '市场价', jdPrice: '京东价', costPrice: '采购价', ...ERP_LABELS, upc: '条形码', model: '型号' };
const PRICE_KEYS = ['marketPrice', 'jdPrice', 'costPrice'];

/**
 * @typedef {{sheet: string, row: number}} ListingRef  row：Excel 里的行号（从 1 开始）
 * @typedef {{skuId: string, url: string, label: string, refs: ListingRef[]}} ListingLink
 * @typedef {{marketPrice?: number, jdPrice?: number, costPrice?: number, buyer?: string, saler?: string, upc?: string, model?: string}} ListingValues
 * @typedef {{sheet: string, row: number, level: 'warn'|'error', text: string}} ListingProblem
 */

const clean = (s) => String(s ?? '').trim();
const short = (s) => (clean(s).length > SHOW_MAX ? `${clean(s).slice(0, SHOW_MAX)}…` : clean(s));
const strictHeader = (s) =>
  clean(s)
    .replace(/[\s*＊]/g, '')
    .replace(/[（(](?:元|mm|kg)[）)]$/i, '')
    .toLowerCase();

/** 表头行：有“参考链接”列的第一行；同时记下认得出的标准列 */
function findListingHeader(rows) {
  for (let r = 0; r < Math.min(rows.length, HEADER_SCAN_ROWS); r++) {
    const cells = rows[r] ?? [];
    const linkCols = cells.map((c, i) => (LINK_HEADER_RE.test(clean(c).replace(/\s/g, '')) ? i : -1)).filter((i) => i >= 0);
    if (!linkCols.length) continue;
    const valueCols = {};
    cells.forEach((c, i) => {
      const name = strictHeader(c);
      const key = Object.keys(VALUE_HEADERS).find((k) => VALUE_HEADERS[k].includes(name));
      if (key && valueCols[key] == null) valueCols[key] = i;
    });
    return { row: r, linkCols, valueCols };
  }
  return null;
}

/** 格子里的链接，和链接所在那一行去掉链接后的文字（商品名称说明） */
function cellLinks(text) {
  return String(text ?? '')
    .split(/\r\n|\n|\r/)
    .flatMap((line) => {
      const links = extractItemLinks(line);
      const label = links
        .reduceRight((s, l) => s.slice(0, l.at) + s.slice(l.end), line)
        .replace(/^[\s:：\-—]+|[\s:：\-—]+$/g, '')
        .trim();
      return links.map((l) => ({ skuId: l.skuId, url: l.url, label }));
    });
}

function readValue(key, raw) {
  const label = VALUE_LABELS[key];
  if (PRICE_KEYS.includes(key)) return parsePrice(key, raw);
  if (key === 'buyer' || key === 'saler') return isErpCode(raw) ? { value: clean(raw) } : { error: `${label}“${short(raw)}”格式不对：${ERP_FORMAT_HINT}` };
  if (key === 'upc') return normalizeUpc(raw) ? { value: normalizeUpc(raw) } : { error: `${label}“${short(raw)}”不是有效的条形码（8~14 位数字，校验位要对）` };
  return clean(raw).length <= MODEL_MAX ? { value: clean(raw) } : { error: `${label}超过 ${MODEL_MAX} 个字` };
}

/** 一行里的标准列：不合规的值跳过并提醒，其余照导 */
function rowValues(cells, valueCols, warn) {
  const values = {};
  for (const [key, col] of Object.entries(valueCols)) {
    const raw = clean(cells[col]);
    if (!raw) continue;
    const res = readValue(key, raw);
    if (res.error) warn(`${res.error}，这一项没有导入`);
    else values[key] = res.value;
  }
  return values;
}

const refText = (refs) => `第 ${refs.map((r) => r.row).join('、')} 行`;

/** 同一个商品出现在多行：填的值都一样（或只有一行填了）时导入，不一样时都不导入 */
function settleValues(rowsBySku, problems) {
  const out = [];
  for (const [skuId, list] of rowsBySku) {
    const filled = list.filter((x) => Object.keys(x.values).length);
    if (!filled.length) continue;
    const same = filled.every((x) => JSON.stringify(x.values) === JSON.stringify(filled[0].values));
    if (same) {
      out.push({ skuId, refs: filled.map((x) => x.ref), values: filled[0].values });
      continue;
    }
    const refs = filled.map((x) => x.ref);
    problems.push({ ...refs[0], level: 'warn', text: `${refText(refs)}是同一个商品（SKU ${skuId}），价格/条形码等填的不一样，都没有导入` });
  }
  return out;
}

function parseSheet({ name, rows }, acc) {
  const header = findListingHeader(rows ?? []);
  if (!header) return false;
  const valueKeys = Object.keys(header.valueCols);
  for (let r = header.row + 1; r < rows.length; r++) {
    const cells = rows[r] ?? [];
    if (!cells.some((c) => clean(c))) continue;
    const ref = { sheet: name, row: r + 1 };
    const warn = (text) => acc.problems.push({ ...ref, level: 'warn', text });
    const texts = header.linkCols.map((c) => clean(cells[c])).filter(Boolean);
    const links = [...new Map(texts.flatMap(cellLinks).map((l) => [l.skuId, l])).values()];
    if (!links.length) {
      if (texts.length) warn(`参考链接“${short(texts.join(' '))}”里没有京东商品链接，这一行没有加入`);
      else acc.noLink.push(ref);
      continue;
    }
    for (const l of links) {
      const known = acc.links.get(l.skuId);
      acc.links.set(l.skuId, known ? { ...known, label: known.label || l.label, refs: [...known.refs, ref] } : { ...l, refs: [ref] });
    }
    const values = valueKeys.length ? rowValues(cells, header.valueCols, warn) : {};
    if (links.length > 1 && Object.keys(values).length) {
      warn(`这一行有 ${links.length} 个参考链接，不知道价格/条形码等属于哪个商品，没有导入（到发布前检查表里分别填写）`);
    }
    const target = links.length === 1 ? links[0].skuId : null;
    for (const l of links) acc.rowsBySku.set(l.skuId, [...(acc.rowsBySku.get(l.skuId) ?? []), { ref, values: l.skuId === target ? values : {} }]);
  }
  return true;
}

/**
 * 上架表的所有工作表 → 要采集的商品
 * @param {{name: string, rows: string[][]}[]} sheets
 * @returns {{links: ListingLink[], values: {skuId: string, refs: ListingRef[], values: ListingValues}[], noLink: ListingRef[],
 *   problems: ListingProblem[], sheets: string[], error?: string}}
 *   noLink：参考链接为空的行；sheets：有“参考链接”列的工作表
 */
export function parseListingBook(sheets) {
  const acc = { links: new Map(), rowsBySku: new Map(), noLink: [], problems: [] };
  const used = (sheets ?? []).filter((s) => !s.hidden && parseSheet(s, acc)).map((s) => s.name);
  if (!used.length) return { links: [], values: [], noLink: [], problems: [], sheets: [], error: LISTING_HEADER_MISSING };
  const values = settleValues(acc.rowsBySku, acc.problems);
  return { links: [...acc.links.values()], values, noLink: acc.noLink, problems: acc.problems, sheets: used };
}

/**
 * 上架表里的值写进商品的编辑内容（给 itemRepo.saveEditsMany）：价格/ERP/型号 → VC 自营，条形码 → UPC；
 * 表格里填了的覆盖原来的，已发布的商品不改
 * @param {ListingValues} values
 * @returns {(edits: object, item: object) => object}
 */
export function listingEdit(values) {
  return (edits, item) => {
    if (isArchived(item)) return edits;
    return Object.entries(values).reduce((next, [key, value]) => applyReviewValue(next, key, value), edits ?? {});
  };
}
