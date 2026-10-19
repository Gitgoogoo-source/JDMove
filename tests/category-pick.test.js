import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCategoryText,
  pickCategory,
  matchCategoryMap,
  parseCateListInput,
} from '../src/shared/category-pick.js';

test('parseCategoryText parses names and ids', () => {
  assert.deepEqual(parseCategoryText('（京喜通）粮油米面[51699]  >  面粉[51702]  >  中筋面粉[51722]'), [
    { name: '（京喜通）粮油米面', id: 51699 },
    { name: '面粉', id: 51702 },
    { name: '中筋面粉', id: 51722 },
  ]);
  assert.deepEqual(parseCategoryText('无效文本'), []);
  assert.deepEqual(parseCategoryText(''), []);
});

const results = [
  '（京喜通）休闲零食[17991]  >  糖巧布丁[17994]',
  '（京喜通）休闲零食[17991]  >  糖巧布丁[17994]  >  巧克力[18132]',
  '（京喜通）冲调保健[20000]  >  可可粉[20001]  >  巧克力粉[20002]',
].map(parseCategoryText);

test('pickCategory prefers exact leaf name and deeper paths', () => {
  const { best, ranked } = pickCategory(results, { leafName: '巧克力', crumbs: ['食品饮料', '休闲食品', '巧克力'] });
  assert.deepEqual(best.map((n) => n.id), [17991, 17994, 18132]);
  assert.equal(ranked.length, 3);
});

test('pickCategory uses upper crumbs as tie-breaker', () => {
  const { best } = pickCategory(
    [
      [{ name: 'A', id: 1 }, { name: '饼干', id: 2 }],
      [{ name: '休闲零食', id: 3 }, { name: '饼干', id: 4 }],
    ],
    { leafName: '饼干', crumbs: ['食品', '休闲零食', '饼干'] },
  );
  assert.deepEqual(best.map((n) => n.id), [3, 4]);
});

test('pickCategory returns null when nothing is similar', () => {
  const { best } = pickCategory(results, { leafName: '轮胎', crumbs: ['汽车用品'] });
  assert.equal(best, null);
  assert.equal(pickCategory([], { leafName: 'x' }).best, null);
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

// ---------- 自营前台类目 -> 店铺类目（德芙牛奶巧克力，京喜通店铺） ----------
import { readFileSync } from 'node:fs';
import { normalizeProduct } from '../src/shared/product-normalize.js';
import { categoryKeywords, mergeSearchResults, searchBestCategory, mappingSourceFor } from '../src/shared/category-pick.js';

const doveRaw = JSON.parse(readFileSync(new URL('./fixtures/item-100035179134.raw.json', import.meta.url), 'utf8'));
const dove = normalizeProduct(doveRaw);

// 京喜通店铺的类目树（搜索按名称包含匹配）
const SHOP_TREE = [
  '（京喜通）休闲零食[17991]  >  糖巧布丁[17994]',
  '（京喜通）休闲零食[17991]  >  糖巧布丁[17994]  >  巧克力[18132]',
  '（京喜通）休闲零食[17991]  >  糖巧布丁[17994]  >  软糖[18133]',
  '（京喜通）冲调保健[20000]  >  可可粉[20001]  >  巧克力粉[20002]',
  '（京喜通）休闲零食[17991]  >  饼干糕点[18000]  >  曲奇饼干[18001]',
];
const shopSearch = (kw) => {
  const results = SHOP_TREE.filter((t) => parseCategoryText(t).some((n) => n.name.includes(kw)));
  return Promise.resolve({ ok: true, results });
};

test('categoryKeywords: 叶子名 -> 最近上级 -> 叶子名缩短 -> 更上级，不含品牌，有上限', () => {
  const kws = categoryKeywords(dove);
  assert.equal(dove.leafCategory, '牛奶巧克力');
  assert.deepEqual(kws.slice(0, 2), ['牛奶巧克力', '巧克力']);
  assert.ok(kws.includes('奶巧克力'));
  assert.ok(!kws.some((k) => k.includes('德芙')));
  assert.equal(new Set(kws).size, kws.length);
  assert.ok(kws.length <= 8);
  assert.ok(kws.every((k) => k.length >= 2));
});

test('categoryKeywords: 叶子名缩短同时考虑去掉后缀修饰（如“饼干礼盒”->“饼干”）', () => {
  const kws = categoryKeywords({ leafCategory: '饼干礼盒', crumbs: ['休闲食品', '饼干礼盒'] });
  assert.ok(kws.includes('饼干'));
});

test('categoryKeywords: 没有类目信息时返回空列表', () => {
  assert.deepEqual(categoryKeywords({ leafCategory: '', crumbs: [] }), []);
  assert.deepEqual(categoryKeywords(undefined), []);
});

test('mergeSearchResults: 多次搜索结果去重，并去掉作为其他结果前缀的非末级类目', () => {
  const merged = mergeSearchResults([SHOP_TREE.slice(0, 2).map(parseCategoryText), SHOP_TREE.slice(1, 3).map(parseCategoryText)]);
  const keys = merged.map((p) => p.map((n) => n.id).join(','));
  assert.deepEqual(keys.sort(), ['17991,17994,18132', '17991,17994,18133']);
});

test('pickCategory: 源叶子名找不到时，和源面包屑上一级同名的店铺类目优先', () => {
  const paths = mergeSearchResults([SHOP_TREE.map(parseCategoryText)]);
  const { best } = pickCategory(paths, { leafName: '牛奶巧克力', crumbs: dove.crumbs });
  assert.deepEqual(best.map((n) => n.id), [17991, 17994, 18132]);
});

test('searchBestCategory: 德芙牛奶巧克力自动匹配到京喜通“巧克力[18132]”', async () => {
  const logs = [];
  const target = await searchBestCategory(shopSearch, dove, (m) => logs.push(m));
  assert.deepEqual(target.cateList, [17991, 17994, 18132]);
  assert.equal(target.from, 'auto');
  assert.ok(logs.some((l) => l.includes('牛奶巧克力') && l.includes('0 个结果')));
});

test('searchBestCategory: 找到与源类目或其上一级同名的店铺类目后不再继续搜索', async () => {
  const asked = [];
  await searchBestCategory((kw) => (asked.push(kw), shopSearch(kw)), dove, () => {});
  assert.deepEqual(asked, ['牛奶巧克力', '巧克力']);
});

test('searchBestCategory: 叶子名完全一致时立刻停止，不再继续搜索', async () => {
  const asked = [];
  const search = (kw) => (asked.push(kw), shopSearch(kw));
  const target = await searchBestCategory(search, { leafCategory: '软糖', crumbs: ['休闲食品', '糖果', '软糖'] }, () => {});
  assert.deepEqual(target.cateList, [17991, 17994, 18133]);
  assert.deepEqual(asked, ['软糖']);
});

test('searchBestCategory: 一次搜索失败不影响后续关键词，全部无结果时返回 null', async () => {
  const logs = [];
  const search = (kw) => (kw === '牛奶巧克力' ? Promise.resolve({ ok: false, error: '找不到类目搜索框' }) : shopSearch(kw));
  assert.ok(await searchBestCategory(search, dove, (m) => logs.push(m)));
  assert.ok(logs.some((l) => l.includes('找不到类目搜索框')));
  assert.equal(await searchBestCategory(shopSearch, { leafCategory: '轮胎', crumbs: ['汽车用品', '轮胎'] }, () => {}), null);
});

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
