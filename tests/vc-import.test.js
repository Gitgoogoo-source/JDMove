// 表格批量填写 VC 字段：表头识别、逐行校验、对照任务列表、合并编辑内容、模板
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseVcSheet,
  planVcImport,
  mergeVcImport,
  applyVcImport,
  findHeader,
  skuFromCell,
  parsePrice,
  normalizeHeader,
  vcTemplateSheets,
  TEMPLATE_HEADER,
  HEADER_MISSING,
} from '../src/shared/vc-import.js';
import { ownErp, vcErpCodes, withErp } from '../src/shared/vc-erp.js';
import { buildXlsx } from '../src/shared/xlsx-write.js';
import { readXlsxRows } from '../src/shared/xlsx-read.js';

const link = (sku) => `https://item.jd.com/${sku}.html`;
const HEADER = ['商品链接', 'SKU', '商品标题', '市场价', '京东价', '采购价', '采购员ERP', '销售员ERP'];
const item = (id, extra = {}) => ({ id, skuId: id, url: link(id), status: 'collected', product: { skuId: id, title: `商品${id}` }, edits: {}, ...extra });

test('normalizeHeader: 去掉空格、*、括号说明，英文转小写', () => {
  assert.equal(normalizeHeader(' *京东价（元） '), '京东价');
  assert.equal(normalizeHeader('采购员 ERP'), '采购员erp');
  assert.equal(normalizeHeader('SKU(核对用)'), 'sku');
});

test('findHeader: 表头上面有标题行时往下找；只有链接没有字段列时不算表头', () => {
  const rows = [['VC 价格表'], [], ['商品链接', '京东价（元）', '备注'], [link('100114866451'), '59.9']];
  assert.deepEqual(findHeader(rows), { row: 2, columns: { link: 0, jdPrice: 1 } });
  assert.equal(findHeader([['商品链接', '备注']]), null);
  assert.equal(parseVcSheet([['京东价'], ['59.9']]).error, HEADER_MISSING);
});

test('skuFromCell: 纯数字、Excel 存的精确科学计数法；显示成 1.00115E+11（丢位）时报错', () => {
  assert.deepEqual(skuFromCell(' 100114866451 '), { id: '100114866451' });
  assert.deepEqual(skuFromCell('100114866451.0'), { id: '100114866451' });
  assert.deepEqual(skuFromCell('1.00114866451E+11'), { id: '100114866451' });
  assert.match(skuFromCell('1.00115E+11').error, /科学计数法/);
  assert.match(skuFromCell('abc').error, /不是商品编号/);
});

test('parsePrice: ¥、元、千分位；小数位数和范围按 VC 页面规则', () => {
  assert.deepEqual(parsePrice('jdPrice', '¥69.90'), { value: 69.9 });
  assert.deepEqual(parsePrice('marketPrice', '1,299.00元'), { value: 1299 });
  assert.deepEqual(parsePrice('jdPrice', '76.890000000000001'), { value: 76.89 }, '公式的浮点误差');
  assert.deepEqual(parsePrice('costPrice', '50.1234'), { value: 50.1234 });
  assert.match(parsePrice('jdPrice', '69.999').error, /京东价.*最多 2 位小数/);
  assert.match(parsePrice('costPrice', '50.12345').error, /采购价.*最多 4 位小数/);
  assert.match(parsePrice('jdPrice', '0').error, /超出范围/);
  assert.match(parsePrice('jdPrice', '12,5').error, /不是数字/, '欧式小数逗号不猜');
  assert.match(parsePrice('marketPrice', '#N/A').error, /市场价.*不是数字/);
});

test('parseVcSheet: 以链接为准取 SKU；空格子不修改；只有链接没填值的行算“未填写”', () => {
  const rows = [
    HEADER,
    [link('100114866451'), '100114866451', '维达抽纸', '89.9', '69.9', '50', 'xudezhi.6', 'xudezhi.6'],
    [link('100000000002'), '', '', '', '59', '', '', ''],
    [link('100000000003'), '100000000003', '只有链接'],
    [],
    ['item.jd.com/100000000004.html?spm=1', '', '', '', '', '', 'zhangsan', ''],
  ];
  const res = parseVcSheet(rows);
  assert.deepEqual(res.errors, []);
  assert.equal(res.blank, 1);
  assert.deepEqual(res.columns, ['市场价', '京东价', '采购价', '采购员ERP', '销售员ERP']);
  assert.deepEqual(res.entries, [
    { row: 2, skuId: '100114866451', values: { marketPrice: 89.9, jdPrice: 69.9, costPrice: 50, buyer: 'xudezhi.6', saler: 'xudezhi.6' } },
    { row: 3, skuId: '100000000002', values: { jdPrice: 59 } },
    { row: 6, skuId: '100000000004', values: { buyer: 'zhangsan' } },
  ]);
});

test('parseVcSheet: 一行有一个值不合规就整行不导入，写明行号和原因', () => {
  const rows = [
    HEADER,
    [link('100000000001'), '', '', '89.9', '69.999', '50', '徐德志', ''],
    ['', '', '', '89.9', '69.9'],
    ['https://item.jd.com/abc.html', '', '', '10'],
    [link('100000000005'), '100000000006', '', '10'],
    [link('100000000007'), '1.00115E+11', '', '10'],
  ];
  const res = parseVcSheet(rows);
  assert.deepEqual(res.entries.map((e) => e.row), [6], 'SKU 列丢位不影响以链接为准');
  const byRow = Object.fromEntries(res.errors.map((e) => [e.row, e.message]));
  assert.match(byRow[2], /京东价“69\.999”最多 2 位小数；采购员ERP“徐德志”格式不对/);
  assert.match(byRow[3], /没有填商品链接/);
  assert.match(byRow[4], /找不到商品编号/);
  assert.match(byRow[5], /不一致/);
});

test('parseVcSheet: 同一商品出现多行——值相同只留一行，值不同都不导入', () => {
  const rows = [
    ['商品链接', '京东价'],
    [link('100000000001'), '59'],
    [link('100000000001'), '59'],
    [link('100000000002'), '59'],
    [link('100000000002'), '58'],
  ];
  const res = parseVcSheet(rows);
  assert.deepEqual(res.entries.map((e) => e.row), [2]);
  assert.deepEqual(res.errors.map((e) => e.row), [4, 5]);
  assert.match(res.errors[0].message, /第 4、5 行是同一个商品/);
});

test('vc-erp: 两个相同只存 erpCode，不同分开存；发布时单独的 > 共用的 > 设置默认', () => {
  assert.deepEqual(withErp({ jdPrice: 1, erpCode: 'old' }, { buyer: 'a', saler: 'a' }), { jdPrice: 1, erpCode: 'a' });
  assert.deepEqual(withErp({ erpCode: 'old' }, { buyer: 'a', saler: 'b' }), { buyerErp: 'a', salerErp: 'b' });
  assert.deepEqual(withErp({ erpCode: 'old' }, { buyer: '', saler: '' }), {});
  assert.deepEqual(ownErp({ erpCode: 'x', salerErp: 'y' }), { buyer: 'x', saler: 'y' });
  assert.deepEqual(vcErpCodes({ buyerErp: 'a' }, 'def'), { buyer: 'a', saler: 'def' });
  assert.deepEqual(vcErpCodes(undefined, ''), { buyer: '', saler: '' });
});

test('mergeVcImport: 只覆盖表格里填了的字段，其他编辑内容保留', () => {
  const before = { marketPrice: 89.9, jdPrice: 69.9, costPrice: 50, erpCode: 'xudezhi.6', model: 'V2833-D', weightKg: 4.33 };
  assert.deepEqual(mergeVcImport(before, { jdPrice: 59.9 }), { ...before, jdPrice: 59.9 });
  assert.deepEqual(mergeVcImport(before, { saler: 'zhangsan' }), {
    marketPrice: 89.9, jdPrice: 69.9, costPrice: 50, model: 'V2833-D', weightKg: 4.33, buyerErp: 'xudezhi.6', salerErp: 'zhangsan',
  });
  assert.deepEqual(mergeVcImport(undefined, { buyer: 'a', saler: 'a' }), { erpCode: 'a' });
  const edits = { title: '自定义标题', vc: before };
  assert.deepEqual(applyVcImport(edits, { costPrice: 45 }), { title: '自定义标题', vc: { ...before, costPrice: 45 } });
  assert.deepEqual(edits.vc.costPrice, 50, '不修改原对象');
});

test('planVcImport: 可更新 / 没变化 / 不在任务列表 / 已发布 / 京东价高于市场价 / 毛利为负', () => {
  const items = [
    item('100000000001'),
    item('100000000002', { edits: { vc: { marketPrice: 89.9, jdPrice: 69.9, costPrice: 50 } } }),
    item('100000000003', { status: 'published', publishedAt: 1 }),
    item('100000000004', { edits: { vc: { marketPrice: 50 } } }),
    item('100000000005'),
  ];
  const entries = [
    { row: 2, skuId: '100000000001', values: { marketPrice: 89.9, jdPrice: 69.9, costPrice: 50, buyer: 'a', saler: 'a' } },
    { row: 3, skuId: '100000000002', values: { jdPrice: 69.9 } },
    { row: 4, skuId: '100000000003', values: { jdPrice: 1 } },
    { row: 5, skuId: '100000000004', values: { jdPrice: 60 } },
    { row: 6, skuId: '100000000005', values: { jdPrice: 50, costPrice: 55 } },
    { row: 7, skuId: '100000000099', values: { jdPrice: 1 } },
  ];
  const plan = planVcImport(entries, items);
  assert.deepEqual(plan.updates.map((u) => u.row), [2, 6]);
  assert.deepEqual(plan.updates[0].changes.map((c) => c.label), ['市场价', '京东价', '采购价', '采购员ERP', '销售员ERP']);
  assert.deepEqual(plan.updates[0].changes[1], { label: '京东价', from: '', to: '69.9' });
  assert.equal(plan.updates[0].title, '商品100000000001');
  assert.deepEqual(plan.unchanged.map((e) => e.row), [3]);
  assert.deepEqual(plan.archived.map((e) => e.row), [4]);
  assert.deepEqual(plan.missing.map((e) => e.row), [7]);
  assert.equal(plan.errors.length, 1);
  assert.match(plan.errors[0].message, /京东价 ¥60 高于市场价 ¥50/);
  assert.match(plan.warnings[0].message, /毛利为负/);
  assert.equal(plan.warnings[0].row, 6);
});

test('planVcImport: 任务 SKU 和页面 SKU 不同时按页面 SKU 也能对上；两行对上同一个商品时第二行不导入', () => {
  const items = [{ ...item('100000000001'), product: { skuId: '100000000009' } }];
  const plan = planVcImport(
    [
      { row: 2, skuId: '100000000009', values: { jdPrice: 10 } },
      { row: 3, skuId: '100000000001', values: { jdPrice: 11 } },
    ],
    items,
  );
  assert.deepEqual(plan.updates.map((u) => [u.row, u.id]), [[2, '100000000001']]);
  assert.match(plan.errors[0].message, /和第 2 行是任务列表里的同一个商品/);
});

test('vcTemplateSheets: 模板 → xlsx → 读回 → 解析，已填过的值预先填好，可以直接导回', async () => {
  const items = [
    item('100114866451', { edits: { title: '维达抽纸', vc: { marketPrice: 89.9, jdPrice: 69.9, costPrice: 50, erpCode: 'xudezhi.6' } } }),
    item('100000000002'),
  ];
  const sheets = vcTemplateSheets(items);
  assert.deepEqual(sheets[0].rows[0], TEMPLATE_HEADER);
  assert.equal(sheets[1].name, '填写说明');
  const rows = await readXlsxRows(buildXlsx(sheets));
  assert.deepEqual(rows[1], [link('100114866451'), '100114866451', '维达抽纸', '89.9', '69.9', '50', 'xudezhi.6', 'xudezhi.6']);
  const res = parseVcSheet(rows);
  assert.equal(res.blank, 1, '没填值的商品行不算错误');
  const plan = planVcImport(res.entries, items);
  assert.equal(plan.updates.length, 0, '原样导回没有变化');
  assert.deepEqual(plan.unchanged.map((e) => e.skuId), ['100114866451']);
});

test('saveEditsMany: 一次写入，按存储里的最新编辑内容合并；没变化的不动；发布过的提示尚未重新发布', async () => {
  const { createItemRepository, EDITED_NOTE } = await import('../src/shared/store.js');
  let writes = 0;
  let data = {
    items: [
      item('100000000001', { edits: { title: '保留', vc: { model: 'M1' } } }),
      item('100000000002', { status: 'need_action', message: '缺少 VC 价格', edits: { vc: { jdPrice: 59 } } }),
      item('100000000003'),
    ],
  };
  const storage = {
    get: async (k) => structuredClone(data[k]),
    set: async (k, v) => {
      writes++;
      data = { ...data, [k]: structuredClone(v) };
    },
  };
  const repo = createItemRepository(storage);
  const changed = await repo.saveEditsMany([
    { id: '100000000001', edit: (e) => applyVcImport(e, { jdPrice: 69.9, buyer: 'a', saler: 'a' }) },
    { id: '100000000002', edit: (e) => applyVcImport(e, { jdPrice: 59 }) },
    { id: '100000000003', edit: (e) => applyVcImport(e, { costPrice: 40 }) },
    { id: '100000000099', edit: (e) => applyVcImport(e, { costPrice: 40 }) },
  ]);
  assert.deepEqual(changed, ['100000000001', '100000000003']);
  assert.equal(writes, 1, '几百个商品也只写一次存储');
  const byId = Object.fromEntries(data.items.map((i) => [i.id, i]));
  assert.deepEqual(byId['100000000001'].edits, { title: '保留', vc: { model: 'M1', jdPrice: 69.9, erpCode: 'a' } });
  assert.equal(byId['100000000002'].message, '缺少 VC 价格', '没变化的条目不加“已修改”提示');
  assert.deepEqual(byId['100000000003'].edits.vc, { costPrice: 40 });

  await repo.saveEditsMany([{ id: '100000000002', edit: (e) => applyVcImport(e, { jdPrice: 49 }) }]);
  const after = data.items.find((i) => i.id === '100000000002');
  assert.ok(after.message.startsWith(EDITED_NOTE), after.message);
  assert.equal(after.status, 'need_action');
});

test('导入弹窗的摘要与问题列表：按行号排序，写明 SKU 和原因', async () => {
  const { importProblems, importSummary, importNotes } = await import('../src/dashboard/vc-import-dialog.js');
  const sheet = { errors: [{ row: 5, message: '京东价“x”不是数字' }], blank: 2, columns: [] };
  const plan = {
    updates: [{}],
    unchanged: [{}],
    archived: [],
    missing: [{ row: 3, skuId: '100000000099' }],
    errors: [],
    warnings: [{ row: 2, skuId: '100000000001', message: '毛利为负' }],
  };
  assert.deepEqual(importProblems(sheet, plan).map((p) => [p.row, p.level]), [[2, 'warn'], [3, 'error'], [5, 'error']]);
  assert.match(importProblems(sheet, plan)[1].text, /任务列表里没有这个商品（SKU 100000000099）/);
  assert.deepEqual(importNotes(sheet, plan), ['1 个和现在一样', '2 行没填值（不修改）', '2 行有问题没有导入', '1 个需要核对']);
  assert.match(importSummary(sheet, plan), /^将修改 1 个商品；/);
});

test('planVcImport: 只导入 ERP 的行不因为原来的价格冲突被拦；改价格时才检查京东价高于市场价', () => {
  const items = [item('100000000001', { edits: { vc: { marketPrice: 50, jdPrice: 60 } } })];
  const erpOnly = planVcImport([{ row: 2, skuId: '100000000001', values: { buyer: 'a', saler: 'a' } }], items);
  assert.equal(erpOnly.updates.length, 1);
  const price = planVcImport([{ row: 2, skuId: '100000000001', values: { costPrice: 40, jdPrice: 61 } }], items);
  assert.match(price.errors[0].message, /京东价 ¥61 高于市场价 ¥50/);
});

test('importEdit: 保存时按最新数据再检查——预览后已发布、合并后京东价高于市场价的不改', async () => {
  const { importEdit } = await import('../src/shared/vc-import.js');
  const edit = importEdit({ jdPrice: 69.9 });
  const edits = { vc: { marketPrice: 89.9 } };
  assert.deepEqual(edit(edits, item('1')), { vc: { marketPrice: 89.9, jdPrice: 69.9 } });
  assert.equal(edit(edits, item('1', { status: 'published', publishedAt: 1 })), edits);
  const stale = { vc: { marketPrice: 50 } };
  assert.equal(edit(stale, item('1')), stale, '预览之后市场价被改低了');
});
