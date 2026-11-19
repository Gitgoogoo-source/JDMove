// 发布结果汇总（纯函数）：一轮发布结束后哪些成功、哪些失败，以及失败表格
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FAILURE_HEADER, failureFileName, failureSheet, publishReport } from '../src/shared/publish-report.js';

const ok = (id, skus = ['100200300401']) => ({ id, status: 'published', message: '商品已发布', title: `商品${id}`, refUrl: `https://item.jd.com/${id}.html`, skus, name: `维达商品${id}` });
const bad = (id, status = 'failed', message = '提交未成功') => ({ id, status, message, title: `商品${id}`, refUrl: `https://item.jd.com/${id}.html`, skus: [] });

test('发布结果：按商品分成功和失败，顺序和任务一致', () => {
  const r = publishReport({ ids: ['1', '2', '3'], results: [ok('1'), bad('2'), ok('3')] });
  assert.equal(r.total, 3);
  assert.deepEqual(r.succeeded.map((x) => x.id), ['1', '3']);
  assert.deepEqual(r.failed.map((x) => x.id), ['2']);
  assert.equal(r.failed[0].reason, '提交未成功');
  assert.equal(r.failed[0].statusText, '失败');
  assert.deepEqual(r.succeeded[0].skus, ['100200300401']);
});

test('发布结果：已填写没点发布、需处理、限流都算没成功，带上各自的说明', () => {
  const r = publishReport({
    ids: ['1', '2', '3'],
    results: [bad('1', 'filled', '已填写完成，请手动点“发布商品”'), bad('2', 'need_action', '缺少京东价'), bad('3', 'throttle', '接口限流')],
  });
  assert.equal(r.succeeded.length, 0);
  assert.deepEqual(r.failed.map((x) => x.statusText), ['已填写，未点发布', '需处理', '限流']);
  assert.equal(r.failed[1].reason, '缺少京东价');
});

test('发布结果：暂停/停止后没轮到的商品也列为失败，原因写明没有执行', () => {
  const items = [{ id: '3', url: 'https://item.jd.com/3.html', product: { title: '清风抽纸' } }];
  const paused = publishReport({ ids: ['1', '2', '3'], results: [bad('1', 'throttle', '接口限流'), ok('2')], items, paused: true, pauseReason: '接口限流' });
  const skipped = paused.failed.find((x) => x.id === '3');
  assert.equal(skipped.statusText, '没有执行');
  assert.match(skipped.reason, /暂停.*接口限流/);
  assert.equal(skipped.title, '清风抽纸');
  assert.equal(skipped.refUrl, 'https://item.jd.com/3.html');

  const left = [{ id: '1', url: '' }, { id: '2', url: '' }];
  const stopped = publishReport({ ids: ['1', '2'], results: [ok('1')], items: left, stopped: true });
  assert.match(stopped.failed[0].reason, /停止/);
  const aborted = publishReport({ ids: ['1'], results: [], items: left, aborted: true });
  assert.match(aborted.failed[0].reason, /异常中止/);
});

test('发布结果：任务里已经不存在的商品（被删掉）不算', () => {
  const r = publishReport({ ids: ['1', '9'], results: [ok('1')], items: [] });
  assert.equal(r.total, 1);
  assert.equal(r.failed.length, 0);
});

test('发布结果：同一个商品出现两次只算一次', () => {
  const r = publishReport({ ids: ['1', '1'], results: [ok('1')] });
  assert.equal(r.total, 1);
});

test('失败表格：一行一个失败商品，SKU 和链接设成文本列', () => {
  const r = publishReport({ ids: ['1', '2'], results: [bad('1', 'failed', '页面校验没通过：缺少型号'), bad('2', 'need_action', '缺少京东价')] });
  const sheet = failureSheet(r.failed, new Date(2026, 10, 20, 14, 5));
  assert.equal(sheet.name, '发布失败');
  assert.deepEqual(sheet.rows[0], FAILURE_HEADER);
  assert.equal(sheet.rows.length, 3);
  const row = Object.fromEntries(FAILURE_HEADER.map((h, i) => [h, sheet.rows[1][i]]));
  assert.equal(row['序号'], 1);
  assert.equal(row['参考SKU'], '1');
  assert.equal(row['商品名称'], '商品1');
  assert.equal(row['上架参考链接'], 'https://item.jd.com/1.html');
  assert.equal(row['结果'], '失败');
  assert.equal(row['失败原因'], '页面校验没通过：缺少型号');
  assert.equal(row['发布时间'], '2026-11-20 14:05');
  assert.ok(sheet.textColumns.includes(FAILURE_HEADER.indexOf('参考SKU')));
  assert.equal(sheet.widths.length, FAILURE_HEADER.length);
});

test('失败表格文件名带日期时间', () => {
  assert.equal(failureFileName(new Date(2026, 10, 20, 9, 3)), '发布失败-20261120-0903.xlsx');
});
