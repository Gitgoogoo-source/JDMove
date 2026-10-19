import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapPool } from '../src/shared/async-pool.js';

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

test('mapPool: 结果按输入顺序返回，与完成先后无关', async () => {
  const out = await mapPool([30, 1, 15, 5], 4, async (ms, i) => {
    await delay(ms);
    return `${i}:${ms}`;
  });
  assert.deepEqual(out, ['0:30', '1:1', '2:15', '3:5']);
});

test('mapPool: 同时执行的任务数不超过上限', async () => {
  let inflight = 0;
  let peak = 0;
  await mapPool(Array.from({ length: 10 }, (_, i) => i), 3, async () => {
    inflight += 1;
    peak = Math.max(peak, inflight);
    await delay(2);
    inflight -= 1;
  });
  assert.equal(peak, 3);
});

test('mapPool: 上限大于任务数、空列表都能正常返回', async () => {
  assert.deepEqual(await mapPool([1, 2], 8, async (x) => x * 2), [2, 4]);
  assert.deepEqual(await mapPool([], 4, async () => 1), []);
});

test('mapPool: 任务出错时整体失败，且不再启动新任务', async () => {
  const started = [];
  await assert.rejects(
    mapPool([0, 1, 2, 3, 4], 1, async (x) => {
      started.push(x);
      if (x === 1) throw new Error('boom');
      return x;
    }),
    /boom/,
  );
  assert.deepEqual(started, [0, 1]);
});

test('mapPool: 取消后不再启动新任务，未启动的结果为 undefined', async () => {
  const controller = new AbortController();
  const started = [];
  const out = await mapPool(
    [0, 1, 2, 3],
    2,
    async (x) => {
      started.push(x);
      await delay(5);
      if (x === 0) controller.abort();
      return x;
    },
    { signal: controller.signal },
  );
  assert.deepEqual(started, [0, 1]);
  assert.deepEqual(out, [0, 1, undefined, undefined]);
});

test('mapPool: 并发上限不是正整数时报错', async () => {
  await assert.rejects(mapPool([1], 0, async (x) => x), RangeError);
  await assert.rejects(mapPool([1], Number.NaN, async (x) => x), RangeError);
});
