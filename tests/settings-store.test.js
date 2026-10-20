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
  RETURNED_NOTE,
  canRecollect,
  pickRecollect,
  collectFailurePatch,
} from '../src/shared/store.js';
import { isArchived } from '../src/shared/brand-folders.js';

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
  assert.equal(merged.publish.action, 'submit_on');
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
  assert.equal(value.publish.action, 'submit_on');
  assert.equal(value.stock, DEFAULT_SETTINGS.stock);
});

test('mergeSettings: 旧版本保存的“保存草稿”迁移为“提交并上架”（草稿里的商品没有店铺编号）', () => {
  assert.equal(mergeSettings({ publish: { action: 'draft' } }).publish.action, 'submit_on');
  // 其他动作是用户自己选的，保留
  assert.equal(mergeSettings({ publish: { action: 'none' } }).publish.action, 'none');
  assert.equal(mergeSettings({ publish: { action: 'submit_off' } }).publish.action, 'submit_off');
});

test('mergeSettings: 迁移之后再选“保存草稿”会保留', () => {
  const once = mergeSettings({ publish: { action: 'draft' } });
  const chosen = mergeSettings({ ...once, publish: { ...once.publish, action: 'draft' } });
  assert.equal(chosen.publish.action, 'draft');
  assert.equal(mergeSettings(chosen).publish.action, 'draft');
});

test('validateSettings accepts defaults', () => {
  assert.equal(validateSettings(DEFAULT_SETTINGS).ok, true);
});

test('validateSettings: price watch turns a pasted edit link into a template and clamps delays', () => {
  const { value, errors } = validateSettings(
    mergeSettings({
      priceWatch: {
        minDelaySec: 10,
        maxDelaySec: 4,
        alertMargin: -2,
        editUrlTemplate: 'https://wares-jdm.jd.com/popPublish/?wareId=10088812345&publishType=2',
        repriceAction: 'hack',
      },
    }),
  );
  assert.equal(value.priceWatch.editUrlTemplate, 'https://wares-jdm.jd.com/popPublish/?wareId={wareId}&publishType=2');
  assert.equal(value.priceWatch.maxDelaySec, 10);
  assert.equal(value.priceWatch.alertMargin, DEFAULT_SETTINGS.priceWatch.alertMargin);
  assert.equal(value.priceWatch.repriceAction, 'auto');
  assert.equal(errors.length, 3);
  const bad = validateSettings(mergeSettings({ priceWatch: { editUrlTemplate: 'https://example.com/?wareId=10088812345' } }));
  assert.equal(bad.value.priceWatch.editUrlTemplate, '');
  assert.match(bad.errors.join(), /商品编辑页地址无效/);
});

test('validateSettings: 默认 UPC 默认 6914973039001，可清空关闭，无效时恢复默认', () => {
  assert.equal(DEFAULT_SETTINGS.publish.defaultUpc, '6914973039001');
  const set = (defaultUpc) => validateSettings({ publish: { defaultUpc } });
  assert.equal(set(' ６９０１２３４５６７８９２ ').value.publish.defaultUpc, '6901234567892');
  assert.equal(set('').value.publish.defaultUpc, '');
  assert.ok(set('').ok);
  const bad = set('12ab');
  assert.equal(bad.value.publish.defaultUpc, '6914973039001');
  assert.ok(bad.errors.some((e) => e.includes('默认 UPC')));
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
  assert.equal(s.publish.action, 'submit_on');
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
    shopWareId: '',
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

test('publishResultPatch records the shop price and product id of a successful publish', () => {
  const item = { ...newItem('100001', 1), shopWareId: '10000000001', salePrice: 9 };
  const patch = publishResultPatch(item, { status: 'published', message: '完成', price: 59.9, wareId: '10088812345' }, 50);
  assert.equal(patch.salePrice, 59.9);
  assert.equal(patch.shopWareId, '10088812345');
  // 重新发布会在店铺里生成新商品：没拿到新编号时清掉旧编号，避免改价改到旧商品上
  const unknown = publishResultPatch(item, { status: 'published', message: '完成', price: 59.9 }, 50);
  assert.equal(unknown.shopWareId, '');
  const failed = publishResultPatch(item, { status: 'failed', message: 'x', price: 59.9, wareId: '10088812345' }, 50);
  assert.equal('salePrice' in failed, false);
  assert.equal('shopWareId' in failed, false);
});

test('editsEqual ignores key order, undefined values and empty overrides', () => {
  assert.equal(editsEqual({}, { title: undefined, attrOverrides: {} }), true);
  assert.equal(editsEqual({ price: 5, title: 'a' }, { title: 'a', price: 5, stock: undefined }), true);
  assert.equal(editsEqual({ price: 5 }, { price: 6 }), false);
  assert.equal(editsEqual(undefined, { attrOverrides: { 产地: '中国' } }), false);
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

/** 一个发布成功过的商品：带编辑、店铺售价/编号、价格检查记录 */
async function publishedRepo() {
  const storage = memoryStorage();
  const repo = createItemRepository(storage);
  await repo.saveCollected({ skuId: '100001', title: 'a', variants: [{ skuId: '100009' }] });
  await repo.saveEdits('100001', { price: 30 });
  await repo.update('100001', {
    status: 'published',
    message: '保存成功',
    publishedAt: 1000,
    salePrice: 30,
    shopWareId: '10088812345',
    priceCheck: { price: 35, checkedAt: 2000 },
    reprice: { status: 'ok' },
    target: { name: '巧克力', cateList: [1, 2, 3] },
  });
  return { storage, repo };
}

test('returnToTasks: 已发布商品退回任务列表的“已采集”，保留商品数据和编辑，清掉店铺记录', async () => {
  const { repo } = await publishedRepo();
  const res = await repo.returnToTasks(['100001']);
  assert.deepEqual(res, { returned: ['100001'], skipped: [] });
  const item = await repo.findById('100001');
  assert.equal(item.status, 'collected');
  assert.equal(item.message, RETURNED_NOTE);
  assert.equal(isArchived(item), false, '应回到任务列表');
  for (const key of ['publishedAt', 'salePrice', 'shopWareId', 'priceCheck', 'reprice']) assert.ok(!(key in item), `应清掉 ${key}`);
  assert.equal(item.product.title, 'a');
  assert.deepEqual(item.edits, { price: 30 });
  assert.equal(item.target.name, '巧克力');
});

test('returnToTasks: 只处理已发布的商品，任务列表里的和不存在的跳过', async () => {
  const { repo } = await publishedRepo();
  await repo.saveCollected({ skuId: '100002', title: 'b' });
  const before = await repo.findById('100002');
  const res = await repo.returnToTasks(['100002', 'nope']);
  assert.deepEqual(res, { returned: [], skipped: ['100002', 'nope'] });
  assert.deepEqual(await repo.findById('100002'), before);
});

test('returnToTasks: 退回后仍记得发布过，删除任务再添加同一商品时照样跳过', async () => {
  const { storage, repo } = await publishedRepo();
  await repo.returnToTasks(['100001']);
  assert.ok('100001' in storage.dump().publishedSkus);
  assert.ok('100009' in storage.dump().publishedSkus, '一起发布的规格 SKU 也记下');
  const inList = await repo.addTasks(['100001']);
  assert.deepEqual(inList.added, [], '不会重复加入');
  assert.equal((await repo.findAll()).length, 1);
  await repo.remove(['100001']);
  const again = await repo.addTasks(['100001']);
  assert.deepEqual(again.published, ['100001']);
});

test('canRecollect: 任务列表里已采集过的商品可以重新采集，已发布的和采集中的不行', () => {
  const base = { ...newItem('1'), product: { title: 'a' } };
  assert.equal(canRecollect({ ...base, status: 'collected' }), true);
  assert.equal(canRecollect({ ...base, status: 'need_action' }), true);
  assert.equal(canRecollect({ ...base, status: 'failed' }), true);
  assert.equal(canRecollect({ ...base, status: 'collecting' }), false);
  assert.equal(canRecollect({ ...base, status: 'publishing' }), false);
  assert.equal(canRecollect({ ...base, status: 'published', publishedAt: 1 }), false);
  assert.equal(canRecollect(newItem('2')), false, '没采集过的用“采集”');
});

test('pickRecollect: 只取勾选里可以重新采集的商品，其余计入跳过', () => {
  const collected = (id, extra = {}) => ({ ...newItem(id), status: 'collected', product: { title: id }, ...extra });
  const items = [
    collected('1'),
    collected('2', { status: 'need_action' }),
    collected('3', { status: 'published', publishedAt: 1 }),
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
