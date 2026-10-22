// 批量发布队列：京麦提交接口限流时整批暂停并记下冷却时间
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeChrome } from './helpers/fake-chrome.js';
import { createQueueRunner } from '../src/lib/queue.js';

const THROTTLED_SAVE =
  '{"msg":"操作过于频繁，请稍后再试 2026-10-23 00:21:36","code":201,"dsm-trace-id":"5513108.41661.17926860967607905","bCode":"10003"}';

const task = (id) => ({
  id,
  skuId: id,
  url: `https://item.jd.com/${id}.html`,
  status: 'collected',
  message: '',
  log: [],
  target: null,
  createdAt: 1,
  updatedAt: 1,
  edits: { cateList: ['1', '2', '3'] },
  product: {
    title: '格力高百力滋缤纷装175g',
    brand: { id: 25570, name: '格力高（Glico）' },
    price: 11.9,
    params: [],
    mainImages: ['data:,x'],
    detailImages: ['https://d/1.jpg'],
    saleDims: [],
    variants: [],
    crumbs: ['休闲食品', '饼干'],
    leafCategory: '饼干',
  },
});

/** 京麦发布页桥接的假实现：每个方法都成功，runAction 的结果由测试指定 */
function fakePage(runAction) {
  const calls = [];
  const replies = {
    status: { ready: true },
    getFormSchema: { ok: true, attrs: [], saleDimNames: ['规格'], fields: [] },
    setBasics: { ok: true, report: { title: 't' } },
    selectBrand: { ok: true, label: '格力高' },
    uploadMainImages: { ok: true, urls: ['jfs/1'] },
    setSkuRows: { ok: true, rows: 1, issues: [], missing: [] },
    fillSkuAttrDrawers: { ok: true, results: [] },
    runAction,
  };
  const backend = (method) => {
    calls.push(method);
    return replies[method] ?? { ok: true };
  };
  return { calls, backend };
}

function setup(runAction, seed = {}) {
  const page = fakePage(runAction);
  const fake = installFakeChrome({ backend: page.backend });
  Object.assign(fake.localStore, { items: [task('1'), task('2')], settings: { publish: { reuploadDetailImages: false } }, ...seed });
  const logs = [];
  const runner = createQueueRunner({ onChange: () => {}, onLog: (l) => logs.push(l) });
  return { page, fake, logs, runner };
}

const throttled = { ok: false, messages: ['操作过于频繁，请稍后再试 2026-10-23 00:21:36'], errors: [], wareIds: [], saveResponses: [THROTTLED_SAVE] };

test('发布队列：京麦提交限流时整批暂停，后面的商品不再发布', async () => {
  const { page, logs, runner } = setup(throttled);
  await runner.publish(['1', '2']);
  assert.equal(page.calls.filter((m) => m === 'runAction').length, 1, '只提交了第一个');
  const st = runner.getState();
  assert.equal(st.pausedMode, 'publish');
  assert.match(st.pauseReason, /限流/);
  assert.ok(logs.some((l) => l.startsWith('已暂停')), logs.join('\n'));
});

test('发布队列：限流的商品回到“已采集”留在任务列表，并记下冷却结束时间', async () => {
  const { fake, runner } = setup(throttled, { settings: { publish: { reuploadDetailImages: false, throttleCooldownMin: 30 } } });
  const before = Date.now();
  await runner.publish(['1', '2']);
  const [first, second] = fake.localStore.items;
  assert.equal(first.status, 'collected');
  assert.match(first.message, /bCode 10003/);
  assert.equal(second.status, 'collected');
  const rec = fake.localStore.publishThrottle;
  assert.ok(rec.at >= before);
  assert.equal(rec.until - rec.at, 30 * 60e3);
  assert.match(rec.message, /限流/);
});

test('发布队列：之后发布成功时清除冷却记录', async () => {
  const ok = { ok: true, messages: ['提交成功'], errors: [], wareIds: ['10036348798874'] };
  const { fake, runner } = setup(ok, { publishThrottle: { at: 1, until: 2, message: '京麦提交接口限流' } });
  await runner.publish(['1']);
  assert.equal(fake.localStore.items[0].status, 'published');
  assert.equal(fake.localStore.publishThrottle, null);
});
