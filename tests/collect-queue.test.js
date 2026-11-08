// 批量采集：采集成功后把页面原始数据交给本地保存（写进“原始数据.json”，排查采集问题用）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installFakeChrome } from './helpers/fake-chrome.js';
import { createQueueRunner } from '../src/lib/queue.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/item-100035179134.raw.json', import.meta.url), 'utf8'));
const SKU = '100035179134';

test('采集队列：采集成功后保存到本地时带上原始数据', async () => {
  const fake = installFakeChrome({ page: () => ({ ...fixture, detailState: 'ok' }) });
  const task = { id: SKU, skuId: SKU, url: `https://item.jd.com/${SKU}.html`, status: 'pending', message: '', log: [], edits: {}, product: null, createdAt: 1, updatedAt: 1 };
  Object.assign(fake.localStore, { items: [task], settings: { collect: { useIncognito: false, minDelaySec: 0, maxDelaySec: 0 } } });
  const saved = [];
  const saveLocal = async (item, opts) => {
    saved.push({ item, opts });
    return { dir: `德芙/${SKU}`, saved: 0, failed: [] };
  };
  const runner = createQueueRunner({ onChange: () => {}, onLog: () => {}, saveLocal });
  await runner.collect([SKU]);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].item.skuId, SKU);
  assert.equal(saved[0].opts.raw.skuId, SKU);
  assert.equal(saved[0].opts.raw.pageType, 'item');
});
