import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS, mergeSettings, validateSettings, parseAttrDefaults } from '../src/shared/settings.js';
import {
  createItemRepository,
  createSettingsRepository,
  newItem,
  publishResultPatch,
  publishedSkuSet,
  planNewSkus,
  EDITED_NOTE,
} from '../src/shared/store.js';

function memoryStorage(initial = {}) {
  let data = structuredClone(initial);
  return {
    async get(key) {
      return structuredClone(data[key]);
    },
    async set(key, value) {
      data = { ...data, [key]: structuredClone(value) };
    },
    dump: () => data,
  };
}

test('mergeSettings fills defaults without mutating input', () => {
  const saved = { price: { multiplier: 1.2 } };
  const merged = mergeSettings(saved);
  assert.equal(merged.price.multiplier, 1.2);
  assert.equal(merged.price.rounding, DEFAULT_SETTINGS.price.rounding);
  assert.equal(merged.publish.action, 'draft');
  assert.deepEqual(saved, { price: { multiplier: 1.2 } });
});

test('validateSettings clamps and reports errors', () => {
  const { ok, errors, value } = validateSettings(
    mergeSettings({
      collect: { minDelaySec: 30, maxDelaySec: 5 },
      price: { multiplier: -1 },
      publish: { action: 'hack' },
      stock: 'abc',
    }),
  );
  assert.equal(ok, false);
  assert.ok(errors.length >= 3);
  assert.equal(value.collect.maxDelaySec >= value.collect.minDelaySec, true);
  assert.equal(value.price.multiplier, 1);
  assert.equal(value.publish.action, 'draft');
  assert.equal(value.stock, DEFAULT_SETTINGS.stock);
});

test('validateSettings accepts defaults', () => {
  assert.equal(validateSettings(DEFAULT_SETTINGS).ok, true);
});

test('parseAttrDefaults parses key=value lines', () => {
  assert.deepEqual(parseAttrDefaults('销售单位=盒\n 保质期 ＝ 365 \n# 注释\n无效行\n=空键'), {
    销售单位: '盒',
    保质期: '365',
  });
  assert.deepEqual(parseAttrDefaults(undefined), {});
});

test('item repository upserts by skuId and updates immutably', async () => {
  const storage = memoryStorage();
  const repo = createItemRepository(storage);
  const added = await repo.addSkus(['111', '222', '111']);
  assert.equal(added.length, 2);
  const again = await repo.addSkus(['222', '333']);
  assert.equal(again.length, 1);
  const all = await repo.findAll();
  assert.deepEqual(all.map((i) => i.skuId), ['111', '222', '333']);

  const before = await repo.findById('111');
  const updated = await repo.update('111', { status: 'collected', product: { title: 't' } });
  assert.equal(updated.status, 'collected');
  assert.equal(before.status, 'pending');
  assert.ok(updated.updatedAt >= before.updatedAt);

  assert.equal(await repo.update('nope', { status: 'x' }), null);
  await repo.remove(['222']);
  assert.deepEqual((await repo.findAll()).map((i) => i.skuId), ['111', '333']);
});

test('item repository saves collected product directly', async () => {
  const repo = createItemRepository(memoryStorage());
  const item = await repo.saveCollected({ skuId: '9', title: 'x' });
  assert.equal(item.status, 'collected');
  const second = await repo.saveCollected({ skuId: '9', title: 'y' });
  assert.equal(second.product.title, 'y');
  assert.equal((await repo.findAll()).length, 1);
});

test('item repository imports collected items and validates input', async () => {
  const repo = createItemRepository(memoryStorage());
  await repo.addSkus(['100001']);
  const res = await repo.importItems([
    { skuId: '100001', product: { skuId: '100001', title: 'a' }, status: 'collected' },
    { skuId: '100002', product: { skuId: '100002', title: 'b' }, status: 'published' },
    { skuId: 'bad' },
    null,
  ]);
  assert.deepEqual(res, { imported: 2, skipped: 2 });
  const all = await repo.findAll();
  assert.deepEqual(all.map((i) => [i.id, i.status, i.product.title]), [
    ['100001', 'collected', 'a'],
    ['100002', 'collected', 'b'],
  ]);
});

test('settings default to incognito collection', () => {
  assert.equal(DEFAULT_SETTINGS.collect.useIncognito, true);
  assert.equal(validateSettings(mergeSettings({ collect: { useIncognito: false } })).value.collect.useIncognito, false);
});

test('newItem creates a pending item', () => {
  const item = newItem('123');
  assert.equal(item.id, '123');
  assert.equal(item.status, 'pending');
  assert.equal(item.url, 'https://item.jd.com/123.html');
});

test('settings repository merges with defaults', async () => {
  const storage = memoryStorage({ settings: { stock: 7 } });
  const repo = createSettingsRepository(storage);
  const s = await repo.get();
  assert.equal(s.stock, 7);
  assert.equal(s.publish.action, 'draft');
  const saved = await repo.save({ ...s, stock: 9 });
  assert.equal(saved.stock, 9);
  assert.equal(storage.dump().settings.stock, 9);
});

test('saveEdits keeps need_action status so the item stays in the 需处理 list', async () => {
  const repo = createItemRepository(memoryStorage());
  await repo.saveCollected({ skuId: '100001', title: 'a' });
  await repo.update('100001', { status: 'need_action', message: '必填属性未匹配：产地' });
  const saved = await repo.saveEdits('100001', { attrOverrides: { 产地: '中国大陆' } });
  assert.equal(saved.status, 'need_action');
  assert.deepEqual(saved.edits, { attrOverrides: { 产地: '中国大陆' } });
  assert.equal(saved.message, `${EDITED_NOTE}｜上次结果：必填属性未匹配：产地`);
});

test('saveEdits uses the stored status, not a stale snapshot', async () => {
  const repo = createItemRepository(memoryStorage());
  await repo.saveCollected({ skuId: '100001', title: 'a' });
  await repo.update('100001', { status: 'published', message: '完成' });
  await repo.update('100001', { status: 'failed', message: '提交未成功' });
  const saved = await repo.saveEdits('100001', { title: 'x' });
  assert.equal(saved.status, 'failed');
  assert.match(saved.message, /^已修改，尚未重新发布/);
});

test('saveEdits never flips status and does not stack the edited note', async () => {
  const repo = createItemRepository(memoryStorage());
  await repo.saveCollected({ skuId: '100001', title: 'a' });
  await repo.update('100001', { status: 'published', message: '完成' });
  await repo.saveEdits('100001', { title: 'x' });
  const again = await repo.saveEdits('100001', { title: 'y' });
  assert.equal(again.status, 'published');
  assert.equal(again.message, `${EDITED_NOTE}｜上次结果：完成`);

  await repo.saveCollected({ skuId: '100002', title: 'b' });
  const fresh = await repo.saveEdits('100002', { price: 9 });
  assert.equal(fresh.status, 'collected');
  assert.equal(fresh.message, '');

  await repo.addSkus(['100003']);
  await repo.update('100003', { status: 'failed', message: '采集失败' });
  const uncollected = await repo.saveEdits('100003', { price: 9 });
  assert.equal(uncollected.status, 'failed');
  assert.equal(uncollected.message, '采集失败');

  assert.equal(await repo.saveEdits('nope', {}), null);
});

test('publishResultPatch stamps publishedAt only on a successful publish', () => {
  const item = { ...newItem('100001', 1), target: { id: 't0' } };
  assert.deepEqual(publishResultPatch(item, { status: 'published', message: '完成', target: { id: 't1' } }, 50), {
    status: 'published',
    message: '完成',
    target: { id: 't1' },
    publishedAt: 50,
  });
  assert.deepEqual(publishResultPatch(item, { status: 'filled', message: '已填写完成' }, 50), {
    status: 'need_action',
    message: '已填写完成',
    target: { id: 't0' },
  });
  // 已发布过的商品重新发布失败：保留上次发布成功的时间，继续留在已发布页
  const archived = { ...item, publishedAt: 7 };
  const failed = publishResultPatch(archived, { status: 'failed', message: '提交未成功' }, 50);
  assert.equal(failed.status, 'failed');
  assert.equal('publishedAt' in failed, false);
});

test('addSkus does not bring a published item back to the task list', async () => {
  const repo = createItemRepository(memoryStorage());
  await repo.saveCollected({ skuId: '100001', title: 'a' });
  await repo.update('100001', { status: 'published', publishedAt: 5 });
  assert.deepEqual((await repo.addSkus(['100001', '100002'])).map((i) => i.id), ['100002']);
  assert.equal((await repo.findById('100001')).status, 'published');
});

test('addTasks skips published SKUs and reports what was skipped', async () => {
  const repo = createItemRepository(memoryStorage());
  await repo.saveCollected({ skuId: '100001', title: 'A' });
  await repo.update('100001', { status: 'published', publishedAt: 5 });
  await repo.addSkus(['100004']);
  const res = await repo.addTasks(['100001', '100002', '100003', '100004', '100002']);
  assert.deepEqual(res.added.map((i) => i.id), ['100002', '100003']);
  assert.deepEqual(res.published, ['100001']);
  assert.deepEqual(res.existing, ['100004']);
});

test('deleted published items are remembered and still skipped when re-added', async () => {
  const storage = memoryStorage();
  const repo = createItemRepository(storage);
  await repo.saveCollected({ skuId: '100001', title: 'A', variants: [{ skuId: '100001' }, { skuId: '100009' }] });
  await repo.update('100001', { status: 'published', publishedAt: 5 });
  await repo.addSkus(['100002']);
  await repo.remove(['100001', '100002']);
  assert.deepEqual(await repo.findAll(), []);
  assert.deepEqual(Object.keys(storage.dump().publishedSkus).sort(), ['100001', '100009']);

  const res = await repo.addTasks(['100001', '100009', '100002', '100003']);
  assert.deepEqual(res.added.map((i) => i.id), ['100002', '100003']);
  assert.deepEqual(res.published, ['100001', '100009']);
});

test('addTasks re-adds deleted published SKUs when includePublished is set', async () => {
  const repo = createItemRepository(memoryStorage({ publishedSkus: { 100001: 1 } }));
  const res = await repo.addTasks(['100001'], { includePublished: true });
  assert.deepEqual(res.added.map((i) => i.id), ['100001']);
  assert.deepEqual(res.published, []);
  assert.equal(res.added[0].status, 'pending');
});

test('removing unpublished items does not mark them as published', async () => {
  const storage = memoryStorage();
  const repo = createItemRepository(storage);
  await repo.saveCollected({ skuId: '100001', title: 'A' });
  await repo.update('100001', { status: 'need_action' });
  await repo.remove(['100001']);
  assert.equal(storage.dump().publishedSkus, undefined);
  assert.deepEqual((await repo.addSkus(['100001'])).map((i) => i.id), ['100001']);
});

test('publishedSkuSet merges registry with archived items and their variants', () => {
  const items = [
    { id: '1', status: 'published', product: { variants: [{ skuId: '2' }] } },
    { id: '3', status: 'failed', publishedAt: 9, product: null },
    { id: '4', status: 'collected', product: { variants: [{ skuId: '5' }] } },
  ];
  assert.deepEqual([...publishedSkuSet(items, { 7: 1 })].sort(), ['1', '2', '3', '7']);
});

test('planNewSkus keeps archived items in the archive even when includePublished is set', () => {
  const items = [{ id: '1', status: 'published' }];
  const plan = planNewSkus(['1', '2'], items, new Set(['1']), { includePublished: true });
  assert.deepEqual(plan, { fresh: ['2'], published: [], existing: ['1'] });
});

test('saveCollected writes to the task SKU even if the page reports another SKU', async () => {
  const repo = createItemRepository(memoryStorage());
  await repo.addSkus(['100001']);
  await repo.saveCollected({ skuId: '100099', title: 'A' }, '100001');
  const all = await repo.findAll();
  assert.deepEqual(all.map((i) => [i.id, i.status]), [['100001', 'collected']]);
  await repo.update('100001', { status: 'published', publishedAt: 1 });
  assert.deepEqual([...publishedSkuSet(await repo.findAll())].sort(), ['100001', '100099']);
});
