// 发布前检查的表格批量填写：导出（属性列是各模板属性的并集）、读回、按商品的模板校验、整行不导入的规则
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildReview, reviewTemplate } from '../src/shared/vc-review.js';
import { NOT_APPLICABLE, parseReviewSheet, planReviewImport, resolveTemplateCell, reviewSheets, REVIEW_HEADER_MISSING } from '../src/shared/vc-review-sheet.js';
import { TEMPLATE_HEADER } from '../src/shared/vc-import.js';
import { buildXlsx } from '../src/shared/xlsx-write.js';
import { readXlsxRows } from '../src/shared/xlsx-read.js';
import { mergeSettings } from '../src/shared/settings.js';

const read = (f) => JSON.parse(fs.readFileSync(new URL(`../templates/vc/${f}`, import.meta.url), 'utf8'));
const index = read('index.json');
const catalog = { entries: index.templates, byId: new Map(index.templates.map((e) => [e.categoryId, read(e.file)])) };
const settings = mergeSettings({});
const IMG = 'https://img14.360buyimg.com/a.jpg';
const link = (id) => `https://item.jd.com/${id}.html`;

const item = (id, cateIds, edits = {}) => ({
  id,
  skuId: id,
  url: link(id),
  edits,
  product: {
    skuId: id,
    title: `商品${id}`,
    brand: { id: 1, name: '品牌' },
    params: [],
    mainImages: [IMG],
    detailImages: [IMG],
    vc: { cateIds, brandId: 1, model: 'M', lengthMm: 300, widthMm: 200, heightMm: 100, weightKg: 1 },
  },
});
const TISSUE = item('100000000001', ['15901', '15902', '15908', '31403'], { vc: { marketPrice: 99 }, attrOverrides: { 层数: '3层' } });
const BARE = item('100000000002', []);
const WIPES = item('100000000003', ['15901', '15902', '15911']);
const ITEMS = [TISSUE, BARE, WIPES];

const rowsOf = (items) =>
  items.map((it) => {
    const match = reviewTemplate({ product: it.product, edits: it.edits, settings, catalog });
    return { item: it, edits: it.edits, match, review: buildReview({ product: it.product, edits: it.edits, settings, template: match.template }) };
  });
const ctx = (drafts = new Map()) => ({ items: ITEMS, drafts, catalog, settings });

test('reviewSheets：同一个三级类目下不同的四级类目，可选值表各列一份', () => {
  const hanging = item('100000000004', ['15901', '15902', '15908', '44478']);
  const [, options] = reviewSheets({ rows: rowsOf([TISSUE, hanging]), catalog });
  const names = new Set(options.rows.slice(1).map((r) => r[0]));
  assert.deepEqual([...names].sort(), ['抽纸 > 常规抽纸', '抽纸 > 悬挂式抽纸'].sort());
});

test('reviewSheets：每个商品一行，属性列是各模板属性的并集，模板里没有的属性写“—”；已填的值预先填好', () => {
  const [sheet, options, notes] = reviewSheets({ rows: rowsOf(ITEMS), catalog });
  const [header, tissue, bare, wipes] = sheet.rows;
  const col = (name) => header.indexOf(name);
  assert.deepEqual(header.slice(0, 5), ['商品链接', 'SKU', '源商品标题（核对用，不导入）', '还缺（核对用，不导入）', '上架模板']);
  assert.ok(header.includes('属性:层数') && header.includes('属性:是否消字号商品'));
  assert.equal(tissue[col('上架模板')], '抽纸');
  assert.equal(tissue[col('市场价(元)')], 99, '数字字段写成数字');
  assert.equal(tissue[col('属性:层数')], '3层');
  assert.equal(tissue[col('属性:是否消字号商品')], NOT_APPLICABLE);
  assert.equal(wipes[col('属性:层数')], NOT_APPLICABLE);
  assert.equal(bare[col('上架模板')], '');
  assert.match(bare[col('还缺（核对用，不导入）')], /上架模板（类目）/);
  assert.ok(sheet.textColumns.includes(1) && sheet.textColumns.includes(col('属性:层数')));
  assert.ok(options.rows.some((r) => r[0] === '湿巾' && r[1] === '香型' && r[3] === '必填' && r[4].includes('无香型')));
  assert.ok(options.rows.some((r) => r[0] === '抽纸 > 常规抽纸' && r[1] === '纸张尺寸' && r[4].includes('2 个数字')));
  assert.match(notes.rows[2][0], /抽纸 > 常规抽纸/);
});

test('导出 → Excel → 读回 → 导入：没改的不算修改，填了的按商品的模板写进编辑内容', async () => {
  const rows = await readXlsxRows(buildXlsx(reviewSheets({ rows: rowsOf(ITEMS), catalog })));
  const header = rows[0];
  const set = (r, name, v) => {
    rows[r][header.indexOf(name)] = v;
  };
  set(1, '采购价(元)', '50.5');
  set(1, '属性:纸张尺寸', '195*133');
  set(2, '上架模板', '湿巾');
  set(2, '京东价(元)', '¥1,299');
  set(2, '属性:香型', '无香');
  const sheet = parseReviewSheet(rows);
  assert.equal(sheet.error, undefined);
  const plan = planReviewImport(sheet.entries, ctx());
  assert.deepEqual(plan.problems, []);
  assert.equal(plan.unchanged, 1, '第三个商品没填（只有导出时的模板名和“—”），不修改');
  const [tissue, bare] = plan.updates;
  assert.deepEqual(tissue.changes, ['采购价(元)', '纸张尺寸']);
  assert.equal(tissue.edits.cateList, undefined, '导出时写的模板名原样导回，不变成手动指定类目');
  assert.deepEqual(tissue.edits.attrOverrides, { 层数: '3层', 纸张尺寸: '195*133' });
  assert.deepEqual(bare.changes, ['上架模板', '京东价(元)', '香型']);
  assert.deepEqual(bare.edits.cateList, ['15901', '15902', '15911']);
  assert.equal(bare.edits.vc.jdPrice, 1299);
  assert.equal(bare.edits.attrOverrides.香型, '无香型', '存成选项原文');
});

test('planReviewImport：一行里有一个值不对整行不导入；模板里没有的属性忽略并提醒；不在弹窗里的商品、重复行报错', () => {
  const rows = [
    ['商品链接', '上架模板', '京东价', '包装长(mm)', '属性:是否消字号商品', '属性:层数'],
    [link('100000000003'), '', '19.9', '3000', '', ''],
    [link('100000000003'), '', '', '', '是', ''],
    [link('100000000002'), '湿巾', '', '', '非消字号', '3层'],
    [link('100000000002'), '', '9', '', '', ''],
    [link('999999999999'), '', '9', '', '', ''],
    [link('100000000001'), '不存在的模板', '9', '', '', ''],
  ];
  const plan = planReviewImport(parseReviewSheet(rows).entries, ctx());
  const texts = plan.problems.map((p) => `${p.row}:${p.level}:${p.text}`);
  assert.match(texts[0], /^2:error:包装长\(mm\)“3000”超出本类目允许的范围（1~2900 mm），这一行没有导入/);
  assert.match(texts[1], /^3:error:和第 2 行是同一个商品/);
  assert.match(texts[2], /^4:warn:模板「湿巾」没有这些属性，已忽略：层数/);
  assert.match(texts[3], /^5:error:和第 4 行是同一个商品/);
  assert.match(texts[4], /^6:error:这个商品不在这次发布的商品里/);
  assert.match(texts[5], /^7:error:上架模板“不存在的模板”找不到/);
  assert.deepEqual(plan.updates.map((u) => u.id), ['100000000002']);
  assert.deepEqual(plan.updates[0].edits.attrOverrides, { 是否消字号商品: '非消字号' });
});

test('planReviewImport：以弹窗里正在改的内容为准；“自动”改回自动匹配；下拉值对不上整行不导入', () => {
  const drafts = new Map([[TISSUE.id, { ...TISSUE.edits, cateList: ['15901', '15902', '15908', '44478'] }]]);
  const rows = [
    ['商品链接', '上架模板', '属性:是否消字号商品'],
    [link('100000000001'), '自动', ''],
    [link('100000000003'), '', '是'],
  ];
  const plan = planReviewImport(parseReviewSheet(rows).entries, ctx(drafts));
  assert.deepEqual(plan.updates[0].changes, ['上架模板']);
  assert.equal(plan.updates[0].edits.cateList, undefined);
  assert.match(plan.problems[0].text, /是否消字号商品“是”不是可选值/);
});

test('parseReviewSheet：没有表头时报错；「表格导入价格/ERP」的表也能导入，但“商品标题”（源标题）不当发布标题', () => {
  assert.equal(parseReviewSheet([['京东价'], ['9']]).error, REVIEW_HEADER_MISSING);
  const rows = [TEMPLATE_HEADER, [link('100000000003'), '100000000003', '源标题', '29.9', '19.9', '12', 'a.b', 'a.b']];
  const sheet = parseReviewSheet(rows);
  assert.deepEqual(sheet.entries[0].values, { marketPrice: '29.9', jdPrice: '19.9', costPrice: '12', buyer: 'a.b', saler: 'a.b' });
  const plan = planReviewImport(sheet.entries, ctx());
  assert.deepEqual(plan.updates[0].edits.vc, { marketPrice: 29.9, jdPrice: 19.9, costPrice: 12, erpCode: 'a.b' });
  const mismatch = parseReviewSheet([['商品链接', 'SKU', '京东价'], [link('100000000003'), '100000000001', '9']]);
  assert.match(mismatch.errors[0].message, /不一致/);
});

test('resolveTemplateCell：模板名、四级类目名、“三级 > 四级”、类目ID都认；乳霜纸优先是独立的三级类目', () => {
  assert.equal(resolveTemplateCell(catalog, '抽纸'), '15908:31403', '不是末级的三级类目用录制模板的四级类目');
  assert.equal(resolveTemplateCell(catalog, '常规抽纸'), '15908:31403');
  assert.equal(resolveTemplateCell(catalog, '抽纸 > 悬挂式抽纸'), '15908:44478');
  assert.equal(resolveTemplateCell(catalog, '44477'), '15909:44477');
  assert.equal(resolveTemplateCell(catalog, '乳霜纸'), '52259:52259');
  assert.equal(resolveTemplateCell(catalog, '抽纸>乳霜纸'), '15908:31404');
  assert.equal(resolveTemplateCell(catalog, '家庭清洁/纸品 > 清洁纸品 > 湿巾'), '15911:15911');
  assert.equal(resolveTemplateCell(catalog, '自动'), '');
  assert.equal(resolveTemplateCell(catalog, '面巾纸'), null);
});

test('resolveTemplateCell：和模板目录的顺序无关；只写四级类目名时重名不猜', () => {
  const reversed = { entries: [...index.templates].reverse(), byId: catalog.byId };
  assert.equal(resolveTemplateCell(reversed, '乳霜纸'), '52259:52259');
  assert.equal(resolveTemplateCell(reversed, '常规抽纸'), '15908:31403');
  const twin = read('15908.json');
  const clash = { ...twin, categoryId: '90000', path: [{ id: '1', name: 'A' }, { id: '90000', name: '别的抽纸' }], categoryName: '别的抽纸' };
  const withClash = { entries: [...index.templates, { categoryId: '90000', leafIds: [] }], byId: new Map([...catalog.byId, ['90000', clash]]) };
  assert.equal(resolveTemplateCell(withClash, '悬挂式抽纸'), null, '两个模板都有这个四级类目');
  assert.equal(resolveTemplateCell(withClash, '抽纸 > 悬挂式抽纸'), '15908:44478');
});
