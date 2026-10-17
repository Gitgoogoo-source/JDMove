import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeChrome } from './helpers/fake-chrome.js';
import { openWorkTab, navigateTab, closeTab, NAV_BLOCKED_MSG } from '../src/lib/chrome-env.js';
import { publishItem } from '../src/lib/publisher.js';
import { CATEGORY_PAGE, CATEGORY_REDIRECT_MSG } from '../src/lib/category-search.js';
import { mergeSettings } from '../src/shared/settings.js';

const PUBLISH_URL = 'https://wares-jdm.jd.com/popPublish/?categoryId=1';
const isDisarm = (c) => c.op === 'inject.func' && c.name === 'disarmBeforeUnloadInPage';

test('openWorkTab: 普通标签页直接开在当前窗口，不新建窗口', async () => {
  const fake = installFakeChrome({ currentWindowId: 42 });
  const tab = await openWorkTab('https://wares-jdm.jd.com/x');
  assert.equal(tab.url, 'https://wares-jdm.jd.com/x');
  assert.ok(!fake.ops().includes('windows.create'));
  const created = fake.calls.find((c) => c.op === 'tabs.create');
  assert.equal(created.windowId, 42);
  assert.equal(created.active, true);
});

test('openWorkTab: 无痕采集仍使用独立的无痕窗口', async () => {
  const fake = installFakeChrome();
  await openWorkTab('https://item.jd.com/1.html', { incognito: true });
  const win = fake.calls.find((c) => c.op === 'windows.create');
  assert.equal(win.opts.incognito, true);
});

test('navigateTab: 跳转前先屏蔽页面的“离开此网站？”', async () => {
  const fake = installFakeChrome();
  fake.seedTab({ id: 1, url: PUBLISH_URL });
  await navigateTab(1, CATEGORY_PAGE);
  const disarmAt = fake.calls.findIndex(isDisarm);
  const updateAt = fake.calls.findIndex((c) => c.op === 'tabs.update');
  assert.ok(disarmAt >= 0, '应注入屏蔽脚本');
  assert.ok(disarmAt < updateAt, '屏蔽必须发生在跳转之前');
});

test('navigateTab: 旧页面已是 complete 时，等到新页面加载完成才返回', async () => {
  const fake = installFakeChrome();
  fake.seedTab({ id: 1, url: PUBLISH_URL });
  const tab = await navigateTab(1, CATEGORY_PAGE);
  assert.equal(tab.url, CATEGORY_PAGE);
});

test('navigateTab: 跳转没有发生时报错，而不是在旧页面上继续执行', async () => {
  const fake = installFakeChrome({ resolveUrl: () => null });
  fake.seedTab({ id: 1, url: PUBLISH_URL });
  await assert.rejects(navigateTab(1, CATEGORY_PAGE, { startTimeoutMs: 30 }), (e) => e.message === NAV_BLOCKED_MSG);
});

test('closeTab: 关闭前先屏蔽“离开此网站？”', async () => {
  const fake = installFakeChrome();
  fake.seedTab({ id: 1, url: PUBLISH_URL });
  await closeTab(1);
  const disarmAt = fake.calls.findIndex(isDisarm);
  const removeAt = fake.calls.findIndex((c) => c.op === 'tabs.remove');
  assert.ok(disarmAt >= 0 && disarmAt < removeAt);
});

const item = (edits = {}) => ({
  id: '1',
  skuId: '1',
  edits,
  product: { crumbs: ['休闲食品', '巧克力', '牛奶巧克力'], leafCategory: '牛奶巧克力' },
});

test('publishItem: 类目页被京麦直接跳到发布页时，提示指定类目且不再来回跳转', async () => {
  const backendCalls = [];
  const fake = installFakeChrome({
    resolveUrl: (u) => (u === CATEGORY_PAGE ? PUBLISH_URL : u),
    backend: (method) => backendCalls.push(method),
  });
  const res = await publishItem(item(), mergeSettings({}), () => {});
  assert.equal(res.status, 'need_action');
  assert.equal(res.message, CATEGORY_REDIRECT_MSG);
  assert.ok(!backendCalls.includes('searchCategory'));
  assert.equal(fake.calls.filter((c) => c.op === 'tabs.update').length, 0, '不应再从发布页跳走');
  assert.ok(fake.ops().includes('tabs.remove'));
});

test('publishItem: 已指定类目时直接打开发布页，跳过类目选择页', async () => {
  const fake = installFakeChrome({
    backend: (method) => (method === 'status' ? { ready: false, loginRequired: true } : undefined),
  });
  const res = await publishItem(item({ cateList: ['1', '2', '3'] }), mergeSettings({}), () => {});
  assert.equal(res.message, '商家后台需要重新登录');
  const opened = fake.calls.filter((c) => c.op === 'tabs.create' || c.op === 'tabs.update').map((c) => c.url);
  assert.equal(opened.length, 1);
  assert.match(opened[0], /\/popPublish\/\?categoryId=3/);
});
