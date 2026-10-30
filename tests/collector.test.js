// 采集流程：采集窗口必须在前台（被遮挡/最小化时 Chrome 不渲染页面，京东新版商品页的详情区不会加载），
// 详情区没加载出来时切到前台再取一次，仍失败则给出明确原因
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installFakeChrome } from './helpers/fake-chrome.js';
import { collectFromTab, collectUrl } from '../src/lib/collector.js';
import { bringTabToFront } from '../src/lib/chrome-env.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/item-100035179134.raw.json', import.meta.url), 'utf8'));
const ITEM_URL = 'https://item.jd.com/100035179134.html';
const loaded = { ...fixture, detailState: 'ok' };
const notLoaded = { ...fixture, detailImages: [], detailState: 'not_loaded' };
const empty = { ...fixture, detailImages: [], detailState: 'empty' };
const parseFailed = { ...fixture, detailImages: [], detailState: 'parse_failed' };
const opts = { scrollDetail: true, retryDelayMs: 1 };

/** 页面依次返回 rawList 中的结果（最后一个重复），并记录每次调用的参数 */
function pageSequence(rawList) {
  const runs = [];
  const page = ({ args }) => {
    runs.push(args[0]);
    return rawList[Math.min(runs.length - 1, rawList.length - 1)];
  };
  return { runs, page };
}

const isExtract = (c) => c.op === 'inject.func' && c.args?.[0] && 'scrollDetail' in c.args[0];

test('bringTabToFront: 激活标签页并把所在窗口切到前台，最小化的窗口先恢复', async () => {
  const fake = installFakeChrome();
  fake.seedWindow({ id: 900, incognito: true, state: 'minimized' });
  fake.seedTab({ id: 5, url: ITEM_URL, windowId: 900, incognito: true });
  assert.equal(await bringTabToFront(5), true);
  assert.ok(fake.calls.some((c) => c.op === 'tabs.activate' && c.tabId === 5 && c.props.active === true));
  const win = fake.calls.find((c) => c.op === 'windows.update');
  assert.deepEqual(win, { op: 'windows.update', windowId: 900, props: { state: 'normal', focused: true } });
});

test('bringTabToFront: 标签页已关闭时返回 false，不抛错', async () => {
  installFakeChrome();
  assert.equal(await bringTabToFront(404), false);
});

test('collectUrl: 采集前先把采集窗口切到前台', async () => {
  const { page } = pageSequence([loaded]);
  const fake = installFakeChrome({ page });
  const res = await collectUrl(ITEM_URL, { ...opts, useIncognito: true });
  assert.equal(res.status, 'ok');
  const focusAt = fake.calls.findIndex((c) => c.op === 'windows.update' && c.props.focused === true);
  const extractAt = fake.calls.findIndex(isExtract);
  assert.ok(focusAt >= 0, '应切换采集窗口到前台');
  assert.ok(focusAt < extractAt, '必须在读取页面之前切到前台');
});

test('collectFromTab: 详情区一次就加载出来时不重试', async () => {
  const { runs, page } = pageSequence([loaded]);
  const fake = installFakeChrome({ page });
  fake.seedTab({ id: 5, url: ITEM_URL });
  const res = await collectFromTab(5, opts);
  assert.equal(res.status, 'ok');
  assert.equal(runs.length, 1);
  assert.deepEqual(res.warnings, []);
  assert.equal(res.product.detailImages.length, 13);
});

test('collectFromTab: 详情区没加载出来时切到前台再取一次', async () => {
  const { runs, page } = pageSequence([notLoaded, loaded]);
  const fake = installFakeChrome({ page });
  fake.seedTab({ id: 5, url: ITEM_URL });
  const res = await collectFromTab(5, opts);
  assert.equal(runs.length, 2);
  // 第二次不再整页滚动，只把详情区滚到视口里等待
  assert.equal(runs[1].scrollDetail, false);
  const focusAt = fake.calls.findIndex((c) => c.op === 'windows.update');
  const secondExtractAt = fake.calls.findLastIndex(isExtract);
  assert.ok(focusAt >= 0 && focusAt < secondExtractAt, '重试前应切到前台');
  assert.deepEqual(res.warnings, []);
  assert.equal(res.product.detailImages.length, 13);
});

test('collectFromTab: 重试后仍没加载出来，提示采集窗口被遮挡', async () => {
  const { runs, page } = pageSequence([notLoaded]);
  const fake = installFakeChrome({ page });
  fake.seedTab({ id: 5, url: ITEM_URL });
  const res = await collectFromTab(5, opts);
  assert.equal(runs.length, 2);
  assert.equal(res.status, 'ok');
  const warn = res.warnings.find((w) => w.includes('详情图'));
  assert.match(warn, /采集窗口/);
});

test('collectFromTab: 源商品本来没有商品介绍时不重试，并说明原因', async () => {
  const { runs, page } = pageSequence([empty]);
  const fake = installFakeChrome({ page });
  fake.seedTab({ id: 5, url: ITEM_URL });
  const res = await collectFromTab(5, opts);
  assert.equal(runs.length, 1);
  assert.match(res.warnings.find((w) => w.includes('详情图')), /没有商品介绍/);
});

test('collectFromTab: 详情已加载但没解析出图片时不重试（切前台无济于事），提示解析失败', async () => {
  const { runs, page } = pageSequence([parseFailed]);
  const fake = installFakeChrome({ page });
  fake.seedTab({ id: 5, url: ITEM_URL });
  const res = await collectFromTab(5, opts);
  assert.equal(runs.length, 1);
  assert.ok(!fake.ops().includes('windows.update'));
  assert.match(res.warnings.find((w) => w.includes('详情图')), /没解析出详情图/);
});

test('collectFromTab: 重试时页面脚本没有返回数据，保留第一次的结果', async () => {
  const { runs, page } = pageSequence([notLoaded, undefined]);
  const fake = installFakeChrome({ page });
  fake.seedTab({ id: 5, url: ITEM_URL });
  const res = await collectFromTab(5, opts);
  assert.equal(runs.length, 2);
  assert.equal(res.status, 'ok');
  assert.match(res.warnings.find((w) => w.includes('详情图')), /采集窗口/);
});

test('collectFromTab: 重试时页面变成频控页则按频控暂停', async () => {
  const { page } = pageSequence([notLoaded, { pageType: 'throttle', url: 'https://safe.jd.com/x' }]);
  const fake = installFakeChrome({ page });
  fake.seedTab({ id: 5, url: ITEM_URL });
  const res = await collectFromTab(5, opts);
  assert.equal(res.status, 'throttle');
});

const B2B_URL = 'https://b2b.jd.com/goods/goods-detail/100289450311?buId=456';
const injectedFiles = (fake) => fake.calls.find((c) => c.op === 'inject.files')?.files;

test('万商商品页注入万商模板，京东商品页仍用京东模板', async () => {
  const { page } = pageSequence([loaded]);
  const fake = installFakeChrome({ page });
  fake.seedTab({ id: 5, url: B2B_URL });
  fake.seedTab({ id: 6, url: ITEM_URL });
  await collectFromTab(5, opts);
  assert.ok(injectedFiles(fake).includes('src/inject/b2b-item-extract.js'));
  const other = installFakeChrome({ page });
  other.seedTab({ id: 6, url: ITEM_URL });
  await collectFromTab(6, opts);
  assert.ok(injectedFiles(other).includes('src/inject/jd-item-extract.js'));
});

test('万商商品不用无痕窗口：万商账号登录在普通窗口里', async () => {
  const { page } = pageSequence([loaded]);
  const fake = installFakeChrome({ page });
  const res = await collectUrl(B2B_URL, { ...opts, useIncognito: true });
  assert.equal(res.status, 'ok');
  assert.ok(!fake.calls.some((c) => c.op === 'windows.create' && c.opts?.incognito));
});

test('万商登录页：暂停并提示登录万商账号', async () => {
  const fake = installFakeChrome();
  fake.seedTab({ id: 5, url: 'https://b2b.jd.com/account/login' });
  const res = await collectFromTab(5, opts);
  assert.equal(res.status, 'login');
  assert.match(res.message, /万商/);
});

test('万商页面报告未登录 / 无权限 / 没有数据时给出明确结果', async () => {
  for (const [pageType, status, msg] of [
    ['b2b_login', 'login', /万商/],
    ['b2b_denied', 'error', /权限/],
    ['b2b_no_data', 'error', /没有返回/],
  ]) {
    const { page } = pageSequence([{ pageType }]);
    const fake = installFakeChrome({ page });
    fake.seedTab({ id: 5, url: B2B_URL });
    const res = await collectFromTab(5, opts);
    assert.equal(res.status, status);
    assert.match(res.message, msg);
  }
});

test('混合批次：京东与万商交替采集时各复用自己的标签页，不会越开越多', async () => {
  const { page } = pageSequence([loaded]);
  const fake = installFakeChrome({ page });
  for (const url of [ITEM_URL, B2B_URL, ITEM_URL, B2B_URL]) await collectUrl(url, { ...opts, useIncognito: true });
  assert.equal(fake.calls.filter((c) => c.op === 'windows.create').length, 1);
  const created = fake.calls.filter((c) => c.op === 'tabs.create');
  assert.equal(created.length, 2, '无痕和普通窗口各一个采集标签页');
});
