// 多工作表：写出带底色、隐藏工作表的 .xlsx，再按工作簿顺序读回全部工作表
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildXlsx, safeSheetNames, sheetXml } from '../src/shared/xlsx-write.js';
import { readXlsxSheets, sheetList } from '../src/shared/xlsx-read.js';
import { readTableBook } from '../src/shared/table-file.js';
import { readZipEntries, unzipEntry } from '../src/shared/zip.js';

const text = async (bytes, name) => new TextDecoder().decode(await unzipEntry(readZipEntries(bytes).get(name)));

test('buildXlsx → readXlsxSheets：按工作簿顺序读回全部工作表，带上是否隐藏', async () => {
  const bytes = buildXlsx([
    { name: '汇总', rows: [['a'], ['1']] },
    { name: '附表1-抽纸', rows: [['商品链接', '京东价'], ['x', 9.9]] },
    { name: '_meta', rows: [['key', 'value'], ['format', 'v1']], hidden: true },
  ]);
  const sheets = await readXlsxSheets(bytes);
  assert.deepEqual(
    sheets.map((s) => [s.name, s.hidden]),
    [
      ['汇总', false],
      ['附表1-抽纸', false],
      ['_meta', true],
    ],
  );
  assert.deepEqual(sheets[1].rows, [['商品链接', '京东价'], ['x', '9.9']]);
  assert.match(await text(bytes, 'xl/workbook.xml'), /name="_meta" sheetId="3" r:id="rId3" state="hidden"/);
});

test('sheetXml：标了底色的格子带样式，空格子标了底色也写出来；表头仍是加粗样式', () => {
  const xml = sheetXml({
    name: 's',
    rows: [
      ['h1', 'h2', 'h3'],
      ['v', '', 'w'],
    ],
    cellStyles: [[], ['error', 'error', 'warn']],
    textColumns: [2],
  });
  assert.match(xml, /<c r="A1" s="1"/);
  assert.match(xml, /<c r="A2" s="3" t="inlineStr">/);
  assert.match(xml, /<c r="B2" s="3"\/>/, '缺的必填项：空格子也标红');
  assert.match(xml, /<c r="C2" s="6" t="inlineStr">/, '文本列 + 橙色');
});

test('safeSheetNames：去掉不允许的字符、截到 31 个字、重名加序号', () => {
  const long = '家庭清洁/纸品 > 清洁纸品 > 抽纸 > 常规抽纸 > 很长很长的名字';
  const names = safeSheetNames(['附表1-抽纸:常规', long, long, '']);
  assert.equal(names[0], '附表1-抽纸常规');
  assert.ok(names[1].length <= 31 && !names[1].includes('/'));
  assert.notEqual(names[1], names[2]);
  assert.equal(names[3], 'Sheet4');
  const spaced = safeSheetNames(['附表1-Paper Towel Roll Holder Ab cd']);
  assert.deepEqual(safeSheetNames(spaced), spaced, '截断后不留尾部空格：再整理一次结果不变（写进文件的名字和 _meta 里的一致）');
});

test('sheetList：工作簿里没有对应关系时按文件名排序；readTableBook：CSV 当成一个工作表', async () => {
  const list = sheetList('', '', ['xl/worksheets/sheet10.xml', 'xl/worksheets/sheet2.xml']);
  assert.deepEqual(list.map((s) => s.path), ['xl/worksheets/sheet2.xml', 'xl/worksheets/sheet10.xml']);
  const book = await readTableBook(new TextEncoder().encode('参考链接\nhttps://item.jd.com/1000001.html'));
  assert.equal(book.format, 'csv');
  assert.deepEqual(book.sheets, [{ name: 'CSV', rows: [['参考链接'], ['https://item.jd.com/1000001.html']], hidden: false }]);
  const xlsx = await readTableBook(buildXlsx([{ name: 'A', rows: [['x']] }, { name: 'B', rows: [['y']] }]));
  assert.deepEqual(xlsx.sheets.map((s) => s.name), ['A', 'B']);
});

test('readXlsxSheets：某个工作表超过行数上限时只跳过它，其他工作表照读', async () => {
  const big = Array.from({ length: 20001 }, (_, i) => [`r${i}`]);
  const sheets = await readXlsxSheets(buildXlsx([{ name: '上架', rows: [['参考链接'], ['x']] }, { name: '对照表', rows: big }]));
  assert.deepEqual(sheets[0].rows, [['参考链接'], ['x']]);
  assert.equal(sheets[1].rows.length, 0);
  assert.match(sheets[1].error, /超过 20000 行/);
});
