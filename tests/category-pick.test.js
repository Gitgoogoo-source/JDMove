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
