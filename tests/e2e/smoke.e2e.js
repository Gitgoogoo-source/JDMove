// 真实浏览器冒烟测试：插件加载、后台消息、弹窗和任务面板能正常打开
// 运行：npm run test:e2e（没有调试浏览器时自动以无头模式启动；E2E_ONLINE=1 时额外访问京东商品页）
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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

test('添加链接后自动勾选本次提交的商品', async () => {
  const { page, problems } = await openWatched(extUrl('src/dashboard/dashboard.html'));
  const skuPrefix = Date.now();
  const ids = Array.from({ length: 5 }, (_, i) => `${skuPrefix}${i}`);
  const [selected, unrelated, existing, added, b2b] = ids;
  const row = (id) => page.locator(`#rows tr[data-id="${id}"]`);
  try {
    await page.evaluate(async ({ selected, unrelated, existing }) => {
      const { itemRepo } = await import('/src/lib/chrome-env.js');
      await itemRepo.addTasks([selected, unrelated, existing]);
      await itemRepo.update(existing, { status: 'failed' });
    }, { selected, unrelated, existing });
    const filter = page.locator('#filter');
    await filter.selectOption('pending');
    await row(selected).locator('input').check();
    await page.locator('#btnAdd').click();
    const dialog = page.locator('dialog[open]');
    await dialog.locator('textarea').fill([
      `https://item.jd.com/${added}.html`,
      `https://b2b.jd.com/goods/goods-detail/${b2b}?buId=1`,
      `https://item.jd.com/${existing}.html`,
      `https://item.jd.com/${added}.html?from=test`,
    ].join('\n'));
    await dialog.getByRole('button', { name: '添加', exact: true }).click();

    for (const id of [selected, existing, added, b2b]) {
      await row(id).locator('input:checked').waitFor();
      assert.equal(await row(id).count(), 1);
    }
    assert.equal(await row(unrelated).locator('input').isChecked(), false);
    assert.equal(await filter.inputValue(), 'all');
    assert.deepEqual(problems, []);
  } finally {
    await page.evaluate(async (ids) => {
      const { itemRepo } = await import('/src/lib/chrome-env.js');
      await itemRepo.remove(ids);
    }, ids);
  }
});

test('品牌组可折叠、整组选中并随商品勾选和状态筛选更新', async () => {
  const { page, problems } = await openWatched(extUrl('src/dashboard/dashboard.html'));
  const prefix = Date.now();
  const brand = `测试品牌${prefix}`;
  const ids = Array.from({ length: 5 }, (_, i) => `${prefix}${i}`);
  const [first, second, other, unknown, pending] = ids;
  const firstBrand = `${brand}（JD）`;
  const otherBrand = `${brand}乙`;
  const groupCheck = page.getByRole('checkbox', { name: `全选品牌组 ${firstBrand}`, exact: true });
  const otherCheck = page.getByRole('checkbox', { name: `全选品牌组 ${otherBrand}`, exact: true });
  const toggle = page.getByRole('button', { name: new RegExp(`^${firstBrand}`) });
  const row = (id) => page.locator(`#itemsTable tr[data-id="${id}"]`);
  const productCheck = (id) => row(id).getByRole('checkbox');
  const checkAll = page.locator('#checkAll');

  try {
    await page.evaluate(async ({ ids, firstBrand, secondBrand, otherBrand }) => {
      const { itemRepo } = await import('/src/lib/chrome-env.js');
      await itemRepo.addTasks(ids);
      for (const [index, name] of [firstBrand, secondBrand, otherBrand, 123].entries()) {
        await itemRepo.update(ids[index], {
          status: index === 1 ? 'need_action' : 'collected',
          product: { title: `商品 ${ids[index]}`, brand: { name } },
        });
      }
    }, { ids, firstBrand, secondBrand: `${brand}(jd)`, otherBrand });
    await toggle.filter({ hasText: '2 件' }).waitFor();
    await page.getByRole('checkbox', { name: '全选品牌组 未识别品牌', exact: true }).waitFor();
    assert.equal(await row(pending).isVisible(), true);
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
    assert.equal(await row(first).isVisible(), false);
    assert.equal(await row(second).isVisible(), false);

    await groupCheck.check();
    assert.match(await toggle.textContent(), /2 件 · 已选 2 件$/);
    assert.equal(await checkAll.evaluate((node) => node.indeterminate), true);
    const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#btnExport').click()]);
    const exported = JSON.parse(await readFile(await download.path(), 'utf8'));
    assert.deepEqual(exported.items.map((item) => item.skuId), [first, second]);

    await toggle.click();
    assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
    assert.equal(await productCheck(first).isChecked(), true);
    assert.equal(await productCheck(second).isChecked(), true);
    assert.equal(await otherCheck.isChecked(), false);
    await productCheck(first).uncheck();
    assert.equal(await groupCheck.evaluate((node) => node.indeterminate), true);

    await toggle.click();
    assert.match(await toggle.textContent(), /2 件 · 已选 1 件$/);
    await toggle.click();
    assert.equal(await productCheck(first).isChecked(), false);
    assert.equal(await productCheck(second).isChecked(), true);
    await groupCheck.check();
    await groupCheck.uncheck();
    assert.equal(await productCheck(first).isChecked(), false);
    assert.equal(await productCheck(second).isChecked(), false);

    await page.locator('#collapseAllBrands').click();
    assert.equal(await row(second).isVisible(), false);
    await checkAll.check();
    assert.equal(await groupCheck.isChecked(), true);
    assert.equal(await otherCheck.isChecked(), true);
    assert.equal(await productCheck(pending).isChecked(), true);
    await checkAll.uncheck();
    await page.locator('#expandAllBrands').click();
    assert.equal(await row(other).isVisible(), true);
    assert.equal(await row(unknown).isVisible(), true);
    assert.equal(await productCheck(second).isChecked(), false);

    await page.locator('#filter').selectOption('collected');
    assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
    assert.equal(await row(second).isVisible(), false);
    await groupCheck.check();
    assert.match(await toggle.textContent(), /1 件 · 已选 1 件$/);
    await page.locator('#filter').selectOption('all');
    assert.equal(await productCheck(first).isChecked(), true);
    assert.equal(await productCheck(second).isChecked(), false);
    assert.equal(await groupCheck.evaluate((node) => node.indeterminate), true);
    assert.deepEqual(problems, []);
  } finally {
    await page.evaluate(async (ids) => {
      const { itemRepo } = await import('/src/lib/chrome-env.js');
      await itemRepo.remove(ids);
    }, ids);
  }
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
