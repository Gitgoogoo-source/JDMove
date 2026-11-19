// 上架表批次：记下这张表的商品，判断采集是否结束，最多保留最近 20 个
import test from 'node:test';
import assert from 'node:assert/strict';
import { BATCHES_KEY, batchesToExport, batchProgress, createBatchRepository, idsToCollect, MAX_BATCHES, newBatch } from '../src/shared/batch.js';

const memory = () => {
  const data = {};
  return { data, get: async (k) => data[k], set: async (k, v) => (data[k] = v) };
};
const link = (skuId, row) => ({ skuId, url: `https://item.jd.com/${skuId}.html`, label: '', refs: [{ sheet: 'Sheet1', row }] });

test('newBatch：记下文件名、链接和要跟进的商品', () => {
  const b = newBatch({ fileName: '上架表.xlsx', links: [link('1', 2), link('2', 3)], skuIds: ['1', '2'], now: 1000 });
  assert.equal(b.id, 'b1000');
  assert.equal(b.fileName, '上架表.xlsx');
  assert.deepEqual(b.skuIds, ['1', '2']);
  assert.equal(b.exportedAt, undefined);
});

test('batchProgress：没有待采集/采集中的商品时算采集结束；已发布（移出任务列表）、已删除的不拖住批次', () => {
  const b = newBatch({ fileName: 'a', links: [], skuIds: ['1', '2', '3', '4', '5'], now: 1 });
  const items = [
    { id: '1', status: 'collected', product: {} },
    { id: '2', status: 'failed', product: null },
    { id: '3', status: 'pending', product: null },
  ];
  const p = batchProgress(b, items, new Set(['4']));
  assert.deepEqual({ ...p }, { total: 5, collected: 1, failed: 1, waiting: 1, published: 1, removed: 1, done: false });
  assert.equal(batchProgress(b, items.map((i) => (i.id === '3' ? { ...i, status: 'collecting' } : i))).done, false);
  assert.equal(batchProgress(b, items.filter((i) => i.id !== '3')).done, true);
  assert.equal(batchProgress(b, items).removed, 2, '不传已发布记录时都算删掉的');
  assert.equal(batchProgress(b, [{ id: '1', status: 'need_action', product: {} }]).collected, 1, '发布失败/需处理的仍算已采集');
});

test('createBatchRepository：新批次在前，最多保留 MAX_BATCHES 个；update 只改指定批次', async () => {
  const storage = memory();
  const repo = createBatchRepository(storage);
  for (let i = 0; i < MAX_BATCHES + 2; i++) await repo.add(newBatch({ fileName: `f${i}`, links: [], skuIds: [], now: i + 1 }));
  const list = await repo.list();
  assert.equal(list.length, MAX_BATCHES);
  assert.equal(list[0].fileName, `f${MAX_BATCHES + 1}`);
  const next = await repo.update(list[1].id, { exportedAt: 5 });
  assert.equal(next.exportedAt, 5);
  assert.equal((await repo.list())[1].exportedAt, 5);
  assert.equal(await repo.update('nope', { exportedAt: 1 }), null);
  assert.ok(Array.isArray(storage.data[BATCHES_KEY]));
});

test('idsToCollect：只采还没数据的；勾选重新采集时已采集的也采；正在采集、不在列表的不动', () => {
  const items = [
    { id: '1', status: 'pending', product: null },
    { id: '2', status: 'collected', product: {} },
    { id: '3', status: 'failed', product: null },
    { id: '5', status: 'collecting', product: null },
    { id: '6', status: 'need_action', product: {} },
  ];
  const ids = ['1', '2', '3', '4', '5', '6', '7'];
  assert.deepEqual(idsToCollect(ids, items), ['1', '3']);
  assert.deepEqual(idsToCollect(ids, items, { recollect: true }), ['1', '2', '3', '6']);
});

test('batchesToExport：采集完、没生成过、没关掉的批次', () => {
  const items = [
    { id: '1', status: 'collected', product: {} },
    { id: '2', status: 'pending', product: null },
  ];
  const done = newBatch({ fileName: 'a', links: [], skuIds: ['1'], now: 1 });
  const waiting = newBatch({ fileName: 'b', links: [], skuIds: ['1', '2'], now: 2 });
  const exported = { ...newBatch({ fileName: 'c', links: [], skuIds: ['1'], now: 3 }), exportedAt: 9 };
  const dismissed = { ...newBatch({ fileName: 'd', links: [], skuIds: ['1'], now: 4 }), dismissed: true };
  assert.deepEqual(batchesToExport([done, waiting, exported, dismissed], items).map((b) => b.fileName), ['a']);
});
