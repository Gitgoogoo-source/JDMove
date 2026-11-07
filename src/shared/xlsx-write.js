// 生成 .xlsx（纯函数）：导出给用户填写的模板。字符串写成内联字符串、数字写成数字；
// 标为“文本”的列（SKU、ERP）设成文本格式，Excel 不会把长数字显示成科学计数法；表头加粗并冻结
import { buildZip } from './zip.js';

const NS_MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const NS_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const NS_PKG_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const CT_PREFIX = 'application/vnd.openxmlformats-officedocument.spreadsheetml';
const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
// styles.xml 里 cellXfs 的下标
const STYLE_HEADER = 1;
const STYLE_TEXT = 2;
const SHEET_NAME_MAX = 31;

/**
 * @typedef {string|number|null|undefined} CellValue
 * @typedef {{name: string, rows: CellValue[][], widths?: number[], textColumns?: number[]}} SheetSpec
 *   rows[0] 是表头；widths：列宽（字符数）；textColumns：设成文本格式的列下标
 */

export const escapeXml = (s) =>
  String(s)
    // XML 1.0 不允许的控制字符
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** 0 → A，26 → AA */
export function columnName(index) {
  let n = index + 1;
  let name = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    name = String.fromCharCode(65 + rem) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}

function cellXml(value, ref, style) {
  const s = style ? ` s="${style}"` : '';
  if (typeof value === 'number' && Number.isFinite(value)) return `<c r="${ref}"${s}><v>${value}</v></c>`;
  return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
}

function rowXml(row, r, textColumns) {
  const cells = row
    .map((v, c) => {
      if (v == null || v === '') return '';
      const style = r === 0 ? STYLE_HEADER : textColumns.has(c) ? STYLE_TEXT : 0;
      return cellXml(v, `${columnName(c)}${r + 1}`, style);
    })
    .join('');
  return `<row r="${r + 1}">${cells}</row>`;
}

function colsXml(widths = [], textColumns) {
  if (!widths.length && !textColumns.size) return '';
  const count = Math.max(widths.length, ...[...textColumns].map((c) => c + 1));
  const cols = Array.from({ length: count }, (_, c) => {
    const width = widths[c] ? ` width="${widths[c]}" customWidth="1"` : ' width="12"';
    const style = textColumns.has(c) ? ` style="${STYLE_TEXT}"` : '';
    return `<col min="${c + 1}" max="${c + 1}"${width}${style}/>`;
  });
  return `<cols>${cols.join('')}</cols>`;
}

/** @param {SheetSpec} sheet */
export function sheetXml(sheet) {
  const textColumns = new Set(sheet.textColumns ?? []);
  const freeze = '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>';
  const rows = sheet.rows.map((row, r) => rowXml(row, r, textColumns)).join('');
  return `${XML_HEAD}<worksheet xmlns="${NS_MAIN}" xmlns:r="${NS_REL}">${freeze}${colsXml(sheet.widths, textColumns)}<sheetData>${rows}</sheetData></worksheet>`;
}

const STYLES_XML =
  `${XML_HEAD}<styleSheet xmlns="${NS_MAIN}">` +
  '<fonts count="2"><font><sz val="11"/><name val="宋体"/><family val="2"/></font><font><b/><sz val="11"/><name val="宋体"/><family val="2"/></font></fonts>' +
  '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
  '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
  '<cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
  '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
  '<xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs>' +
  '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
  '</styleSheet>';

/** 工作表名：Excel 不允许 []:*?/\，最长 31 个字符，不能重名 */
function sheetNames(sheets) {
  const used = new Set();
  return sheets.map((s, i) => {
    const base = String(s.name ?? '').replace(/[[\]:*?/\\]/g, '').trim().slice(0, SHEET_NAME_MAX) || `Sheet${i + 1}`;
    const name = used.has(base) ? `${base.slice(0, SHEET_NAME_MAX - 3)}(${i + 1})` : base;
    used.add(name);
    return name;
  });
}

function packageParts(sheets) {
  const names = sheetNames(sheets);
  const sheetOverrides = sheets
    .map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="${CT_PREFIX}.worksheet+xml"/>`)
    .join('');
  const contentTypes =
    `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    `<Override PartName="/xl/workbook.xml" ContentType="${CT_PREFIX}.sheet.main+xml"/>` +
    `<Override PartName="/xl/styles.xml" ContentType="${CT_PREFIX}.styles+xml"/>${sheetOverrides}</Types>`;
  const rootRels = `${XML_HEAD}<Relationships xmlns="${NS_PKG_REL}"><Relationship Id="rId1" Type="${NS_REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
  const sheetEls = names.map((n, i) => `<sheet name="${escapeXml(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('');
  const workbook = `${XML_HEAD}<workbook xmlns="${NS_MAIN}" xmlns:r="${NS_REL}"><sheets>${sheetEls}</sheets></workbook>`;
  const sheetRels = sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${NS_REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('');
  const stylesRel = `<Relationship Id="rId${sheets.length + 1}" Type="${NS_REL}/styles" Target="styles.xml"/>`;
  const workbookRels = `${XML_HEAD}<Relationships xmlns="${NS_PKG_REL}">${sheetRels}${stylesRel}</Relationships>`;
  return [
    ['[Content_Types].xml', contentTypes],
    ['_rels/.rels', rootRels],
    ['xl/workbook.xml', workbook],
    ['xl/_rels/workbook.xml.rels', workbookRels],
    ['xl/styles.xml', STYLES_XML],
    ...sheets.map((s, i) => [`xl/worksheets/sheet${i + 1}.xml`, sheetXml(s)]),
  ];
}

/**
 * @param {SheetSpec[]} sheets
 * @param {{now?: Date}} [opts]
 * @returns {Uint8Array} .xlsx 文件内容
 */
export function buildXlsx(sheets, opts = {}) {
  if (!sheets?.length) throw new Error('至少需要一个工作表');
  const encoder = new TextEncoder();
  return buildZip(packageParts(sheets).map(([name, xml]) => ({ name, data: encoder.encode(xml) })), opts);
}
