// 真实浏览器冒烟测试：插件加载、后台消息、弹窗和任务面板能正常打开
// 运行：npm run test:e2e（没有调试浏览器时自动以无头模式启动；E2E_ONLINE=1 时额外访问京东商品页）
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import * as b from '../../scripts/e2e/browser.mjs';
import { extUrl } from '../../scripts/e2e/config.mjs';

const ONLINE = process.env.E2E_ONLINE === '1';
const ONLINE_ITEM_URL = process.env.E2E_ITEM_URL ?? 'https://item.jd.com/100035179134.html';
const SETTLE_MS = 1500;

let browser;
let context;
let launchedHere = false;
const opened = [];

before(async () => {
  launchedHere = !(await b.isRunning());
  await b.launch({ headless: launchedHere ? true : undefined });
  ({ browser, context } = await b.connect());
  await b.extensionErrors(context, { clear: true });
});

after(async () => {
  await Promise.all(opened.map((p) => p.close().catch(() => {})));
  await browser?.close();
  if (launchedHere) await b.closeBrowser();
});

// 打开页面并收集它的报错（未捕获异常 + console.error）
async function openWatched(url) {
  const page = await context.newPage();
  opened.push(page);
  const problems = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && problems.push(`console.error: ${m.text()}`));
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(SETTLE_MS);
  return { page, problems };
}

test('插件已启用，开发者模式已打开', async () => {
  const info = await b.prepareProfile(context);
  assert.equal(info.state, 'ENABLED', `禁用原因：${info.disableReasons.join(',')}`);
});

test('后台 service worker 在运行且能执行代码', async () => {
  const url = await b.evalInServiceWorker(context, 'return location.pathname;');
  assert.equal(url, '/src/background/service-worker.js');
});

test('插件页 → 后台消息往返（sleep 处理器）', async () => {
  const res = await b.evalInExtension(context, "return chrome.runtime.sendMessage({ type: 'sleep', ms: 10 });");
  assert.deepEqual(res, { ok: true });
});

test('插件模块可以在插件页里直接 import 调用', async () => {
  const res = await b.evalInExtension(
    context,
    `const { settingsRepo } = await import('/src/lib/chrome-env.js');
     const s = await settingsRepo.get();
     return { action: s.publish?.action, hasVc: typeof s.vc === 'object' };`,
  );
  assert.deepEqual(res, { action: 'publish', hasVc: true });
});

test('弹窗页面正常渲染', async () => {
  const { page, problems } = await openWatched(extUrl('src/popup/popup.html'));
  assert.match(await page.locator('#stats').textContent(), /^任务 \d+ · 已采 \d+ · 已发 \d+$/);
  assert.deepEqual(problems, []);
});

test('任务面板正常渲染', async () => {
  const { page, problems } = await openWatched(extUrl('src/dashboard/dashboard.html'));
  assert.equal(await page.locator('#btnUpload').isVisible(), true);
  assert.deepEqual(problems, []);
});

test('chrome://extensions 里没有插件运行错误', async () => {
  assert.deepEqual(await b.extensionErrors(context), []);
});

test('京东商品页注入“搬运此商品”按钮', { skip: !ONLINE && '设置 E2E_ONLINE=1 才访问京东' }, async () => {
  const { page } = await openWatched(ONLINE_ITEM_URL);
  const landed = new URL(page.url()).hostname;
  assert.equal(
    landed,
    new URL(ONLINE_ITEM_URL).hostname,
    `被京东跳转到 ${page.url()}：请先 npm run e2e -- launch（有界面）并在调试浏览器里登录消费者账号`,
  );
  await page.locator('#jdmove-fab .jdmove-btn').waitFor({ state: 'attached', timeout: 15000 });
  assert.equal(await page.locator('#jdmove-fab .jdmove-btn').textContent(), '搬运此商品');
});
