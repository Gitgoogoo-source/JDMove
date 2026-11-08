import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeChrome } from './helpers/fake-chrome.js';
import { openWorkTab, navigateTab, closeTab, sleep, NAV_BLOCKED_MSG } from '../src/lib/chrome-env.js';
import { CATEGORY_PAGE } from '../src/lib/category-search.js';
import { closeCollectTab } from '../src/lib/collector.js';

const PUBLISH_URL = 'https://wares-jdm.jd.com/vcProductPublish/?bId=17519&categoryId=31403';
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

test('屏蔽脚本：页面监听里调用 preventDefault / 设置 returnValue 都不再生效', async () => {
  // 京麦发布页在 window 上注册的监听：e.preventDefault(); e.returnValue = '关闭提示'
  class FakeBeforeUnloadEvent extends Event {
    #rv = '';
    get returnValue() {
      return this.#rv;
    }
    set returnValue(v) {
      this.#rv = String(v);
    }
  }
  const win = new EventTarget();
  win.addEventListener('beforeunload', (e) => {
    e.preventDefault();
    e.returnValue = '关闭提示';
  });
  const fake = installFakeChrome();
  fake.seedTab({ id: 1, url: PUBLISH_URL });
  await navigateTab(1, CATEGORY_PAGE);
  const { func } = fake.calls.find(isDisarm);
  const saved = { window: globalThis.window, BeforeUnloadEvent: globalThis.BeforeUnloadEvent };
  Object.assign(globalThis, { window: win, BeforeUnloadEvent: FakeBeforeUnloadEvent });
  try {
    func();
    const e = new FakeBeforeUnloadEvent('beforeunload', { cancelable: true });
    win.dispatchEvent(e);
    assert.equal(e.defaultPrevented, false);
    assert.equal(e.returnValue, '');
  } finally {
    Object.assign(globalThis, saved);
  }
});

test('closeTab: 关闭前先屏蔽“离开此网站？”', async () => {
  const fake = installFakeChrome();
  fake.seedTab({ id: 1, url: PUBLISH_URL });
  await closeTab(1);
  const disarmAt = fake.calls.findIndex(isDisarm);
  const removeAt = fake.calls.findIndex((c) => c.op === 'tabs.remove');
  assert.ok(disarmAt >= 0 && disarmAt < removeAt);
});

test('closeCollectTab: 采集结束后关闭留在当前窗口的商品页', async () => {
  const fake = installFakeChrome();
  fake.seedTab({ id: 5, url: 'https://item.jd.com/1.html' });
  await chrome.storage.session.set({ collectTabId: 5 });
  await closeCollectTab();
  assert.ok(fake.calls.some((c) => c.op === 'tabs.remove' && c.tabId === 5));
  assert.deepEqual(await chrome.storage.session.get('collectTabId'), {});
});

test('closeCollectTab: 无痕采集标签页保留（关闭后消费者账号登录会丢失）', async () => {
  const fake = installFakeChrome();
  fake.seedTab({ id: 6, url: 'https://item.jd.com/1.html', incognito: true });
  await chrome.storage.session.set({ collectTabId: 6 });
  await closeCollectTab();
  assert.ok(!fake.ops().includes('tabs.remove'));
});

test('sleep: 任务面板在后台时改由 Service Worker 计时，避免被 Chrome 限流成每分钟一次', async () => {
  installFakeChrome();
  const sent = [];
  chrome.runtime = { sendMessage: async (msg) => sent.push(msg) };
  const saved = globalThis.document;
  globalThis.document = { visibilityState: 'hidden' };
  try {
    await sleep(25);
  } finally {
    globalThis.document = saved;
  }
  assert.deepEqual(sent, [{ type: 'sleep', ms: 25 }]);
});

test('sleep: 页面可见时直接用本地定时器', async () => {
  installFakeChrome();
  const sent = [];
  chrome.runtime = { sendMessage: async (msg) => sent.push(msg) };
  await sleep(5);
  assert.deepEqual(sent, []);
});
