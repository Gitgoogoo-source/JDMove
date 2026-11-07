// 表格文件读写：ZIP、.xlsx（插件导出的不压缩模板、Excel 保存的 deflate 文件）、CSV 编码与引号
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { buildZip, readZipEntries, unzipEntry, crc32 } from '../src/shared/zip.js';
import { buildXlsx, columnName, escapeXml } from '../src/shared/xlsx-write.js';
import { readXlsxRows, parseSheetRows, parseSharedStrings, columnIndex, decodeXmlText, firstSheetPath } from '../src/shared/xlsx-read.js';
import { decodeTableText, parseDelimited, readTableFile } from '../src/shared/table-file.js';

const enc = new TextEncoder();
const dec = new TextDecoder();

test('crc32: 与标准值一致', () => {
  assert.equal(crc32(enc.encode('123456789')), 0xcbf43926);
  assert.equal(crc32(new Uint8Array()), 0);
});

test('buildZip / readZipEntries: 不压缩和 deflate 压缩的文件都能读回', async () => {
  const files = [
    { name: 'a.txt', data: enc.encode('hello') },
    { name: 'dir/中文.xml', data: enc.encode('<x>你好</x>'.repeat(50)) },
  ];
  for (const opts of [{}, { deflate: deflateRawSync }]) {
    const entries = readZipEntries(buildZip(files, opts));
    assert.deepEqual([...entries.keys()], ['a.txt', 'dir/中文.xml']);
    assert.equal(dec.decode(await unzipEntry(entries.get('a.txt'))), 'hello');
    assert.equal(dec.decode(await unzipEntry(entries.get('dir/中文.xml'))), '<x>你好</x>'.repeat(50));
  }
});

test('readZipEntries: 不是压缩包、或被截断时报错', () => {
  assert.throws(() => readZipEntries(enc.encode('not a zip at all, just text')), /损坏|不是 \.xlsx/);
  const zip = buildZip([{ name: 'a.txt', data: enc.encode('hello world') }]);
  assert.throws(() => readZipEntries(zip.subarray(10)), /损坏|不是 \.xlsx/);
});

test('columnName / columnIndex 互逆', () => {
  for (const [i, name] of [[0, 'A'], [25, 'Z'], [26, 'AA'], [51, 'AZ'], [701, 'ZZ'], [702, 'AAA']]) {
    assert.equal(columnName(i), name);
    assert.equal(columnIndex(`${name}12`), i);
  }
  assert.equal(columnIndex('12'), -1);
});

test('decodeXmlText / escapeXml: 实体、数字字符引用、Excel 的 _x000D_ 转义', () => {
  assert.equal(decodeXmlText('a&amp;b&lt;c&gt;&quot;&apos;&#20013;&#x6587;_x000D_'), 'a&b<c>"\'中文\r');
  assert.equal(escapeXml('a&b<c>"\u0001'), 'a&amp;b&lt;c&gt;&quot;');
});

test('buildXlsx → readXlsxRows: 字符串、数字、空格子、中文工作表名都能原样读回，只读第一个工作表', async () => {
  const rows = [
    ['商品链接', 'SKU', '京东价'],
    ['https://item.jd.com/100114866451.html', '100114866451', 69.9],
    [],
    ['https://item.jd.com/100000000001.html?a=1&b=<2>', '', 0.5],
  ];
  const bytes = buildXlsx([
    { name: '商品', rows, widths: [40, 16], textColumns: [1] },
    { name: '填写说明', rows: [['别读我']] },
  ]);
  const back = await readXlsxRows(bytes);
  assert.deepEqual(back, [
    ['商品链接', 'SKU', '京东价'],
    ['https://item.jd.com/100114866451.html', '100114866451', '69.9'],
    [],
    ['https://item.jd.com/100000000001.html?a=1&b=<2>', '', '0.5'],
  ]);
});

test('parseSharedStrings: 富文本拼接、去掉注音、空字符串', () => {
  const xml =
    '<sst><si><t>京东价</t></si><si><r><rPr><b/></rPr><t>采购</t></r><r><t xml:space="preserve">员 ERP</t></r></si>' +
    '<si><t>漢字</t><rPh sb="0" eb="2"><t>かんじ</t></rPh></si><si><t/></si></sst>';
  assert.deepEqual(parseSharedStrings(xml), ['京东价', '采购员 ERP', '漢字', '']);
});

test('parseSheetRows: 共享字符串、公式结果、布尔、跳过的列和行按位置补空', () => {
  const xml =
    '<worksheet><sheetData>' +
    '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="s"><v>1</v></c></row>' +
    '<row r="3"><c r="A3"><v>100114866451</v></c><c r="B3" t="str"><f>A1&amp;"x"</f><v>链接x</v></c>' +
    '<c r="C3"><f>B2*1.1</f><v>76.890000000000001</v></c><c r="D3" t="b"><v>1</v></c><c r="E3" s="2"/></row>' +
    '<row r="4"><c r="B4" t="inlineStr"><is><t>内联</t></is></c></row>' +
    '</sheetData></worksheet>';
  assert.deepEqual(parseSheetRows(xml, ['链接', '京东价']), [
    ['链接', '', '京东价'],
    [],
    ['100114866451', '链接x', '76.890000000000001', 'TRUE', ''],
    ['', '内联'],
  ]);
});

test('parseSheetRows: 带命名空间前缀的标签（x:row / x:c）', () => {
  const xml = '<x:worksheet><x:sheetData><x:row r="1"><x:c r="B1" t="inlineStr"><x:is><x:t>SKU</x:t></x:is></x:c></x:row></x:sheetData></x:worksheet>';
  assert.deepEqual(parseSheetRows(xml), [['', 'SKU']]);
});

test('firstSheetPath: 按工作簿顺序找第一个工作表，支持绝对路径；对不上时退回 sheet1', () => {
  const wb = '<workbook><sheets><sheet name="商品" sheetId="5" r:id="rId9"/><sheet name="说明" sheetId="1" r:id="rId1"/></sheets></workbook>';
  const rels = '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId9" Target="/xl/worksheets/sheet7.xml"/></Relationships>';
  const names = ['xl/worksheets/sheet1.xml', 'xl/worksheets/sheet7.xml'];
  assert.equal(firstSheetPath(wb, rels, names), 'xl/worksheets/sheet7.xml');
  assert.equal(firstSheetPath('', '', ['xl/worksheets/sheet10.xml', 'xl/worksheets/sheet2.xml']), 'xl/worksheets/sheet2.xml');
});

test('readXlsxRows: Excel 保存的 deflate 压缩、带共享字符串的文件', async () => {
  const parts = {
    '[Content_Types].xml': '<Types/>',
    'xl/workbook.xml': '<workbook><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/sharedStrings.xml': '<sst><si><t>商品链接</t></si><si><t>京东价</t></si><si><t>https://item.jd.com/100114866451.html</t></si></sst>',
    'xl/worksheets/sheet1.xml':
      '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>' +
      '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>59.9</v></c></row></sheetData></worksheet>',
  };
  const zip = buildZip(Object.entries(parts).map(([name, xml]) => ({ name, data: enc.encode(xml) })), { deflate: deflateRawSync });
  assert.deepEqual(await readXlsxRows(zip), [
    ['商品链接', '京东价'],
    ['https://item.jd.com/100114866451.html', '59.9'],
  ]);
});

test('decodeTableText: UTF-8（有无 BOM）、GBK（中文 Excel 另存的 CSV）、UTF-16（Unicode 文本）', () => {
  assert.equal(decodeTableText(new Uint8Array([0xef, 0xbb, 0xbf, ...enc.encode('京东价')])), '京东价');
  assert.equal(decodeTableText(enc.encode('京东价')), '京东价');
  // “京东价” 的 GBK 编码
  assert.equal(decodeTableText(new Uint8Array([0xbe, 0xa9, 0xb6, 0xab, 0xbc, 0xdb])), '京东价');
  const utf16 = new Uint8Array([0xff, 0xfe, 0xac, 0x4e, 0x1c, 0x4e]);
  assert.equal(decodeTableText(utf16), '京东');
});

test('parseDelimited: 引号里的逗号/换行/双引号、CRLF、Tab 分隔自动识别', () => {
  const csv = '商品链接,京东价,备注\r\n"https://item.jd.com/1.html?a=1,2",69.9,"说""明""\n第二行"\r\n,,\r\n';
  assert.deepEqual(parseDelimited(csv), [
    ['商品链接', '京东价', '备注'],
    ['https://item.jd.com/1.html?a=1,2', '69.9', '说"明"\n第二行'],
    ['', '', ''],
  ]);
  assert.deepEqual(parseDelimited('商品链接\t京东价\nhttps://item.jd.com/2.html\t1,299.00'), [
    ['商品链接', '京东价'],
    ['https://item.jd.com/2.html', '1,299.00'],
  ]);
});

test('readTableFile: 按内容识别 xlsx / csv，拒绝 .xls 和空文件', async () => {
  const xlsx = buildXlsx([{ name: 'S', rows: [['商品链接', '京东价'], ['x', 1]] }]);
  assert.deepEqual(await readTableFile(xlsx), { rows: [['商品链接', '京东价'], ['x', '1']], format: 'xlsx' });
  assert.deepEqual(await readTableFile(enc.encode('a,b\n1,2')), { rows: [['a', 'b'], ['1', '2']], format: 'csv' });
  await assert.rejects(readTableFile(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0, 0])), /不支持 \.xls/);
  await assert.rejects(readTableFile(new Uint8Array()), /空/);
});

test('parseDelimited: 表头上面有说明行时，按前几行判断分隔符（不只看第一行）', () => {
  assert.deepEqual(parseDelimited('title,a;b\n链接\t市场价\nhttp://x\t5'), [['title,a;b'], ['链接', '市场价'], ['http://x', '5']]);
});

test('超过 20000 行：有内容的行不悄悄丢掉而是报错；只有格式没有内容的行跳过；非法字符引用不报错', async () => {
  const { MAX_SHEET_ROWS } = await import('../src/shared/xlsx-read.js');
  const far = `<row r="${MAX_SHEET_ROWS + 5}"><c r="A${MAX_SHEET_ROWS + 5}" t="inlineStr"><is><t>x</t></is></c></row>`;
  assert.throws(() => parseSheetRows(`<sheetData><row r="1"><c r="A1"><v>1</v></c></row>${far}</sheetData>`), /超过 20000 行/);
  const styledOnly = `<sheetData><row r="1"><c r="A1"><v>1</v></c></row><row r="1048576" s="3"><c r="A1048576" s="3"/></row></sheetData>`;
  assert.deepEqual(parseSheetRows(styledOnly), [['1']]);
  const csv = `${'a\n'.repeat(MAX_SHEET_ROWS)}b\n`;
  await assert.rejects(readTableFile(enc.encode(csv)), /超过 20000 行/);
  assert.equal(decodeXmlText('&#x110000;&#65;'), '&#x110000;A');
});
