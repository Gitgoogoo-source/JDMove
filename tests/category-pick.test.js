import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCategoryText, matchCategoryMap, parseCateListInput, mappingSourceFor, cateListInputError, cateChangeNote } from '../src/shared/category-pick.js';
import { readFileSync } from 'node:fs';
import { normalizeProduct } from '../src/shared/product-normalize.js';

test('parseCategoryText parses names and ids', () => {
  assert.deepEqual(parseCategoryText('（京喜通）粮油米面[51699]  >  面粉[51702]  >  中筋面粉[51722]'), [
    { name: '（京喜通）粮油米面', id: 51699 },
    { name: '面粉', id: 51702 },
    { name: '中筋面粉', id: 51722 },
  ]);
  assert.deepEqual(parseCategoryText('无效文本'), []);
  assert.deepEqual(parseCategoryText(''), []);
});

test('matchCategoryMap matches by crumb path suffix', () => {
  const map = [
    { source: '休闲食品>巧克力', cateList: [17991, 17994, 18132], name: '巧克力' },
    { source: '粮油调味>面粉', cateList: [1, 2, 3], name: '面粉' },
  ];
  assert.equal(matchCategoryMap(map, ['食品饮料', '休闲食品', '巧克力'])?.name, '巧克力');
  assert.equal(matchCategoryMap(map, ['食品饮料', '饮料']), null);
  assert.equal(matchCategoryMap(undefined, ['a']), null);
});

test('parseCateListInput accepts ids or result text', () => {
  assert.deepEqual(parseCateListInput('17991, 17994,18132'), [17991, 17994, 18132]);
  assert.deepEqual(parseCateListInput('（京喜通）休闲零食[17991] > 糖巧布丁[17994] > 巧克力[18132]'), [17991, 17994, 18132]);
  assert.deepEqual(parseCateListInput('abc'), []);
});

const doveRaw = JSON.parse(readFileSync(new URL('./fixtures/item-100035179134.raw.json', import.meta.url), 'utf8'));
const dove = normalizeProduct(doveRaw);

test('matchCategoryMap: 规则写上级类目也能命中更细的源类目', () => {
  const map = [{ source: '休闲食品>巧克力', cateList: [17991, 17994, 18132], name: '巧克力' }];
  assert.equal(matchCategoryMap(map, dove.crumbs)?.name, '巧克力');
  assert.equal(matchCategoryMap([{ source: '巧克力', cateList: [1], name: 'x' }], dove.crumbs)?.name, 'x');
});

test('matchCategoryMap: 多条命中时用最具体（级数最多、最靠近叶子）的规则', () => {
  const map = [
    { source: '休闲食品', cateList: [1], name: '上级' },
    { source: '巧克力', cateList: [2], name: '巧克力' },
    { source: '巧克力>牛奶巧克力', cateList: [3], name: '牛奶巧克力' },
  ];
  assert.equal(matchCategoryMap(map, dove.crumbs)?.name, '牛奶巧克力');
  assert.equal(matchCategoryMap(map.slice(0, 2), dove.crumbs)?.name, '巧克力');
  assert.equal(matchCategoryMap(map.slice(0, 1), dove.crumbs)?.name, '上级');
});

test('matchCategoryMap: 各级必须连续且完整相等，不做模糊匹配', () => {
  assert.equal(matchCategoryMap([{ source: '休闲食品>牛奶巧克力', cateList: [1] }], dove.crumbs), null);
  assert.equal(matchCategoryMap([{ source: '巧克', cateList: [1] }], dove.crumbs), null);
});

test('mappingSourceFor: 取到叶子类目为止的末两级，去掉品牌（全半角括号不同也能识别）', () => {
  assert.equal(mappingSourceFor(dove), '巧克力>牛奶巧克力');
  assert.equal(mappingSourceFor({ leafCategory: '牛奶巧克力', crumbs: ['巧克力', '牛奶巧克力', '德芙(Dove)'] }), '巧克力>牛奶巧克力');
  assert.equal(mappingSourceFor({ leafCategory: '饼干', crumbs: ['食品', '饼干'] }), '食品>饼干');
  assert.equal(mappingSourceFor({ leafCategory: '', crumbs: [] }), '');
});

test('cateListInputError: 留空或能解析出类目ID时通过；填了内容却解析不出ID时说明要填什么', () => {
  assert.equal(cateListInputError(''), '');
  assert.equal(cateListInputError('   '), '');
  assert.equal(cateListInputError('15901,15902,15908'), '');
  assert.equal(cateListInputError('家庭清洁/纸品[15901] > 清洁纸品[15902] > 抽纸[15908]'), '');
  for (const bad of ['常规抽纸', '家庭清洁/纸品 > 清洁纸品 > 抽纸', '0,0']) {
    assert.match(cateListInputError(bad), /类目ID/, bad);
    assert.match(cateListInputError(bad), /15901,15902,15908/, bad);
  }
});

test('parseCateListInput: 0 不是类目ID', () => {
  assert.deepEqual(parseCateListInput('0,15901'), [15901]);
});

test('cateChangeNote: 说明保存后发布用哪个类目', () => {
  assert.equal(cateChangeNote({}, {}), '');
  assert.equal(cateChangeNote({ cateList: [1, 2] }, { cateList: [1, 2], cateName: 'A' }), '');
  assert.equal(cateChangeNote({}, { cateList: [15901, 15902, 15908], cateName: '家庭清洁/纸品 > 清洁纸品 > 抽纸' }), '目标类目已设为：家庭清洁/纸品 > 清洁纸品 > 抽纸 [15901,15902,15908]');
  assert.equal(cateChangeNote({}, { cateList: [15901, 15902, 15908] }), '目标类目已设为：[15901,15902,15908]');
  assert.equal(cateChangeNote({ cateList: [1] }, {}), '已清空指定类目，发布时自动匹配');
});
