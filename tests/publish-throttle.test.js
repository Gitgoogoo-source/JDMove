import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSaveResponse, detectSaveThrottle, throttleRecord, cooldownLeftMs, cooldownNotice } from '../src/shared/publish-throttle.js';
import { createThrottleRepository, publishResultPatch } from '../src/shared/store.js';
import { mergeSettings, validateSettings } from '../src/shared/settings.js';

// 2026-10-23 京麦 saveProductNew 的真实返回（店铺被限流时，换商品、换标题、换条形码都是这一句）
const THROTTLED =
  '{"msg":"操作过于频繁，请稍后再试 2026-10-23 00:21:36","code":201,"dsm-trace-id":"5513108.41661.17926860967607905","bCode":"10003"}';

test('parseSaveResponse: 读出提交接口返回的 code、bCode、msg 和 trace-id', () => {
  assert.deepEqual(parseSaveResponse(THROTTLED), {
    code: '201',
    bCode: '10003',
    msg: '操作过于频繁，请稍后再试 2026-10-23 00:21:36',
    traceId: '5513108.41661.17926860967607905',
  });
});

test('parseSaveResponse: 不是 JSON 或不是对象时返回 null', () => {
  assert.equal(parseSaveResponse('<html>502</html>'), null);
  assert.equal(parseSaveResponse('"ok"'), null);
  assert.equal(parseSaveResponse(undefined), null);
});

test('detectSaveThrottle: bCode 10003 判定为限流，提示里带上原文、bCode 和 trace-id', () => {
  const hit = detectSaveThrottle({ responses: [THROTTLED], messages: [] });
  assert.ok(hit);
  assert.equal(hit.bCode, '10003');
  assert.equal(hit.traceId, '5513108.41661.17926860967607905');
  assert.match(hit.message, /限流/);
  assert.match(hit.message, /操作过于频繁，请稍后再试 2026-10-23 00:21:36/);
  assert.match(hit.message, /bCode 10003/);
  assert.match(hit.message, /5513108\.41661\.17926860967607905/);
});

test('detectSaveThrottle: bCode 10003 但文字不是“过于频繁”时不算限流（只见过一种限流返回，不靠错误码单独判断）', () => {
  assert.equal(detectSaveThrottle({ responses: ['{"code":201,"bCode":"10003","msg":"商品标题含违禁词"}'] }), null);
});

test('detectSaveThrottle: 限流提示以确认弹窗出现时（confirmText）也能识别', () => {
  const hit = detectSaveThrottle({ responses: [], messages: [], confirmText: '提示 操作过于频繁，请稍后再试 2026-10-23 00:21:36 确定' });
  assert.ok(hit);
});

test('detectSaveThrottle: 没有 bCode、但返回文字是“过于频繁”时也算限流', () => {
  const hit = detectSaveThrottle({ responses: ['{"code":429,"msg":"请求过于频繁"}'] });
  assert.ok(hit);
  assert.match(hit.message, /请求过于频繁/);
});

test('detectSaveThrottle: 没拿到接口返回时，按页面提示“操作过于频繁”判定', () => {
  const hit = detectSaveThrottle({ responses: [], messages: ['操作过于频繁，请稍后再试 2026-10-22 23:49:54'] });
  assert.ok(hit);
  assert.match(hit.message, /操作过于频繁，请稍后再试 2026-10-22 23:49:54/);
});

test('detectSaveThrottle: 其他提交失败（如保证金、成功返回）不算限流', () => {
  assert.equal(detectSaveThrottle({ responses: ['{"code":500,"msg":"类目需缴纳保证金"}'], messages: ['类目需缴纳保证金'] }), null);
  assert.equal(detectSaveThrottle({ responses: ['{"code":200,"msg":"成功","data":{"productId":10036327675342}}'] }), null);
  assert.equal(detectSaveThrottle({}), null);
  assert.equal(detectSaveThrottle({ responses: ['not json'], messages: ['请填写商品条形码'] }), null);
});

const at = (h, m, s = 0) => new Date(2026, 9, 23, h, m, s).getTime();

test('throttleRecord / cooldownLeftMs: 按设置的分钟数记录冷却结束时间', () => {
  const rec = throttleRecord({ message: '京麦提交接口限流', now: at(0, 21, 36), cooldownMin: 60 });
  assert.deepEqual(rec, { at: at(0, 21, 36), until: at(1, 21, 36), message: '京麦提交接口限流' });
  assert.equal(cooldownLeftMs(rec, at(0, 51, 36)), 30 * 60e3);
  assert.equal(cooldownLeftMs(rec, at(1, 21, 36)), 0);
  assert.equal(cooldownLeftMs(null, at(0, 30)), 0);
});

test('cooldownNotice: 冷却中写出被拒时间和建议的重试时间；冷却结束后为空', () => {
  const rec = throttleRecord({ message: '京麦提交接口限流', now: at(0, 21, 36), cooldownMin: 60 });
  const text = cooldownNotice(rec, at(0, 30));
  assert.match(text, /00:21/);
  assert.match(text, /01:21/);
  assert.equal(cooldownNotice(rec, at(1, 22)), '');
  assert.equal(cooldownNotice(null, at(1, 22)), '');
});

test('设置：限流冷却时间默认 60 分钟，超出 0~1440 时恢复默认', () => {
  assert.equal(mergeSettings({}).publish.throttleCooldownMin, 60);
  assert.equal(validateSettings({ publish: { throttleCooldownMin: 0 } }).value.publish.throttleCooldownMin, 0);
  const bad = validateSettings({ publish: { throttleCooldownMin: 5000 } });
  assert.equal(bad.value.publish.throttleCooldownMin, 60);
  assert.ok(bad.errors.some((e) => e.includes('冷却')));
});

test('publishResultPatch: 限流（没提交成功）的商品回到“已采集”，留在任务列表等冷却后重新发布', () => {
  const item = { id: '1', status: 'publishing', target: null };
  const patch = publishResultPatch(item, { status: 'throttle', message: '京麦提交接口限流：操作过于频繁' });
  assert.equal(patch.status, 'collected');
  assert.match(patch.message, /限流/);
  assert.equal(patch.publishedAt, undefined);
});

test('publishResultPatch: “已发布”页里重新发布遇到限流时标为失败，仍留在“已发布”页', () => {
  const item = { id: '1', status: 'published', target: null, publishedAt: 5 };
  const patch = publishResultPatch(item, { status: 'throttle', message: '京麦提交接口限流：操作过于频繁' });
  assert.equal(patch.status, 'failed');
});

test('createThrottleRepository: 记录、读取、清除冷却记录', async () => {
  const data = {};
  const repo = createThrottleRepository({ get: async (k) => data[k], set: async (k, v) => (data[k] = v) });
  assert.equal(await repo.get(), null);
  await repo.set({ at: 1, until: 2, message: 'm' });
  assert.deepEqual(await repo.get(), { at: 1, until: 2, message: 'm' });
  await repo.clear();
  assert.equal(await repo.get(), null);
});
