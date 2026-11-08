// 批量发布队列：保存接口限流时整批暂停并记下冷却时间（发布单个商品的流程用假的，只测队列）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeChrome } from './helpers/fake-chrome.js';
import { createQueueRunner } from '../src/lib/queue.js';

const THROTTLE_MSG = '京麦提交接口限流：操作过于频繁，请稍后再试（bCode 10003，trace-id 5513108.41661.17926860967607905）';

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
  edits: {},
  product: { title: '维达抽纸', mainImages: ['https://img/1.jpg'], detailImages: ['https://d/1.jpg'], params: [], crumbs: [] },
});

/** 每次发布都返回 result，并记下发布了哪些商品 */
function setup(result, seed = {}) {
  const fake = installFakeChrome();
  Object.assign(fake.localStore, { items: [task('1'), task('2')], settings: {}, ...seed });
  const published = [];
  const logs = [];
  const publish = async (item) => {
    published.push(item.id);
    return result;
  };
  const runner = createQueueRunner({ onChange: () => {}, onLog: (l) => logs.push(l) }, { publish });
  return { fake, logs, runner, published };
}

const throttled = { status: 'throttle', message: THROTTLE_MSG };

test('发布队列：保存接口限流时整批暂停，后面的商品不再发布', async () => {
  const { logs, runner, published } = setup(throttled);
  await runner.publish(['1', '2']);
  assert.deepEqual(published, ['1'], '只发布了第一个');
  const st = runner.getState();
  assert.equal(st.pausedMode, 'publish');
  assert.match(st.pauseReason, /限流/);
  assert.ok(logs.some((l) => l.startsWith('已暂停')), logs.join('\n'));
});

test('发布队列：限流的商品回到“已采集”留在任务列表，并记下冷却结束时间', async () => {
  const { fake, runner } = setup(throttled, { settings: { publish: { throttleCooldownMin: 30 } } });
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

test('发布队列：之后保存成功时清除冷却记录，并记下 VC 京东价', async () => {
  const { fake, runner } = setup({ status: 'published', message: '已保存草稿', price: 69.9 }, { publishThrottle: { at: 1, until: 2, message: '京麦提交接口限流' } });
  await runner.publish(['1']);
  assert.equal(fake.localStore.items[0].status, 'published');
  assert.equal(fake.localStore.items[0].salePrice, 69.9);
  assert.equal(fake.localStore.publishThrottle, null);
});
