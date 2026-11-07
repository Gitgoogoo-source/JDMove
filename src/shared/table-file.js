// 读用户导入的表格文件 → 二维字符串数组（纯函数）：.xlsx（Excel / WPS）、.csv / .tsv / .txt。
// 中文 Windows 的 Excel 另存的 CSV 是 GBK 编码，这里按 UTF-8 → GBK 依次尝试；“Unicode 文本”是带 BOM 的 UTF-16
import { readXlsxRows, MAX_SHEET_ROWS, TOO_MANY_ROWS } from './xlsx-read.js';

export const MAX_TABLE_FILE_BYTES = 20 * 1024 * 1024;
const DELIMITERS = [',', '\t', ';'];

const startsWith = (bytes, sig) => sig.every((b, i) => bytes[i] === b);
const ZIP_SIG = [0x50, 0x4b, 0x03, 0x04];
// Excel 97-2003 (.xls) / WPS (.et) 的复合文档格式
const OLE_SIG = [0xd0, 0xcf, 0x11, 0xe0];

/** 文本文件解码：BOM 优先；没有 BOM 时严格按 UTF-8，失败就按 GBK */
export function decodeTableText(bytes) {
  if (startsWith(bytes, [0xef, 0xbb, 0xbf])) return new TextDecoder('utf-8').decode(bytes.subarray(3));
  if (startsWith(bytes, [0xff, 0xfe])) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  if (startsWith(bytes, [0xfe, 0xff])) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('gbk').decode(bytes);
  }
}

// 识别分隔符时看的行数（表头上面可能有标题、说明行）
const GUESS_LINES = 10;

/**
 * 分隔符：前几行非空文本里，出现在最多行里的那个（逗号 / Tab / 分号，引号里的不算）；行数相同时比出现次数
 */
function guessDelimiter(text) {
  const lines = text
    .split(/\r\n|\n|\r/)
    .filter((l) => l.trim())
    .slice(0, GUESS_LINES)
    .map((l) => l.replace(/"[^"]*"/g, ''));
  const score = (d) => {
    const counts = lines.map((l) => l.split(d).length - 1);
    return { lines: counts.filter((n) => n > 0).length, total: counts.reduce((a, b) => a + b, 0) };
  };
  const best = DELIMITERS.map((d) => ({ d, ...score(d) })).sort((a, b) => b.lines - a.lines || b.total - a.total)[0];
  return best.lines > 0 ? best.d : ',';
}

/**
 * CSV / TSV 文本 → 行（RFC 4180：双引号包住的字段里可以有分隔符、换行，"" 表示一个引号）
 * @param {string} text
 * @param {string} [delimiter] 不传时自动识别
 * @returns {string[][]}
 */
export function parseDelimited(text, delimiter = guessDelimiter(text)) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const endField = () => {
    row.push(field);
    field = '';
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch !== '"') field += ch;
      else if (text[i + 1] === '"') field += text[++i];
      else quoted = false;
    } else if (ch === '"' && field === '') quoted = true;
    else if (ch === delimiter) endField();
    else if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      endRow();
    } else field += ch;
  }
  if (field !== '' || row.length) endRow();
  return rows;
}

const hasContent = (row) => row.some((c) => String(c ?? '').trim());

/** 超过行数上限时报错（不悄悄丢掉后面的行）；上限之后只有空行时去掉 */
function limitRows(rows) {
  if (rows.length <= MAX_SHEET_ROWS) return rows;
  if (rows.slice(MAX_SHEET_ROWS).some(hasContent)) throw new Error(TOO_MANY_ROWS);
  return rows.slice(0, MAX_SHEET_ROWS);
}

/**
 * 按文件内容（不看扩展名）识别格式并读出行
 * @param {Uint8Array} bytes
 * @returns {Promise<{rows: string[][], format: 'xlsx'|'csv'}>}
 */
export async function readTableFile(bytes) {
  if (!bytes?.length) throw new Error('文件是空的');
  if (bytes.length > MAX_TABLE_FILE_BYTES) throw new Error('文件太大（超过 20MB），请只保留需要导入的行');
  if (startsWith(bytes, ZIP_SIG)) return { rows: await readXlsxRows(bytes), format: 'xlsx' };
  if (startsWith(bytes, OLE_SIG)) {
    throw new Error('不支持 .xls（Excel 97-2003）/ .et 格式，请在 Excel 或 WPS 里“另存为” .xlsx 或 CSV 后再导入');
  }
  return { rows: limitRows(parseDelimited(decodeTableText(bytes))), format: 'csv' };
}
