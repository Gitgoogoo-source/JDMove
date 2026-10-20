// 价格检查（采集窗口只读价格）与改价（商品编辑页）的流程测试
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeChrome } from './helpers/fake-chrome.js';
import { checkPriceUrl } from '../src/lib/collector.js';
import { repriceItem, LOGIN_MSG } from '../src/lib/repricer.js';
import { mergeSettings } from '../src/shared/settings.js';

const ITEM_URL = 'https://item.jd.com/100001.html';
const TEMPLATE = 'https://wares-jdm.jd.com/popPublish/?wareId={wareId}&publishType=2';
const settingsWith = (priceWatch = {}) => mergeSettings({ priceWatch: { editUrlTemplate: TEMPLATE, ...priceWatch } });
const published = (extra = {}) => ({
  id: '100001',
  skuId: '100001',
  status: 'published',
  shopWareId: '10088812345',
  salePrice: 55,
  edits: {},
  ...extra,
});

test('checkPriceUrl: 读出商品页显示的价格和标签', async () => {
  installFakeChrome({ page: () => ({ pageType: 'item', skuId: '100001', priceText: '60.5', label: '补贴价' }) });
  assert.deepEqual(await checkPriceUrl(ITEM_URL), { status: 'ok', price: 60.5, label: '补贴价' });
});

test('checkPriceUrl: 页面没有价格时报错（可能已下架），频控页要求暂停', async () => {
  installFakeChrome({ page: () => ({ pageType: 'item', priceText: '', label: '' }) });
  const none = await checkPriceUrl(ITEM_URL);
  assert.equal(none.status, 'error');
  assert.match(none.message, /没有显示价格/);

  installFakeChrome({ resolveUrl: () => 'https://safe.jd.com/verify', page: () => assert.fail('不应在验证页上执行脚本') });
  assert.equal((await checkPriceUrl(ITEM_URL)).status, 'throttle');
});

function backendFor(responses) {
  const calls = [];
  const backend = (method, args) => {
    calls.push({ method, args });
    return typeof responses[method] === 'function' ? responses[method](...args) : responses[method];
  };
  return { calls, backend };
}

/** 编辑页：改价前读到原价，改价后读到新价 */
function editPage({ before = ['55', '55'], after = null, ...overrides } = {}) {
  let written = null;
  return {
    status: { page: 'publish' },
    skuRowCount: before.length,
    readSkuPrices: () => ({ ok: true, prices: written == null ? before : after ?? before.map(() => String(written)) }),
    setSkuPrices: (price) => {
      written = price;
      return { ok: true, rows: before.length, before };
    },
    runAction: { ok: true, messages: ['保存成功'] },
    ...overrides,
  };
}

test('repriceItem: 打开该商品的编辑页，改京东价后点提交/保存，完成后关闭标签页', async () => {
  const { calls, backend } = backendFor(editPage());
  const fake = installFakeChrome({ backend });
  const logs = [];
  const res = await repriceItem(published(), 61, settingsWith(), (m) => logs.push(m));
  assert.deepEqual(res, { status: 'ok', message: '保存成功', from: '55', draft: false });
  assert.equal(fake.calls.find((c) => c.op === 'tabs.create').url, 'https://wares-jdm.jd.com/popPublish/?wareId=10088812345&publishType=2');
  assert.deepEqual(calls.find((c) => c.method === 'setSkuPrices').args, [61]);
  assert.deepEqual(calls.find((c) => c.method === 'runAction').args, ['auto']);
  assert.ok(fake.ops().includes('tabs.remove'));
  assert.match(logs.join('\n'), /京东价 55 → 61/);
});

test('repriceItem: “只填写不保存”时停在页面，不点提交', async () => {
  const { calls, backend } = backendFor(editPage());
  const fake = installFakeChrome({ backend });
  const res = await repriceItem(published(), 61, settingsWith({ repriceAction: 'none' }), () => {});
  assert.equal(res.status, 'filled');
  assert.ok(!calls.some((c) => c.method === 'runAction'));
  assert.ok(!fake.ops().includes('tabs.remove'));
});

test('repriceItem: 价格没写进去或提交失败时保留页面并说明原因', async () => {
  const lost = backendFor(editPage({ setSkuPrices: { ok: false, error: '第 1 个 SKU 的京东价没有写进去', rows: 1, before: [] } }));
  const fake = installFakeChrome({ backend: lost.backend });
  const res = await repriceItem(published(), 61, settingsWith(), () => {});
  assert.deepEqual(res, { status: 'failed', message: '第 1 个 SKU 的京东价没有写进去', from: '55' });
  assert.ok(!lost.calls.some((c) => c.method === 'runAction'));
  assert.ok(!fake.ops().includes('tabs.remove'));

  const noButton = backendFor(editPage({ runAction: { ok: false, error: '找不到“提交”或“保存”按钮' } }));
  installFakeChrome({ backend: noButton.backend });
  const failed = await repriceItem(published(), 61, settingsWith(), () => {});
  assert.equal(failed.status, 'failed');
  assert.match(failed.message, /找不到/);
});

test('repriceItem: 商家后台未登录时返回 login，由任务暂停', async () => {
  const { backend } = backendFor(editPage({ status: { loginRequired: true } }));
  installFakeChrome({ backend });
  assert.deepEqual(await repriceItem(published(), 61, settingsWith(), () => {}), { status: 'login', message: LOGIN_MSG });
});

test('repriceItem: 编辑页上的原价与记录的售价对不上时不改价（可能打开了别的商品）', async () => {
  const wrong = backendFor(editPage({ before: ['99'] }));
  const fake = installFakeChrome({ backend: wrong.backend });
  const res = await repriceItem(published(), 61, settingsWith(), () => {});
  assert.equal(res.status, 'need_action');
  assert.match(res.message, /对不上/);
  assert.ok(!wrong.calls.some((c) => c.method === 'setSkuPrices'));
  assert.ok(!fake.ops().includes('tabs.remove'), '保留编辑页供人工核对');

  // 用户确认编号无误、取消核对后照常改价
  const unchecked = backendFor(editPage({ before: ['99'] }));
  installFakeChrome({ backend: unchecked.backend });
  assert.equal((await repriceItem(published(), 61, settingsWith(), () => {}, { verify: false })).status, 'ok');
});

test('repriceItem: 新价格被页面改回去时不提交', async () => {
  const reverted = backendFor(editPage({ after: ['55', '55'] }));
  installFakeChrome({ backend: reverted.backend });
  const res = await repriceItem(published(), 61, settingsWith(), () => {});
  assert.equal(res.status, 'failed');
  assert.match(res.message, /改成了 ¥55/);
  assert.ok(!reverted.calls.some((c) => c.method === 'runAction'));
});

test('repriceItem: 改价后只保存草稿时标记为草稿', async () => {
  const { calls, backend } = backendFor(editPage());
  installFakeChrome({ backend });
  const res = await repriceItem(published(), 61, settingsWith({ repriceAction: 'draft' }), () => {});
  assert.equal(res.status, 'ok');
  assert.equal(res.draft, true);
  assert.deepEqual(calls.find((c) => c.method === 'runAction').args, ['draft']);
});

test('repriceItem: 缺少店铺商品编号或编辑页地址时不打开页面', async () => {
  const fake = installFakeChrome();
  const noId = await repriceItem(published({ shopWareId: '' }), 61, settingsWith(), () => {});
  assert.equal(noId.status, 'need_action');
  assert.match(noId.message, /店铺商品编号/);
  const noTemplate = await repriceItem(published(), 61, mergeSettings({}), () => {});
  assert.equal(noTemplate.status, 'need_action');
  assert.match(noTemplate.message, /商品编辑页地址/);
  const badPrice = await repriceItem(published(), 0, settingsWith(), () => {});
  assert.equal(badPrice.status, 'need_action');
  assert.ok(!fake.ops().includes('tabs.create'));
});
