import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStopwatch, formatDuration } from '../src/shared/stopwatch.js';

const fakeClock = (start = 1000) => {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms) };
};

test('formatDuration: 不到 1 秒用毫秒，否则保留一位小数的秒', () => {
  assert.equal(formatDuration(0), '0ms');
  assert.equal(formatDuration(349.6), '350ms');
  assert.equal(formatDuration(1000), '1.0s');
  assert.equal(formatDuration(6240), '6.2s');
  assert.equal(formatDuration(-5), '0ms');
});

test('stopwatch: lap 记录距上一段结束的用时', () => {
  const clock = fakeClock();
  const sw = createStopwatch(clock.now);
  clock.advance(2100);
  assert.equal(sw.lap('打开页面'), 2100);
  clock.advance(300);
  assert.equal(sw.lap('品牌'), 300);
  assert.deepEqual(sw.entries(), [
    { label: '打开页面', ms: 2100 },
    { label: '品牌', ms: 300 },
  ]);
});

test('stopwatch: record 记录后台任务用时，不影响下一段 lap 的起点', () => {
  const clock = fakeClock();
  const sw = createStopwatch(clock.now);
  clock.advance(500);
  sw.record('后台主图处理 3 张', 4000);
  clock.advance(500);
  assert.equal(sw.lap('属性'), 1000);
});

test('stopwatch: summary 列出各段用时和从开始到现在的合计', () => {
  const clock = fakeClock();
  const sw = createStopwatch(clock.now);
  clock.advance(2000);
  sw.lap('打开页面');
  sw.record('后台主图处理 2 张', 1500);
  clock.advance(40);
  sw.lap('等待主图处理');
  assert.equal(sw.summary(), '打开页面 2.0s，后台主图处理 2 张 1.5s，等待主图处理 40ms；合计 2.0s');
});

test('stopwatch: entries 返回副本，外部修改不影响内部记录', () => {
  const clock = fakeClock();
  const sw = createStopwatch(clock.now);
  sw.lap('a');
  sw.entries().push({ label: 'x', ms: 1 });
  assert.equal(sw.entries().length, 1);
});
