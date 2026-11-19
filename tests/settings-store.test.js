import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS, mergeSettings, validateSettings, parseAttrDefaults } from '../src/shared/settings.js';
import {
  createItemRepository,
  createSettingsRepository,
  newItem,
  publishResultPatch,
  editsEqual,
  publishedSkuSet,
  planNewSkus,
  EDITED_NOTE,
  canRecollect,
  pickRecollect,
  collectFailurePatch,
  INTERRUPTED_NOTE,
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
  const saved = { title: { prefix: '新品' } };
  const merged = mergeSettings(saved);
  assert.equal(merged.title.prefix, '新品');
  assert.equal(merged.title.maxLength, DEFAULT_SETTINGS.title.maxLength);
  assert.equal(merged.publish.action, 'publish');
  assert.deepEqual(saved, { title: { prefix: '新品' } });
});

test('validateSettings clamps and reports errors', () => {
  const { ok, errors, value } = validateSettings(
    mergeSettings({
      collect: { minDelaySec: 30, maxDelaySec: 5 },
      title: { maxLength: 'abc' },
      publish: { delaySec: -3 },
    }),
  );
  assert.equal(ok, false);
  assert.ok(errors.length >= 3);
  assert.equal(value.collect.maxDelaySec >= value.collect.minDelaySec, true);
  assert.equal(value.title.maxLength, DEFAULT_SETTINGS.title.maxLength);
  assert.equal(value.publish.delaySec, DEFAULT_SETTINGS.publish.delaySec);
});

test('mergeSettings: 发布动作只有“发布商品”和“只填写”；旧版本的“保存草稿/提交并上架”等读取时改为发布商品', () => {
  for (const action of ['submit_on', 'submit_off', 'draft', 'hack', undefined]) {
    assert.equal(mergeSettings({ publish: { action } }).publish.action, 'publish', String(action));
  }
  assert.equal(mergeSettings({ publish: { action: 'none' } }).publish.action, 'none');
  assert.equal(validateSettings({ publish: { action: 'submit_on' } }).ok, true, '旧设置不报错');
});

test('mergeSettings: 旧版本的 POP 设置（售价倍率、库存、发布平台、默认 UPC、改价）读取时丢掉', () => {
  const merged = mergeSettings({
    price: { multiplier: 1.2 },
    stock: 7,
    publish: { platform: 'pop', defaultUpc: '6914973039001', actionVersion: 2 },
    priceWatch: { editUrlTemplate: 'https://wares-jdm.jd.com/x?wareId={wareId}', repriceAction: 'auto', alertMargin: 2 },
  });
  assert.equal('price' in merged || 'stock' in merged, false);
  assert.deepEqual(['platform', 'defaultUpc', 'actionVersion'].filter((k) => k in merged.publish), []);
  assert.equal('priceWatch' in merged, false);
});

test('validateSettings accepts defaults', () => {
  assert.equal(validateSettings(DEFAULT_SETTINGS).ok, true);
});

test('mergeSettings: 旧版本“检查京东今日价”的设置读取时丢掉', () => {
  assert.equal('priceWatch' in mergeSettings({ priceWatch: { minDelaySec: 10 } }), false);
  assert.equal('priceWatch' in validateSettings({ priceWatch: { minDelaySec: 10 } }).value, false);
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
  const storage = memoryStorage({ settings: { publish: { delaySec: 7 } } });
  const repo = createSettingsRepository(storage);
  const s = await repo.get();
  assert.equal(s.publish.delaySec, 7);
  assert.equal(s.publish.action, 'publish');
  const saved = await repo.save({ ...s, publish: { ...s.publish, delaySec: 9 } });
  assert.equal(saved.publish.delaySec, 9);
  assert.equal(storage.dump().settings.publish.delaySec, 9);
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
  await repo.update('100001', { status: 'need_action', message: '停在发布页' });
  await repo.saveEdits('100001', { title: 'x' });
  const again = await repo.saveEdits('100001', { title: 'y' });
  assert.equal(again.status, 'need_action');
  assert.equal(again.message, `${EDITED_NOTE}｜上次结果：停在发布页`);

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

test('publishResultPatch: 没发布成功时的状态——停在发布页记作需处理，失败照记，不带任何店铺字段', () => {
  const item = { ...newItem('100001', 1), target: { id: 't0' } };
  assert.deepEqual(publishResultPatch(item, { status: 'filled', message: '已填写完成' }), { status: 'need_action', message: '已填写完成', target: { id: 't0' } });
  assert.deepEqual(publishResultPatch(item, { status: 'failed', message: '提交未成功', target: { id: 't1' } }), { status: 'failed', message: '提交未成功', target: { id: 't1' } });
});

test('editsEqual ignores key order, undefined values and empty overrides', () => {
  assert.equal(editsEqual({}, { title: undefined, attrOverrides: {} }), true);
  assert.equal(editsEqual({ price: 5, title: 'a' }, { title: 'a', price: 5, stock: undefined }), true);
  assert.equal(editsEqual({ price: 5 }, { price: 6 }), false);
  assert.equal(editsEqual(undefined, { attrOverrides: { 产地: '中国' } }), false);
});

test('finishPublished：发布成功的商品移出任务列表，SKU 和一起发布的规格 SKU 记下，重新添加时跳过', async () => {
  const storage = memoryStorage();
  const repo = createItemRepository(storage);
  await repo.saveCollected({ skuId: '100001', title: 'A', variants: [{ skuId: '100001' }, { skuId: '100009' }] });
  await repo.addSkus(['100002']);
  const done = await repo.finishPublished('100001');
  assert.equal(done.id, '100001');
  assert.deepEqual((await repo.findAll()).map((i) => i.id), ['100002']);
  assert.deepEqual(Object.keys(storage.dump().publishedSkus).sort(), ['100001', '100009']);
  assert.deepEqual([...(await repo.publishedSkus())].sort(), ['100001', '100009']);
  const res = await repo.addTasks(['100001', '100009', '100002', '100003']);
  assert.deepEqual(res.added.map((i) => i.id), ['100003']);
  assert.deepEqual(res.published, ['100001', '100009']);
  assert.deepEqual(res.existing, ['100002']);
  assert.equal(await repo.finishPublished('nope'), null);
});

test('dropLegacyPublished：删掉旧版本“已发布”页里的条目（状态已发布或有发布时间），其他不动', async () => {
  const storage = memoryStorage();
  const repo = createItemRepository(storage);
  await repo.addSkus(['100001', '100002', '100003']);
  await repo.update('100001', { status: 'published', publishedAt: 5 });
  await repo.update('100002', { status: 'failed', publishedAt: 9 });
  assert.deepEqual((await repo.dropLegacyPublished()).sort(), ['100001', '100002']);
  assert.deepEqual((await repo.findAll()).map((i) => i.id), ['100003']);
  assert.deepEqual(await repo.dropLegacyPublished(), []);
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

test('publishedSkuSet：已发布记录表里的 SKU', () => {
  assert.deepEqual([...publishedSkuSet({ 7: 1, 8: 2 })].sort(), ['7', '8']);
  assert.deepEqual([...publishedSkuSet(undefined)], []);
});

test('planNewSkus: includePublished 时已发布过的也重新加入', () => {
  const plan = planNewSkus(['1', '2', '3'], [{ id: '3' }], new Set(['1']), { includePublished: true });
  assert.deepEqual(plan, { fresh: ['1', '2'], published: [], existing: ['3'] });
  assert.deepEqual(planNewSkus(['1', '2'], [], new Set(['1'])), { fresh: ['2'], published: ['1'], existing: [] });
});

test('saveCollected writes to the task SKU even if the page reports another SKU', async () => {
  const repo = createItemRepository(memoryStorage());
  await repo.addSkus(['100001']);
  await repo.saveCollected({ skuId: '100099', title: 'A' }, '100001');
  const all = await repo.findAll();
  assert.deepEqual(all.map((i) => [i.id, i.status]), [['100001', 'collected']]);
  await repo.finishPublished('100001');
  assert.deepEqual([...(await repo.publishedSkus())].sort(), ['100001', '100099']);
});

test('canRecollect: 任务列表里已采集过的商品可以重新采集，采集中/发布中的不行', () => {
  const base = { ...newItem('1'), product: { title: 'a' } };
  assert.equal(canRecollect({ ...base, status: 'collected' }), true);
  assert.equal(canRecollect({ ...base, status: 'need_action' }), true);
  assert.equal(canRecollect({ ...base, status: 'failed' }), true);
  assert.equal(canRecollect({ ...base, status: 'collecting' }), false);
  assert.equal(canRecollect({ ...base, status: 'publishing' }), false);
  assert.equal(canRecollect(newItem('2')), false, '没采集过的用“采集”');
});

test('pickRecollect: 只取勾选里可以重新采集的商品，其余计入跳过', () => {
  const collected = (id, extra = {}) => ({ ...newItem(id), status: 'collected', product: { title: id }, ...extra });
  const items = [
    collected('1'),
    collected('2', { status: 'need_action' }),
    collected('3', { status: 'publishing' }),
    newItem('4'),
    collected('5'),
  ];
  assert.deepEqual(pickRecollect(items, new Set(['1', '2', '3', '4'])), { ids: ['1', '2'], skipped: 2 });
  assert.deepEqual(pickRecollect(items, new Set()), { ids: [], skipped: 0 }, '没勾选时不默认全部重新采集');
});

test('collectFailurePatch: 首次采集失败/暂停时标为失败/待采集', () => {
  const fresh = newItem('1');
  assert.deepEqual(collectFailurePatch(fresh, { status: 'error', message: '页面打不开' }), { status: 'failed', message: '页面打不开' });
  assert.deepEqual(collectFailurePatch(fresh, { status: 'throttle', message: '频控' }), { status: 'pending', message: '频控' });
});

test('collectFailurePatch: 重新采集失败/暂停时保留原状态和上次的数据', () => {
  const item = { ...newItem('1'), status: 'need_action', product: { title: 'a' } };
  for (const status of ['error', 'throttle']) {
    const patch = collectFailurePatch(item, { status, message: '页面打不开' });
    assert.equal(patch.status, 'need_action');
    assert.match(patch.message, /^重新采集失败：页面打不开/);
    assert.match(patch.message, /保留上次采集的数据/);
    assert.ok(!('product' in patch));
  }
  assert.equal(collectFailurePatch({ ...item, status: 'collecting' }, { status: 'error', message: 'x' }).status, 'collected');
});

const B2B_URL = 'https://b2b.jd.com/goods/goods-detail/100289450311?buId=456';

test('addTasks: 万商链接按原链接采集，普通 SKU 仍是 item.jd.com', async () => {
  const repo = createItemRepository(memoryStorage());
  const { added } = await repo.addTasks(['100289450311', '100012043978'], { urls: { 100289450311: B2B_URL } });
  assert.equal(added[0].url, B2B_URL);
  assert.equal(added[1].url, 'https://item.jd.com/100012043978.html');
});

test('addTasks: 已在列表里的商品再贴万商链接时改用万商链接', async () => {
  const repo = createItemRepository(memoryStorage());
  await repo.addSkus(['100289450311']);
  const res = await repo.addTasks(['100289450311'], { urls: { 100289450311: B2B_URL } });
  assert.deepEqual(res.existing, ['100289450311']);
  assert.equal((await repo.findById('100289450311')).url, B2B_URL);
});

test('saveCollected / importItems: 在万商页采集的商品，以后也回万商页', async () => {
  const repo = createItemRepository(memoryStorage());
  const saved = await repo.saveCollected({ skuId: '100289450311', url: B2B_URL, title: 'x' });
  assert.equal(saved.url, B2B_URL);
  await repo.importItems([{ skuId: '10159832951369', product: { url: 'https://b2b.jd.com/goods/goods-detail/10159832951369' } }]);
  assert.equal((await repo.findById('10159832951369')).url, 'https://b2b.jd.com/goods/goods-detail/10159832951369');
});

test('saveCollected: 普通京东商品的任务链接不变', async () => {
  const repo = createItemRepository(memoryStorage());
  const saved = await repo.saveCollected({ skuId: '100012043978', url: 'https://item.jd.com/100012043978.html?x=1', title: 'x' });
  assert.equal(saved.url, 'https://item.jd.com/100012043978.html');
});

test('saveCollected: 万商任务改从京东商品页采集时，任务链接跟着回到京东', async () => {
  const repo = createItemRepository(memoryStorage());
  await repo.addTasks(['100289450311'], { urls: { 100289450311: B2B_URL } });
  const saved = await repo.saveCollected({ skuId: '100289450311', url: 'https://item.jd.com/100289450311.html', title: 'x' });
  assert.equal(saved.url, 'https://item.jd.com/100289450311.html');
});

test('recoverInterrupted：停在“采集中”的条目改回已采集/待采集，其他不动', async () => {
  const items = [
    { ...newItem('1001', 1), status: 'collecting', product: { title: 'a' } },
    { ...newItem('1002', 1), status: 'collecting' },
    { ...newItem('1003', 1), status: 'publishing', product: { title: 'c' } },
  ];
  const storage = memoryStorage({ items });
  const repo = createItemRepository(storage);
  assert.deepEqual(await repo.recoverInterrupted(), ['1001', '1002']);
  const after = storage.dump().items;
  assert.deepEqual(after.map((i) => i.status), ['collected', 'pending', 'publishing']);
  assert.equal(after[0].message, INTERRUPTED_NOTE);
  assert.deepEqual(await repo.recoverInterrupted(), []);
});
