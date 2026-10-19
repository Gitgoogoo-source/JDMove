import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeChrome } from './helpers/fake-chrome.js';
import { openWorkTab, navigateTab, closeTab, sleep, NAV_BLOCKED_MSG } from '../src/lib/chrome-env.js';
import { publishItem } from '../src/lib/publisher.js';
import { CATEGORY_PAGE, CATEGORY_REDIRECT_MSG } from '../src/lib/category-search.js';
import { closeCollectTab } from '../src/lib/collector.js';
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

// 一个能走完整个填写流程的商品 + 京麦页面桥接（callBackend）的假实现
const fullItem = {
  id: '9',
  skuId: '9',
  edits: { cateList: ['1', '2', '3'] },
  product: {
    title: '德芙香浓黑巧克力 桶装480g',
    brand: { id: 1, name: '德芙' },
    price: 45.9,
    params: [],
    mainImages: ['data:,x'],
    detailImages: [],
    saleDims: [],
    variants: [],
    crumbs: ['休闲食品', '巧克力'],
    leafCategory: '巧克力',
  },
};

function publishBackend(skuResults) {
  const calls = [];
  let skuCall = 0;
  const replies = {
    status: { ready: true },
    getFormSchema: { ok: true, attrs: [], saleDimNames: ['规格'], fields: [] },
    setBasics: { ok: true, report: { title: 't' } },
    selectBrand: { ok: true, label: '德芙' },
    uploadMainImages: { ok: true, urls: ['jfs/1'] },
    fillSkuAttrDrawers: { ok: true, results: [] },
    runAction: { ok: true, messages: ['保存成功'] },
  };
  const backend = (method) => {
    calls.push(method);
    if (method === 'setSkuRows') return skuResults[Math.min(skuCall++, skuResults.length - 1)];
    return replies[method] ?? { ok: true };
  };
  return { calls, backend };
}

const skuOk = { ok: true, rows: 1, issues: [], missing: [] };

test('publishItem: 保存前重新写入并核对 SKU 价格/库存', async () => {
  const { calls, backend } = publishBackend([skuOk, skuOk]);
  installFakeChrome({ backend });
  const res = await publishItem(fullItem, mergeSettings({}), () => {});
  assert.equal(res.status, 'published');
  const lastSku = calls.lastIndexOf('setSkuRows');
  assert.ok(calls.indexOf('setSkuRows') < lastSku, '应写入两次');
  assert.equal(calls[lastSku + 1], 'runAction', '最后一次写入紧挨着保存');
});

test('publishItem: 保存前发现价格/库存被清空时停止保存，并保留页面', async () => {
  const lost = { ok: false, rows: 1, issues: ['第 1 行的京东价/库存没有写进去'], missing: [{ row: 0, price: '45.9', stock: '100' }] };
  const { calls, backend } = publishBackend([skuOk, lost]);
  installFakeChrome({ backend });
  const res = await publishItem(fullItem, mergeSettings({}), () => {});
  assert.equal(res.status, 'failed');
  assert.match(res.message, /京东价\/库存/);
  assert.ok(!calls.includes('runAction'));
  assert.ok(res.tabId, '保留标签页供检查');
});

// ---------- 图片提前处理 / 并发 / 耗时统计 ----------
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const withImages = (mainImages, detailImages = []) => ({ ...fullItem, product: { ...fullItem.product, mainImages, detailImages } });
const argsOf = (fake, method) => fake.calls.find((c) => c.op === 'inject.func' && c.args[0] === method)?.args[1] ?? null;

test('publishItem: 打开发布页之前就开始处理主图', async () => {
  const { backend } = publishBackend([skuOk, skuOk]);
  const fake = installFakeChrome({ backend });
  const tabOpenedAtFirstMake = [];
  const imageMakers = {
    main: async (url, name) => {
      tabOpenedAtFirstMake.push(fake.ops().includes('tabs.create'));
      return { name, mime: 'image/jpeg', b64: url };
    },
  };
  const res = await publishItem(withImages(['https://img/a.jpg']), mergeSettings({}), () => {}, { imageMakers });
  assert.equal(res.status, 'published');
  assert.deepEqual(tabOpenedAtFirstMake, [false]);
});

test('publishItem: 主图并发处理，上传时仍按原顺序排列', async () => {
  const { backend } = publishBackend([skuOk, skuOk]);
  const fake = installFakeChrome({ backend });
  let inflight = 0;
  let peak = 0;
  const imageMakers = {
    main: async (url, name) => {
      inflight += 1;
      peak = Math.max(peak, inflight);
      await delay(url === 'https://img/a.jpg' ? 20 : 2); // 第一张最慢
      inflight -= 1;
      return { name, mime: 'image/jpeg', b64: url };
    },
  };
  await publishItem(withImages(['https://img/a.jpg', 'https://img/b.jpg', 'https://img/c.jpg']), mergeSettings({}), () => {}, { imageMakers });
  const [mains] = argsOf(fake, 'uploadMainImages');
  assert.deepEqual(mains.map((m) => m.name), ['jdmove_9_m0.jpg', 'jdmove_9_m1.jpg', 'jdmove_9_m2.jpg']);
  assert.ok(peak > 1, '应同时处理多张');
});

test('publishItem: 单张主图处理失败只记日志，其余照常上传', async () => {
  const { backend } = publishBackend([skuOk, skuOk]);
  const fake = installFakeChrome({ backend });
  const logs = [];
  const imageMakers = {
    main: async (url, name) => {
      if (url.endsWith('bad.jpg')) throw new Error('图片下载失败 404');
      return { name, mime: 'image/jpeg', b64: url };
    },
  };
  await publishItem(withImages(['https://img/bad.jpg', 'https://img/ok.jpg']), mergeSettings({}), (m) => logs.push(m), { imageMakers });
  const [mains] = argsOf(fake, 'uploadMainImages');
  assert.deepEqual(mains.map((m) => m.name), ['jdmove_9_m1.jpg']);
  assert.ok(logs.some((l) => l.includes('图片处理失败：图片下载失败 404')));
});

test('publishItem: 详情图也提前处理，切片按原顺序转存', async () => {
  const { backend } = publishBackend([skuOk, skuOk]);
  const fake = installFakeChrome({
    backend: (method, args) => {
      if (method === 'uploadDetailImages') return { ok: true, urls: args[0].map((s) => `jfs/${s.name}`) };
      return backend(method, args);
    },
  });
  const imageMakers = {
    main: async (url, name) => ({ name, mime: 'image/jpeg', b64: url }),
    detail: async (url, base) => {
      await delay(url.endsWith('1.jpg') ? 15 : 1);
      return [`${base}_1.jpg`, `${base}_2.jpg`].map((name) => ({ name, mime: 'image/jpeg', b64: url }));
    },
  };
  const res = await publishItem(withImages(['https://img/a.jpg'], ['https://d/1.jpg', 'https://d/2.jpg']), mergeSettings({}), () => {}, { imageMakers });
  assert.equal(res.status, 'published');
  const [slices] = argsOf(fake, 'uploadDetailImages');
  assert.deepEqual(
    slices.map((s) => s.name.replace(/_\d+_(\d)\.jpg$/, '_$1.jpg')),
    ['jdmove_9_d0_1.jpg', 'jdmove_9_d0_2.jpg', 'jdmove_9_d1_1.jpg', 'jdmove_9_d1_2.jpg'],
  );
});

test('publishItem: 结束时日志里写出各步骤耗时', async () => {
  const { backend } = publishBackend([skuOk, skuOk]);
  installFakeChrome({ backend });
  const logs = [];
  const imageMakers = { main: async (url, name) => ({ name, mime: 'image/jpeg', b64: url }) };
  await publishItem(withImages(['https://img/a.jpg']), mergeSettings({}), (m) => logs.push(m), { imageMakers });
  const line = logs.find((l) => l.startsWith('耗时：'));
  assert.ok(line, '应有耗时日志');
  for (const step of ['打开页面', '页面就绪', '品牌', '后台主图处理 1 张', '等待主图处理', '主图上传', '保存', '合计']) {
    assert.ok(line.includes(step), `缺少 ${step}：${line}`);
  }
});

test('publishItem: 提前结束（需处理）时停止启动剩余图片的处理，并照样写耗时', async () => {
  installFakeChrome({ backend: (method) => (method === 'status' ? { ready: false, loginRequired: true } : undefined) });
  const started = [];
  const release = [];
  const imageMakers = {
    main: (url, name) => {
      started.push(url);
      return new Promise((r) => release.push(() => r({ name, mime: 'image/jpeg', b64: url })));
    },
  };
  const urls = Array.from({ length: 8 }, (_, i) => `https://img/${i}.jpg`);
  const logs = [];
  const res = await publishItem(withImages(urls), mergeSettings({}), (m) => logs.push(m), { imageMakers });
  assert.equal(res.status, 'need_action');
  assert.ok(logs.some((l) => l.startsWith('耗时：')));
  release.forEach((r) => r());
  await delay(5);
  assert.equal(started.length, 4, '只处理已经开始的那一批');
});
