// 发布前检查表：按上架模板分附表、格子里是发布时会用的值并标颜色、汇总按上架表列出；
// 上传后认出表格种类、读回所有附表、没改的不算修改、齐全的才发布
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildReview, reviewTemplate } from '../src/shared/vc-review.js';
import { planReviewImport } from '../src/shared/vc-review-sheet.js';
import { reviewFileName, reviewWorkbook } from '../src/shared/review-workbook.js';
import { parseReviewBook, publishPlan, readBookMeta, TEMPLATE_CHANGED, templateChangedIds, UNKNOWN_TABLE, workbookKind } from '../src/shared/review-workbook-import.js';
import { newBatch } from '../src/shared/batch.js';
import { buildXlsx } from '../src/shared/xlsx-write.js';
import { readXlsxSheets } from '../src/shared/xlsx-read.js';
import { TEMPLATE_HEADER } from '../src/shared/vc-import.js';
import { mergeSettings } from '../src/shared/settings.js';

const read = (f) => JSON.parse(fs.readFileSync(new URL(`../templates/vc/${f}`, import.meta.url), 'utf8'));
const index = read('index.json');
const catalog = { entries: index.templates, byId: new Map(index.templates.map((e) => [e.categoryId, read(e.file)])) };
const settings = mergeSettings({});
const IMG = 'https://img14.360buyimg.com/a.jpg';
const link = (id) => `https://item.jd.com/${id}.html`;
const DIMS = { lengthMm: 300, widthMm: 200, heightMm: 100, weightKg: 1 };

const item = (id, cateIds, edits = {}, vc = DIMS) => ({
  id,
  skuId: id,
  url: link(id),
  status: 'collected',
  message: '',
  edits,
  product: { skuId: id, title: `商品${id}`, brand: { id: 1, name: '品牌' }, params: [], mainImages: [IMG], detailImages: [IMG], vc: { cateIds, brandId: 1, model: 'M', ...vc } },
});
const READY_ATTRS = { 是否消字号商品: '非消字号', 香型: '无香型', 功能: '日常清洁', 纸张尺寸: '200*150', '克重g/㎡': '50', 单包片数: '80', 包装形式: '袋装' };
const TISSUE = item('100000000001', ['15901', '15902', '15908', '31403'], { vc: { marketPrice: 99 }, attrOverrides: { 层数: '3层' } });
const BARE = item('100000000002', []);
const WIPES = item('100000000003', ['15901', '15902', '15911'], { vc: { marketPrice: 39, jdPrice: 29, costPrice: 20 }, attrOverrides: READY_ATTRS });
const HANGING = item('100000000004', ['15901', '15902', '15908', '44478'], {}, { weightKg: 1 });
const ITEMS = [TISSUE, BARE, WIPES, HANGING];

const rowsOf = (items) =>
  items.map((it) => {
    const match = reviewTemplate({ product: it.product, edits: it.edits, settings, catalog });
    return { item: it, edits: it.edits, match, review: buildReview({ product: it.product, edits: it.edits, settings, template: match.template }) };
  });
const sheetNamed = (sheets, name) => sheets.find((s) => s.name === name);
const cellOf = (sheet, r, header) => sheet.rows[r][sheet.rows[0].indexOf(header)];
const fillOf = (sheet, r, header) => sheet.cellStyles[r][sheet.rows[0].indexOf(header)];

test('reviewWorkbook：按模板分附表（同一三级类目下发布页不同的四级类目各一张），每张只有自己模板的属性列', () => {
  const sheets = reviewWorkbook({ rows: rowsOf(ITEMS), catalog });
  assert.deepEqual(
    sheets.map((s) => s.name),
    ['汇总', '附表1-抽纸-常规抽纸', '附表2-湿巾', '附表3-抽纸-悬挂式抽纸', '未匹配模板', '可选值', '填写说明', '_meta', '_base'],
  );
  const tissue = sheets[1].rows[0];
  const wipes = sheets[2].rows[0];
  assert.deepEqual(tissue.slice(0, 5), ['商品链接', 'SKU', '源商品标题（核对用，不导入）', '还缺（核对用，不导入）', '上架模板']);
  assert.ok(tissue.includes('*SKU属性:层数') && tissue.includes('*SKU属性:纸张尺寸') && tissue.includes('商品属性:是否压花'), tissue.join('|'));
  assert.ok(!tissue.some((h) => /消字号|克重/.test(h)), '抽纸表里没有湿巾的属性');
  assert.ok(wipes.includes('*商品属性:是否消字号商品') && !wipes.some((h) => /层数/.test(h)));
  assert.equal(tissue.filter((h) => /单包抽数/.test(h)).length, 1, '同名属性只列一列');
  assert.ok(tissue.includes('*市场价(元)') && tissue.includes('商品条形码'), '必填的表头带 *');
  assert.equal(sheets.at(-2).hidden, true);
  assert.equal(sheets.at(-1).hidden, true);
  assert.deepEqual(sheets.at(-2).rows.filter((r) => r[0] === 'editable').map((r) => r[1]), ['附表1-抽纸-常规抽纸', '附表2-湿巾', '附表3-抽纸-悬挂式抽纸', '未匹配模板']);
  assert.equal(sheets.at(-1).rows.length, ITEMS.length + 1, '_base：每个商品一行');
});

test('reviewWorkbook：格子里是发布时会用的值（自己填的 > 采集到的 > 默认值），缺的标红、默认值标橙', () => {
  const sheets = reviewWorkbook({ rows: rowsOf(ITEMS), catalog });
  const tissue = sheets[1];
  assert.equal(cellOf(tissue, 1, '*市场价(元)'), 99, '数字写成数字');
  assert.equal(cellOf(tissue, 1, '*京东价(元)'), '');
  assert.equal(fillOf(tissue, 1, '*京东价(元)'), 'error');
  assert.equal(cellOf(tissue, 1, '*包装长(mm)'), 300, '采集到的值也写进去');
  assert.equal(fillOf(tissue, 1, '*包装长(mm)'), null);
  assert.equal(cellOf(tissue, 1, '*型号'), 'M');
  assert.equal(cellOf(tissue, 1, '*SKU属性:层数'), '3层');
  assert.equal(fillOf(tissue, 1, '*SKU属性:纸张尺寸'), 'error');
  assert.match(cellOf(tissue, 1, '*发布标题（留空=按源标题生成）'), /商品100000000001/);
  const hanging = sheets[3];
  assert.equal(cellOf(hanging, 1, '*包装长(mm)'), 100, '没采集到长宽高：默认值');
  assert.equal(fillOf(hanging, 1, '*包装长(mm)'), 'warn');
  const none = sheets[4];
  assert.equal(cellOf(none, 1, '*上架模板'), '');
  assert.equal(fillOf(none, 1, '*上架模板'), 'error');
  assert.ok(!none.rows[0].some((h) => /属性:/.test(h)), '没有模板时没有属性列');
});

test('reviewWorkbook：汇总按上架表的链接列出：上架表行号、说明、采集结果、所在附表、检查结果', () => {
  const failed = { id: '100000000009', skuId: '100000000009', url: link('100000000009'), status: 'failed', product: null, message: '页面打不开' };
  const links = [
    { skuId: TISSUE.id, url: TISSUE.url, label: '抽纸 3 层', refs: [{ sheet: '上架', row: 4 }, { sheet: '上架', row: 6 }] },
    { skuId: failed.id, url: failed.url, label: '', refs: [{ sheet: '上架', row: 5 }] },
    { skuId: '100000000008', url: link('100000000008'), label: '', refs: [{ sheet: '上架', row: 7 }] },
  ];
  const batch = newBatch({ fileName: '乐事上架表.xlsx', links, skuIds: [TISSUE.id, failed.id], now: 1 });
  const [summary] = reviewWorkbook({ rows: rowsOf([TISSUE]), catalog, items: [TISSUE, failed], batch });
  const [, tissue, fail, skipped] = summary.rows;
  assert.deepEqual(tissue.slice(0, 4), ['第 4、6 行', '抽纸 3 层', TISSUE.url, TISSUE.id]);
  assert.equal(tissue[6], '抽纸 > 常规抽纸');
  assert.equal(tissue[7], '附表1-抽纸-常规抽纸');
  assert.match(tissue[8], /^缺 \d+ 项$/);
  assert.equal(summary.cellStyles[1][8], 'error');
  assert.equal(fail[5], '采集失败：页面打不开');
  assert.equal(fail[8], '没有检查');
  assert.equal(skipped[5], '没有加入任务列表');
  assert.equal(reviewFileName(batch, new Date(2026, 10, 19, 9, 5)), '发布前检查-乐事上架表-20261119-0905.xlsx');
});

test('导出 → Excel → 上传：认出是发布前检查表；没改的格子不算修改；改了的写进编辑内容；齐全的发布，缺的不发布', async () => {
  const bytes = buildXlsx(reviewWorkbook({ rows: rowsOf([TISSUE, WIPES, BARE]), catalog, items: ITEMS, batch: newBatch({ fileName: 'a.xlsx', links: [], skuIds: [], now: 7 }) }));
  const sheets = await readXlsxSheets(bytes);
  assert.equal(workbookKind(sheets).kind, 'review');
  assert.equal(readBookMeta(sheets).batchId, 'b7');
  const ctx = { items: ITEMS, drafts: new Map(), catalog, settings };
  const untouched = parseReviewBook(sheets);
  assert.deepEqual(untouched.sheets, ['附表1-抽纸-常规抽纸', '附表2-湿巾', '未匹配模板']);
  const same = planReviewImport(untouched.entries, ctx);
  assert.deepEqual(same.problems, []);
  assert.deepEqual(same.updates, [], '原样上传：采集到的值、自动标题、默认值都不算修改');
  assert.deepEqual(same.matched, [TISSUE.id, WIPES.id, BARE.id]);

  const set = (name, header, value) => {
    const s = sheetNamed(sheets, name);
    s.rows[1][s.rows[0].indexOf(header)] = value;
  };
  set('附表1-抽纸-常规抽纸', '*京东价(元)', '59');
  set('附表1-抽纸-常规抽纸', '*SKU属性:纸张尺寸', '195*133');
  set('未匹配模板', '*上架模板', '湿巾');
  const plan = planReviewImport(parseReviewBook(sheets).entries, ctx);
  assert.deepEqual(plan.problems, []);
  assert.deepEqual(
    plan.updates.map((u) => [u.sheet, u.id, u.changes]),
    [
      ['附表1-抽纸-常规抽纸', TISSUE.id, ['京东价(元)', '纸张尺寸']],
      ['未匹配模板', BARE.id, ['上架模板']],
    ],
  );
  const drafts = new Map(plan.updates.map((u) => [u.id, u.edits]));
  const pub = publishPlan({ ids: plan.matched, items: ITEMS, drafts, catalog, settings });
  assert.deepEqual(pub.ready, [WIPES.id]);
  assert.deepEqual(pub.incomplete.map((x) => x.id), [TISSUE.id, BARE.id]);
  assert.ok(pub.incomplete[1].problems.includes('香型'), '换成湿巾模板后按湿巾检查');
});

test('上传：不合规的值写明哪张表第几行；导出时就填不上的值原样上传不报错', async () => {
  const sheets = await readXlsxSheets(buildXlsx(reviewWorkbook({ rows: rowsOf([TISSUE, HANGING]), catalog })));
  const tissue = sheetNamed(sheets, '附表1-抽纸-常规抽纸');
  tissue.rows[1][tissue.rows[0].indexOf('*包装长(mm)')] = '99999';
  const plan = planReviewImport(parseReviewBook(sheets).entries, { items: ITEMS, drafts: new Map(), catalog, settings, missingText: '不在任务列表里' });
  assert.equal(plan.problems.length, 1);
  assert.equal(plan.problems[0].sheet, '附表1-抽纸-常规抽纸');
  assert.equal(plan.problems[0].row, 2);
  assert.match(plan.problems[0].text, /超出本类目允许的范围/);
  assert.deepEqual(plan.matched, [HANGING.id]);
});

test('publishPlan：不在任务列表（已发布移出或删掉）、没采集、正在发布的商品不发布', () => {
  const items = [
    { ...WIPES, id: 'b', product: null, status: 'failed' },
    { ...WIPES, id: 'c', status: 'publishing' },
  ];
  const res = publishPlan({ ids: ['b', 'c', 'x'], items, drafts: new Map(), catalog, settings });
  assert.deepEqual(res.skipped.map((s) => `${s.id}:${s.reason}`), ['b:还没采集', 'c:正在发布', 'x:已发布或已从任务列表删除']);
  const pending = publishPlan({ ids: ['d'], items: [{ ...WIPES, id: 'd', status: 'pending' }], drafts: new Map(), catalog, settings });
  assert.equal(pending.skipped[0].reason, '还没采集', '有旧数据、重新采集还没跑的不发布');
});

test('workbookKind：上架表（参考链接列）、旧的单表格式和价格/ERP 表算发布前检查表、认不出的报错', () => {
  assert.equal(workbookKind([{ name: 'S', rows: [['参考链接'], [link('100000000001')]] }]).kind, 'listing');
  assert.deepEqual(workbookKind([{ name: 'S', rows: [TEMPLATE_HEADER, [link('1000001'), '', '', '9']] }]), { kind: 'review', meta: null });
  assert.deepEqual(workbookKind([{ name: 'S', rows: [['a', 'b']] }]), { kind: null, error: UNKNOWN_TABLE });
});

test('上传没改过的旧表：导出之后在插件里改的、重新采集到的值不会被表里的旧值冲掉（和导出时的值比）', async () => {
  const sheets = await readXlsxSheets(buildXlsx(reviewWorkbook({ rows: rowsOf([WIPES]), catalog })));
  assert.ok(sheets.some((s) => s.name === '_base' && s.hidden));
  const edited = { ...WIPES, edits: { ...WIPES.edits, vc: { ...WIPES.edits.vc, model: 'X-1', marketPrice: 45 } } };
  const recollected = { ...edited, product: { ...edited.product, vc: { ...edited.product.vc, lengthMm: 310, weightKg: 1.2 } } };
  const book = parseReviewBook(sheets);
  const plan = planReviewImport(book.entries, { items: [recollected], drafts: new Map(), catalog, settings, base: book.base });
  assert.deepEqual(plan.problems, []);
  assert.deepEqual(plan.updates, [], '表里没改的格子不动');
  assert.deepEqual(plan.matched, [WIPES.id]);

  const tab = sheets.find((s) => s.name === '附表1-湿巾');
  tab.rows[1][tab.rows[0].indexOf('*市场价(元)')] = '59';
  const changed = planReviewImport(parseReviewBook(sheets).entries, { items: [recollected], drafts: new Map(), catalog, settings, base: book.base });
  assert.deepEqual(changed.updates[0].changes, ['市场价(元)']);
  assert.equal(changed.updates[0].edits.vc.model, 'X-1', '插件里改的型号保留');
  assert.equal(changed.updates[0].edits.vc.lengthMm, undefined, '重新采集的长度不会被钉成手动值');

  const legacy = sheets.filter((s) => s.name !== '_base');
  const old = planReviewImport(parseReviewBook(legacy).entries, { items: [recollected], drafts: new Map(), catalog, settings, base: parseReviewBook(legacy).base });
  assert.ok(old.updates[0].changes.includes('型号'), '没有 _base 的旧表只能和现在的值比');
});

test('表格里换了上架模板的商品这一轮不发布（即使按新模板已经齐全）', async () => {
  const bare = { ...BARE, edits: { vc: { marketPrice: 39, jdPrice: 29, costPrice: 20 }, attrOverrides: READY_ATTRS } };
  const sheets = await readXlsxSheets(buildXlsx(reviewWorkbook({ rows: rowsOf([bare]), catalog })));
  const tab = sheets.find((s) => s.name === '未匹配模板');
  tab.rows[1][tab.rows[0].indexOf('*上架模板')] = '湿巾';
  const book = parseReviewBook(sheets);
  const ctx = { items: [bare], drafts: new Map(), catalog, settings, base: book.base };
  const plan = planReviewImport(book.entries, ctx);
  assert.deepEqual(plan.updates[0].changes, ['上架模板']);
  const drafts = new Map(plan.updates.map((u) => [u.id, u.edits]));
  const ready = publishPlan({ ids: plan.matched, items: [bare], drafts, catalog, settings });
  assert.deepEqual(ready.ready, [bare.id], '不拦的话按新模板是齐全的');
  const held = publishPlan({ ids: plan.matched, items: [bare], drafts, catalog, settings, held: templateChangedIds(plan.updates) });
  assert.deepEqual(held.ready, []);
  assert.equal(held.incomplete[0].reason, TEMPLATE_CHANGED);
});
