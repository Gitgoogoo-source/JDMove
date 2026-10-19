import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS, mergeSettings, validateSettings, parseAttrDefaults } from '../src/shared/settings.js';
import { createItemRepository, createSettingsRepository, newItem, EDITED_NOTE } from '../src/shared/store.js';

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
