// 上架总表：发布成功的商品 → 总表记录 → 追加进 上架总表.xlsx（原有的行和用户自己的列保留，按商品编码sku 去重）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MASTER_COLUMNS,
  MASTER_FILE_NAME,
  formatMasterTime,
  listingName,
  masterRecords,
  masterSheetSpec,
  mergeMasterRows,
  pickMasterSheet,
} from '../src/shared/master-sheet.js';
import { createMasterRepository, MASTER_KEY } from '../src/shared/master-store.js';
import { appendMasterFile } from '../src/lib/master-file.js';
import { itemBrand, UNKNOWN_BRAND } from '../src/shared/brand-folders.js';
import { buildXlsx } from '../src/shared/xlsx-write.js';
import { readXlsxSheets } from '../src/shared/xlsx-read.js';
import { fakeDir } from './helpers/fake-fs.js';

const HEADER = MASTER_COLUMNS.map((c) => c.header);
const AT = new Date(2026, 10, 20, 14, 5).getTime();

const item = (extra = {}) => ({
  id: '100114866451',
  skuId: '100114866451',
  url: 'https://item.jd.com/100114866451.html',
  edits: { vc: { marketPrice: 89.9, jdPrice: 69.9, costPrice: 50, agreementPrice: 55.5 } },
  product: { title: '维达（Vinda）抽纸 棉韧3层', brand: { name: '维达（Vinda）' } },
  ...extra,
});
const listing = { title: '棉韧抽纸 3层100抽*36包', brandTitle: '维达', prices: { marketPrice: 89.9, jdPrice: 69.9, costPrice: 50 }, upc: '6901236326411' };

test('总表的列：品牌、商品上架名称、市场价、京东价、采购价、协议价、商品编码sku、上架参考链接、69码、上架时间', () => {
  assert.deepEqual(HEADER, ['品牌', '商品上架名称', '市场价', '京东价', '采购价', '协议价', '商品编码sku', '上架参考链接', '69码', '上架时间']);
  assert.equal(MASTER_FILE_NAME, '上架总表.xlsx');
});

test('masterRecords：每个京东分配的 SKU 一条；名称=页面品牌名+标题；价格按填进页面的；协议价、参考链接、69码带上', () => {
  const records = masterRecords({ item: item(), res: { skuIds: ['100448634314', '100448634315', '100448634314'], listing }, now: AT });
  assert.deepEqual(records.map((r) => r.sku), ['100448634314', '100448634315']);
  assert.deepEqual(
    { ...records[0], id: undefined },
    {
      id: undefined,
      sku: '100448634314',
      brand: '维达（Vinda）',
      name: '维达棉韧抽纸 3层100抽*36包',
      marketPrice: 89.9,
      jdPrice: 69.9,
      costPrice: 50,
      agreementPrice: 55.5,
      refUrl: 'https://item.jd.com/100114866451.html',
      upc: '6901236326411',
      publishedAt: AT,
      sourceSku: '100114866451',
    },
  );
  assert.notEqual(records[0].id, records[1].id);
});

test('masterRecords：没拿到 SKU 时记一条、商品编码sku 留空；没有条形码、协议价时留空；页面没读到品牌名时用品牌去掉括号', () => {
  const plain = item({ edits: { vc: { marketPrice: 10, jdPrice: 9, costPrice: 5 } } });
  const [r] = masterRecords({ item: plain, res: { skuIds: [], listing: { ...listing, brandTitle: '', upc: '' } }, now: AT });
  assert.equal(r.sku, '');
  assert.equal(r.upc, '');
  assert.equal(r.agreementPrice, null);
  assert.equal(r.name, '维达棉韧抽纸 3层100抽*36包');
  assert.equal(r.marketPrice, 89.9, '价格以填进页面的为准');
});

test('listingName：标题已经以品牌开头时不重复', () => {
  assert.equal(listingName('维达', '维达抽纸'), '维达抽纸');
  assert.equal(listingName('', '抽纸'), '抽纸');
  assert.equal(listingName('维达', '抽纸'), '维达抽纸');
});

test('itemBrand：编辑里改过的品牌优先，没有品牌时为未识别品牌', () => {
  assert.equal(itemBrand({ product: { brand: { name: '华为（HUAWEI）' } } }), '华为（HUAWEI）');
  assert.equal(itemBrand({ edits: { brandName: ' 荣耀 ' }, product: { brand: { name: '华为' } } }), '荣耀');
  assert.equal(itemBrand({ product: null }), UNKNOWN_BRAND);
});

test('formatMasterTime：本地时间到分钟', () => {
  assert.equal(formatMasterTime(AT), '2026-11-20 14:05');
  assert.equal(formatMasterTime(NaN), '');
});

test('mergeMasterRows：没有文件时建表头；新记录追加在后面，价格是数字', () => {
  const records = masterRecords({ item: item(), res: { skuIds: ['100448634314'], listing }, now: AT });
  const res = mergeMasterRows([], records);
  assert.deepEqual(res.header, HEADER);
  assert.deepEqual(res.body, [['维达（Vinda）', '维达棉韧抽纸 3层100抽*36包', 89.9, 69.9, 50, 55.5, '100448634314', 'https://item.jd.com/100114866451.html', '6901236326411', '2026-11-20 14:05']]);
  assert.deepEqual(res.added, [records[0].id]);
});

test('mergeMasterRows：原有的行原样保留（手动改过的也不动），同一个商品编码sku 不重复写；用户加的列保留，缺的标准列补在最后', () => {
  const existing = [
    ['品牌', '商品上架名称', '我的备注', '市场价', '京东价', '采购价', '协议价', '商品编码sku', '上架参考链接', '69码'],
    ['维达', '手动改过的名字', '好卖', '100', '90', '60.5', '', '100448634314', 'https://item.jd.com/1.html', ''],
    ['', '', '', '', '', '', '', '', '', ''],
  ];
  const records = [
    ...masterRecords({ item: item(), res: { skuIds: ['100448634314'], listing }, now: AT }),
    ...masterRecords({ item: item(), res: { skuIds: ['100448634999'], listing }, now: AT + 1 }),
    ...masterRecords({ item: item(), res: { skuIds: [], listing }, now: AT + 2 }),
  ];
  const res = mergeMasterRows(existing, records);
  assert.deepEqual(res.header, [...existing[0], '上架时间']);
  assert.deepEqual(res.body[0], ['维达', '手动改过的名字', '好卖', 100, 90, 60.5, '', '100448634314', 'https://item.jd.com/1.html', '', '']);
  assert.equal(res.body.length, 3, '空行去掉，已有的 SKU 没再写，新 SKU 和没 SKU 的各一行');
  assert.equal(res.body[1][2], '', '用户自己的列在新行里留空');
  assert.equal(res.body[1][7], '100448634999');
  assert.equal(res.body[1][10], '2026-11-20 14:05');
  assert.equal(res.body[2][7], '');
  assert.deepEqual(res.duplicate, [records[0].id]);
  assert.deepEqual(res.added, [records[1].id, records[2].id]);
});

test('masterSheetSpec：商品编码sku、参考链接、69码设成文本格式；pickMasterSheet 找“上架总表”，没有就第一张', () => {
  const spec = masterSheetSpec(HEADER, []);
  assert.equal(spec.name, '上架总表');
  assert.deepEqual(spec.textColumns, [6, 7, 8]);
  assert.equal(spec.widths.length, HEADER.length);
  assert.equal(pickMasterSheet([{ name: 'a' }, { name: '上架总表' }]).name, '上架总表');
  assert.equal(pickMasterSheet([{ name: 'a' }]).name, 'a');
  assert.equal(pickMasterSheet([]), null);
});

function memory() {
  const data = {};
  return { get: async (k) => structuredClone(data[k]), set: async (k, v) => (data[k] = structuredClone(v)), data };
}

test('createMasterRepository：新记录待写入；写进文件后标记，同一条不重复添加', async () => {
  const storage = memory();
  const repo = createMasterRepository(storage);
  const records = masterRecords({ item: item(), res: { skuIds: ['1004486343141', '1004486343142'], listing }, now: AT });
  await repo.add(records);
  await repo.add(records);
  assert.equal((await repo.list()).length, 2);
  await repo.markWritten([records[0].id], 99);
  assert.deepEqual((await repo.pending()).map((r) => r.id), [records[1].id]);
  assert.equal(storage.data[MASTER_KEY][0].writtenAt, 99);
});

test('appendMasterFile：没有文件时新建；再写一次时保留原有的行和用户加的工作表，按商品编码sku 去重', async () => {
  const dir = fakeDir('JDMove');
  const first = masterRecords({ item: item(), res: { skuIds: ['100448634314'], listing }, now: AT });
  const res1 = await appendMasterFile(dir, first);
  assert.equal(res1.file, 'JDMove/上架总表.xlsx');
  assert.deepEqual(res1.added, [first[0].id]);

  // 用户在 Excel 里改了名字、加了一张自己的表
  const [sheet] = await readXlsxSheets(dir.read(MASTER_FILE_NAME));
  const edited = sheet.rows.map((row, i) => (i === 1 ? row.map((c, j) => (j === 1 ? '我改的名字' : c)) : row));
  await (await dir.getFileHandle(MASTER_FILE_NAME)).createWritable().then((w) => w.write(buildXlsx([{ name: '上架总表', rows: edited }, { name: '笔记', rows: [['随便写']] }])));

  const second = [...first, ...masterRecords({ item: item(), res: { skuIds: ['100448634999'], listing }, now: AT + 60e3 })];
  const res2 = await appendMasterFile(dir, second);
  assert.deepEqual(res2.duplicate, [first[0].id]);
  assert.equal(res2.rows, 2);
  const sheets = await readXlsxSheets(dir.read(MASTER_FILE_NAME));
  assert.deepEqual(sheets.map((s) => s.name), ['上架总表', '笔记']);
  assert.deepEqual(sheets[0].rows.map((r) => r[1]), ['商品上架名称', '我改的名字', '维达棉韧抽纸 3层100抽*36包']);
  assert.deepEqual(sheets[0].rows.map((r) => r[6]), ['商品编码sku', '100448634314', '100448634999']);
  assert.deepEqual(sheets[1].rows, [['随便写']]);
});

test('appendMasterFile：文件读不出来时不覆盖', async () => {
  const dir = fakeDir('JDMove');
  await (await dir.getFileHandle(MASTER_FILE_NAME, { create: true })).createWritable().then((w) => w.write(new Uint8Array([1, 2, 3])));
  await assert.rejects(appendMasterFile(dir, masterRecords({ item: item(), res: { skuIds: ['1'], listing }, now: AT })), /读不出来/);
  assert.deepEqual([...dir.read(MASTER_FILE_NAME)], [1, 2, 3]);
});
