// 读 .xlsx 的第一个工作表 → 二维字符串数组（纯函数，不依赖 DOM，方便在 Node 里测试）。
// 只取单元格的值：共享字符串、内联字符串、公式结果、数字（原样文本，不按单元格格式显示）；
// 行号与 Excel 一致（第 n 行 = rows[n-1]），中间的空行留空数组
import { readZipEntries, unzipEntry } from './zip.js';

// 防止异常大的文件卡住面板：工作表 XML 解压后的上限、读取的最大行数
const MAX_SHEET_BYTES = 60 * 1024 * 1024;
export const MAX_SHEET_ROWS = 20000;
export const TOO_MANY_ROWS = `表格超过 ${MAX_SHEET_ROWS} 行，请分成几个表格分别导入`;
const MAX_COLUMNS = 200;

const MAX_CODE_POINT = 0x10ffff;
const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** XML 文本解码：实体 + Excel 的 _xHHHH_ 转义（如 _x000D_ 回车） */
export function decodeXmlText(s) {
  return String(s ?? '')
    .replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e) => {
      if (e[0] !== '#') return NAMED_ENTITIES[e.toLowerCase()] ?? m;
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code >= 0 && code <= MAX_CODE_POINT ? String.fromCodePoint(code) : m;
    })
    .replace(/_x([0-9A-Fa-f]{4})_/g, (m, hex) => String.fromCharCode(parseInt(hex, 16)));
}

// 标签可能带命名空间前缀（<x:c>、<x:t>）
const P = '(?:[\\w-]+:)?';
const TEXT_RE = new RegExp(`<${P}t(?:\\s[^>]*)?>([\\s\\S]*?)</${P}t>`, 'g');
const PHONETIC_RE = new RegExp(`<${P}rPh\\b[\\s\\S]*?</${P}rPh>`, 'g');
const SI_RE = new RegExp(`<${P}si\\b[^>]*?(?:/>|>([\\s\\S]*?)</${P}si>)`, 'g');
const ROW_RE = new RegExp(`<${P}row\\b([^>]*?)(?:/>|>([\\s\\S]*?)</${P}row>)`, 'g');
const CELL_RE = new RegExp(`<${P}c\\b([^>]*?)(?:/>|>([\\s\\S]*?)</${P}c>)`, 'g');
const VALUE_RE = new RegExp(`<${P}v(?:\\s[^>]*)?>([\\s\\S]*?)</${P}v>`);
const INLINE_RE = new RegExp(`<${P}is\\b[^>]*>([\\s\\S]*?)</${P}is>`);
const SHEET_RE = new RegExp(`<${P}sheet\\b([^>]*?)/?>`, 'g');
const REL_RE = new RegExp(`<${P}Relationship\\b([^>]*?)/?>`, 'g');

const attr = (attrs, name) => attrs.match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*"([^"]*)"`))?.[1];

/** 富文本 / 普通文本的全部文字（不含日文注音） */
const richText = (xml) => [...String(xml ?? '').replace(PHONETIC_RE, '').matchAll(TEXT_RE)].map((m) => decodeXmlText(m[1])).join('');

export function parseSharedStrings(xml) {
  return [...String(xml ?? '').matchAll(SI_RE)].map((m) => richText(m[1]));
}

/** A → 0，Z → 25，AA → 26 */
export function columnIndex(ref) {
  const letters = String(ref ?? '').match(/^[A-Za-z]+/)?.[0];
  if (!letters) return -1;
  return [...letters.toUpperCase()].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
}

function cellValue(attrs, inner, shared) {
  const type = attr(attrs, 't') ?? 'n';
  if (type === 'inlineStr') return richText(inner.match(INLINE_RE)?.[1]);
  const raw = inner.match(VALUE_RE)?.[1];
  if (raw == null) return '';
  if (type === 's') return shared[Number(raw)] ?? '';
  if (type === 'b') return raw.trim() === '1' ? 'TRUE' : 'FALSE';
  return decodeXmlText(raw);
}

function parseRowCells(inner, shared) {
  const cells = [];
  for (const m of String(inner ?? '').matchAll(CELL_RE)) {
    const ref = attr(m[1], 'r');
    const col = ref ? columnIndex(ref) : cells.length;
    if (col < 0 || col >= MAX_COLUMNS) continue;
    while (cells.length < col) cells.push('');
    cells[col] = cellValue(m[1], m[2] ?? '', shared);
  }
  return cells;
}

/**
 * 工作表 XML → 行数组
 * @param {string} xml
 * @param {string[]} shared 共享字符串
 * @returns {string[][]}
 */
export function parseSheetRows(xml, shared = []) {
  const rows = [];
  for (const m of String(xml ?? '').matchAll(ROW_RE)) {
    const r = Number(attr(m[1], 'r'));
    const index = Number.isInteger(r) && r > 0 ? r - 1 : rows.length;
    const cells = parseRowCells(m[2], shared);
    // Excel 常在很靠下的位置留只有格式、没有内容的行：跳过；有内容的超出上限时报错，不悄悄丢行
    if (index >= MAX_SHEET_ROWS) {
      if (cells.some((c) => String(c).trim())) throw new Error(TOO_MANY_ROWS);
      continue;
    }
    while (rows.length < index) rows.push([]);
    rows[index] = cells;
  }
  return rows;
}

/** 工作簿里第一个工作表的文件路径（按工作簿里的顺序，不按文件名） */
export function firstSheetPath(workbookXml, relsXml, names) {
  const firstSheet = [...String(workbookXml ?? '').matchAll(SHEET_RE)][0];
  const relId = firstSheet?.[1].match(/(?:^|\s)[\w-]+:id\s*=\s*"([^"]*)"/)?.[1];
  const rel = [...String(relsXml ?? '').matchAll(REL_RE)].find((m) => attr(m[1], 'Id') === relId);
  const target = rel ? attr(rel[1], 'Target') : null;
  if (target) {
    const path = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`;
    if (names.includes(path)) return path;
  }
  const sheets = names.filter((n) => /^xl\/worksheets\/sheet\d*\.xml$/.test(n)).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  return sheets[0] ?? null;
}

const textOf = async (entries, name, inflate) => {
  const entry = entries.get(name);
  return entry ? new TextDecoder().decode(await unzipEntry(entry, inflate)) : '';
};

/**
 * .xlsx 文件内容 → 第一个工作表的行
 * @param {Uint8Array} bytes
 * @param {{inflate?: (data: Uint8Array) => Promise<Uint8Array>}} [opts]
 * @returns {Promise<string[][]>}
 */
export async function readXlsxRows(bytes, { inflate } = {}) {
  const entries = readZipEntries(bytes);
  const names = [...entries.keys()];
  if (!names.some((n) => n.startsWith('xl/'))) throw new Error('压缩包里没有 Excel 工作表，请确认选的是 .xlsx 表格');
  const sheetPath = firstSheetPath(await textOf(entries, 'xl/workbook.xml', inflate), await textOf(entries, 'xl/_rels/workbook.xml.rels', inflate), names);
  if (!sheetPath) throw new Error('表格里没有工作表');
  if (entries.get(sheetPath).size > MAX_SHEET_BYTES) throw new Error('工作表太大，请只保留需要导入的行');
  const shared = parseSharedStrings(await textOf(entries, 'xl/sharedStrings.xml', inflate));
  return parseSheetRows(await textOf(entries, sheetPath, inflate), shared);
}
