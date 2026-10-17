import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCrawlState, applyPage, CRAWL_STOP_REASONS } from '../src/shared/shop-crawl.js';

const page = (skus, total = null) => ({ skus, total });
const ids = (from, n) => Array.from({ length: n }, (_, i) => String(from + i));

test('applyPage: 合并去重并按总数算出页数，最后一页后结束', () => {
  let s = createCrawlState();
  s = applyPage(s, page(ids(100000, 24), 30));
  assert.equal(s.pageNo, 1);
  assert.equal(s.pageCount, 2);
  assert.equal(s.added.length, 24);
  assert.equal(s.done, false);
  s = applyPage(s, page([...ids(100020, 4), ...ids(100024, 6)]));
  assert.equal(s.skus.length, 30);
  assert.deepEqual(s.added, ids(100024, 6));
  assert.equal(s.total, 30, '总数沿用第一页');
  assert.equal(s.done, true);
  assert.equal(s.reason, 'last');
});

test('applyPage: 不修改传入的状态', () => {
  const s0 = createCrawlState();
  const s1 = applyPage(s0, page(['100001'], 100));
  assert.equal(s0.pageNo, 0);
  assert.deepEqual(s0.skus, []);
  assert.notEqual(s1, s0);
});

test('applyPage: 空页结束（店铺没有商品或已越过最后一页）', () => {
  const s = applyPage(createCrawlState(), page([], 0));
  assert.equal(s.done, true);
  assert.equal(s.reason, 'empty');
});

test('applyPage: 整页都是已抓过的商品时结束，避免越界页重复返回同一页导致死循环', () => {
  let s = applyPage(createCrawlState(), page(ids(100000, 24)));
  s = applyPage(s, page(ids(100000, 24)));
  assert.equal(s.done, true);
  assert.equal(s.reason, 'repeat');
  assert.equal(s.skus.length, 24);
});

test('applyPage: 没有总数时按页数上限结束', () => {
  let s = createCrawlState();
  s = applyPage(s, page(ids(100000, 24)), { maxPages: 2 });
  assert.equal(s.done, false);
  s = applyPage(s, page(ids(200000, 24)), { maxPages: 2 });
  assert.equal(s.done, true);
  assert.equal(s.reason, 'limit');
});

test('applyPage: 已结束的状态不再变化', () => {
  const done = applyPage(createCrawlState(), page([], 0));
  assert.equal(applyPage(done, page(['100001'])), done);
});

test('CRAWL_STOP_REASONS: 每种结束原因都有中文说明', () => {
  for (const key of ['last', 'empty', 'repeat', 'limit']) assert.ok(CRAWL_STOP_REASONS[key]);
});
