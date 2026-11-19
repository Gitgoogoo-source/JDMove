// 上架总表（纯函数）：发布成功的商品记成总表的行，追加到用户指定文件夹（项目根目录）里的 上架总表.xlsx。
// 每个京东分配的 SKU 一行；文件里原有的行原样保留（用户手动改过的也不动），按“商品编码sku”去重；
// 用户自己加的列保留，缺了的标准列补在最后
import { itemBrand } from './brand-folders.js';

export const MASTER_FILE_NAME = '上架总表.xlsx';
export const MASTER_SHEET_NAME = '上架总表';

/**
 * 总表的列：key 记录里的字段；number 写成数字；text 设成文本格式（长数字不变成科学计数法）
 * @type {ReadonlyArray<{key: keyof MasterRecord, header: string, width: number, number?: boolean, text?: boolean}>}
 */
export const MASTER_COLUMNS = Object.freeze([
  { key: 'brand', header: '品牌', width: 14 },
  { key: 'name', header: '商品上架名称', width: 46 },
  { key: 'marketPrice', header: '市场价', width: 10, number: true },
  { key: 'jdPrice', header: '京东价', width: 10, number: true },
  { key: 'costPrice', header: '采购价', width: 10, number: true },
  { key: 'agreementPrice', header: '协议价', width: 10, number: true },
  { key: 'sku', header: '商品编码sku', width: 16, text: true },
  { key: 'refUrl', header: '上架参考链接', width: 42, text: true },
  { key: 'upc', header: '69码', width: 16, text: true },
  { key: 'publishedAt', header: '上架时间', width: 18 },
]);

/**
 * @typedef {{id: string, sku: string, brand: string, name: string, marketPrice: number|null, jdPrice: number|null,
 *   costPrice: number|null, agreementPrice: number|null, refUrl: string, upc: string, publishedAt: number,
 *   sourceSku: string, writtenAt?: number}} MasterRecord
 *   sku：京东给店铺商品分配的 SKU（发布接口没返回时为空）；sourceSku：参考链接的 SKU；writtenAt：写进总表文件的时间
 * @typedef {{title?: string, brandTitle?: string, prices?: {marketPrice?: number, jdPrice?: number, costPrice?: number}, upc?: string}} PublishListing
 *   发布时实际填进页面的内容（publisher-vc 的 submitOutcome 带回）：brandTitle 是页面标题前面的品牌名
 */

const positive = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};
const clean = (s) => String(s ?? '').trim();
// 品牌名去掉括号里的英文名：“维达（Vinda）”在发布页标题前显示为“维达”
const brandShortName = (name) => clean(name).replace(/[（(][^）)]*[）)]/g, '').trim() || clean(name);

/** 商品上架名称：发布页标题前面带品牌名（商品审核列表里就是这样显示的）；标题本身已经以品牌开头时不重复 */
export function listingName(brandTitle, title) {
  const brand = clean(brandTitle);
  const text = clean(title);
  return !brand || text.startsWith(brand) ? text : `${brand}${text}`;
}

/** 发布页标题前面的品牌名：页面读到的优先，否则用品牌名去掉括号里的英文名 */
export const listingBrandTitle = (brandTitle, brandName) => clean(brandTitle) || brandShortName(brandName);

/**
 * 发布成功的商品 → 总表记录（每个京东分配的 SKU 一条；没拿到 SKU 时记一条，商品编码sku 留空）
 * @param {{item: object, res: {skuIds?: string[], listing?: PublishListing}, now?: number}} input
 * @returns {MasterRecord[]}
 */
export function masterRecords({ item, res, now = Date.now() }) {
  const listing = res?.listing ?? {};
  const brand = itemBrand(item);
  const title = clean(listing.title || item?.edits?.title || item?.product?.title);
  const name = listingName(listingBrandTitle(listing.brandTitle, brand), title);
  const prices = listing.prices ?? item?.edits?.vc ?? {};
  const base = {
    brand,
    name,
    marketPrice: positive(prices.marketPrice),
    jdPrice: positive(prices.jdPrice),
    costPrice: positive(prices.costPrice),
    agreementPrice: positive(item?.edits?.vc?.agreementPrice),
    refUrl: clean(item?.url),
    upc: clean(listing.upc),
    publishedAt: now,
    sourceSku: clean(item?.skuId ?? item?.id),
  };
  const skus = [...new Set((res?.skuIds ?? []).map(clean).filter(Boolean))];
  return (skus.length ? skus : ['']).map((sku) => ({ id: `${sku || `nosku-${base.sourceSku}`}-${now}`, sku, ...base }));
}

const pad2 = (n) => String(n).padStart(2, '0');

/** 上架时间：本地时间 2026-11-20 14:05 */
export function formatMasterTime(ms) {
  const d = new Date(ms);
  if (!Number.isFinite(d.getTime())) return '';
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

const headerKey = (s) => clean(s).replace(/\s+/g, '').toLowerCase();
const NUMBER_TEXT_RE = /^-?\d+(?:\.\d+)?$/;

/** 记录的一个格子：价格是数字，上架时间写成文字，没有的留空 */
const cellOf = (col, record) => (col.key === 'publishedAt' ? formatMasterTime(record.publishedAt) : record[col.key] ?? '');

/**
 * 把新记录合并进总表文件原有的行
 * @param {string[][]} existing 文件里原有的行（第一行是表头）；没有文件时为 []
 * @param {MasterRecord[]} records 待写入的记录
 * @returns {{header: string[], body: (string|number)[][], added: string[], duplicate: string[]}}
 *   added：写进去的记录 id；duplicate：文件里已有同一个商品编码sku、没有重复写的记录 id
 */
export function mergeMasterRows(existing, records) {
  const trimmed = (existing ?? []).filter((row, i) => i === 0 || (row ?? []).some((c) => clean(c)));
  const fileHeader = (trimmed[0] ?? []).map(clean);
  const known = new Set(fileHeader.map(headerKey));
  const header = [...fileHeader, ...MASTER_COLUMNS.map((c) => c.header).filter((h) => !known.has(headerKey(h)))];
  const index = new Map(MASTER_COLUMNS.map((c) => [c.key, header.findIndex((h) => headerKey(h) === headerKey(c.header))]));
  const numberCols = new Set(MASTER_COLUMNS.filter((c) => c.number).map((c) => index.get(c.key)));
  // 原有的行：价格列里的数字文字转回数字（读文件时格子都是文字），其余原样
  const body = trimmed.slice(1).map((row) => header.map((_, i) => {
    const v = clean(row?.[i]);
    return numberCols.has(i) && NUMBER_TEXT_RE.test(v) ? Number(v) : v;
  }));
  const skuCol = index.get('sku');
  const skus = new Set(body.map((row) => clean(row[skuCol])).filter(Boolean));
  const added = [];
  const duplicate = [];
  for (const record of records ?? []) {
    if (record.sku && skus.has(record.sku)) {
      duplicate.push(record.id);
      continue;
    }
    const row = header.map(() => '');
    for (const col of MASTER_COLUMNS) row[index.get(col.key)] = cellOf(col, record);
    body.push(row);
    if (record.sku) skus.add(record.sku);
    added.push(record.id);
  }
  return { header, body, added, duplicate };
}

/**
 * 总表工作表（给 buildXlsx）：标准列按列定义设宽度和文本格式，用户自己加的列给默认宽度
 * @param {string[]} header
 * @param {(string|number)[][]} body
 * @returns {import('./xlsx-write.js').SheetSpec}
 */
export function masterSheetSpec(header, body) {
  const colOf = (h) => MASTER_COLUMNS.find((c) => headerKey(c.header) === headerKey(h));
  return {
    name: MASTER_SHEET_NAME,
    rows: [header, ...body],
    widths: header.map((h) => colOf(h)?.width ?? 14),
    textColumns: header.map((h, i) => (colOf(h)?.text ? i : -1)).filter((i) => i >= 0),
  };
}

/**
 * 文件里的哪张表是总表：叫“上架总表”的，没有就第一张
 * @param {{name: string, rows: string[][], hidden?: boolean}[]} sheets
 */
export function pickMasterSheet(sheets) {
  const list = sheets ?? [];
  return list.find((s) => s.name === MASTER_SHEET_NAME) ?? list[0] ?? null;
}
