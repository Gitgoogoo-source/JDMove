import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCrawlState, applyPage, finishCrawl, CRAWL_STOP_REASONS } from '../src/shared/shop-crawl.js';

const page = (skus, extra = {}) => ({ skus, hasNext: true, ...extra });
const ids = (from, n) => Array.from({ length: n }, (_, i) => String(from + i));

test('applyPage: 合并去重，分页栏没有“下一页”时结束', () => {
  let s = createCrawlState();
  s = applyPage(s, page(ids(100000, 24), { total: 30, pagerMax: 2 }));
  assert.equal(s.pageNo, 1);
  assert.equal(s.pageCount, 2);
  assert.equal(s.added.length, 24);
  assert.equal(s.done, false);
  s = applyPage(s, page([...ids(100020, 4), ...ids(100024, 6)], { hasNext: false, pagerMax: 2 }));
  assert.equal(s.skus.length, 30);
  assert.deepEqual(s.added, ids(100024, 6));
  assert.equal(s.total, 30, '总数沿用第一页');
  assert.equal(s.done, true);
  assert.equal(s.reason, 'last');
});

test('applyPage: 页数取分页栏里出现过的最大页码，不按总数÷24 推算（每页条数因模板而异）', () => {
  // 亿滋模板：每页 20 个、共 74 件，实际 4 页；按 24 推算会得到错误的页数
  let s = applyPage(createCrawlState(), page(ids(100000, 20), { total: 74, pagerMax: 4 }));
  assert.equal(s.pageCount, 4);
  // 分页栏只显示附近页码时，页数随翻页增长且不回退
  s = applyPage(createCrawlState(), page(ids(100000, 20), { pagerMax: 3 }));
  s = applyPage(s, page(ids(200000, 20), { pagerMax: 5 }));
  s = applyPage(s, page(ids(300000, 20), { pagerMax: 4 }));
  assert.equal(s.pageCount, 5);
  assert.equal(s.done, false, '页数只用于显示，是否结束看有没有“下一页”');
});

test('applyPage: 总数大于本页数量但没有下一页时也结束（以分页栏为准）', () => {
  const s = applyPage(createCrawlState(), page(ids(100000, 20), { total: 74, hasNext: false }));
  assert.equal(s.done, true);
  assert.equal(s.reason, 'last');
});

test('applyPage: 不修改传入的状态', () => {
  const s0 = createCrawlState();
  const s1 = applyPage(s0, page(['100001'], { total: 100 }));
  assert.equal(s0.pageNo, 0);
  assert.deepEqual(s0.skus, []);
  assert.notEqual(s1, s0);
});

test('applyPage: 空页结束（店铺没有商品或已越过最后一页）', () => {
  const s = applyPage(createCrawlState(), page([], { total: 0 }));
  assert.equal(s.done, true);
  assert.equal(s.reason, 'empty');
});

test('applyPage: 整页都是已抓过的商品时结束，避免翻页没生效时死循环', () => {
  let s = applyPage(createCrawlState(), page(ids(100000, 24)));
  s = applyPage(s, page(ids(100000, 24)));
  assert.equal(s.done, true);
  assert.equal(s.reason, 'repeat');
  assert.equal(s.skus.length, 24);
});

test('applyPage: 一直有下一页时按页数上限结束', () => {
  let s = createCrawlState();
  s = applyPage(s, page(ids(100000, 24)), { maxPages: 2 });
  assert.equal(s.done, false);
  s = applyPage(s, page(ids(200000, 24)), { maxPages: 2 });
  assert.equal(s.done, true);
  assert.equal(s.reason, 'limit');
});

test('applyPage: 已结束的状态不再变化', () => {
  const done = applyPage(createCrawlState(), page([], { total: 0 }));
  assert.equal(applyPage(done, page(['100001'])), done);
});

test('finishCrawl: 翻页时发现没有下一页，直接结束且保留已抓结果', () => {
  const s = applyPage(createCrawlState(), page(ids(100000, 3)));
  const end = finishCrawl(s, 'last');
  assert.equal(end.done, true);
  assert.equal(end.reason, 'last');
  assert.deepEqual(end.skus, s.skus);
  assert.equal(s.done, false);
  assert.equal(finishCrawl(end, 'limit'), end);
});

test('CRAWL_STOP_REASONS: 每种结束原因都有中文说明', () => {
  for (const key of ['last', 'empty', 'repeat', 'limit']) assert.ok(CRAWL_STOP_REASONS[key]);
});
