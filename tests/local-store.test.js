import { test } from 'node:test';
import assert from 'node:assert/strict';
import { saveItemToFolder, removeItemFolder } from '../src/lib/local-store.js';
import { fakeDir } from './helpers/fake-fs.js';

const product = {
  skuId: '100012345678',
  title: '华为 Mate 60 Pro',
  brand: { name: '华为（HUAWEI）' },
  crumbs: [],
  params: [],
  mainImages: ['https://img/jfs/a.jpg', 'https://img/jfs/b.png'],
  detailImages: ['https://img/jfs/d.jpg', 'https://img/jfs/broken.jpg'],
};
const item = { id: '100012345678', skuId: '100012345678', product, edits: {} };

const fakeFetch = async (url) =>
  url.includes('broken') ? { ok: false, status: 404 } : { ok: true, blob: async () => `bytes:${url}` };

test('saveItemToFolder writes images and info into brand/sku', async () => {
  const root = fakeDir();
  const res = await saveItemToFolder(root, item, { fetchImpl: fakeFetch });
  assert.equal(res.dir, '华为（HUAWEI）/100012345678');
  assert.equal(res.saved, 3);
  assert.deepEqual(res.failed, ['详情图/02.jpg']);
  assert.deepEqual(root.tree().sort(), [
    '华为（HUAWEI）/100012345678/主图/01.jpg',
    '华为（HUAWEI）/100012345678/主图/02.png',
    '华为（HUAWEI）/100012345678/商品信息.json',
    '华为（HUAWEI）/100012345678/商品信息.txt',
    '华为（HUAWEI）/100012345678/详情图/01.jpg',
  ]);
  assert.equal(root.read('华为（HUAWEI）/100012345678/主图/02.png'), 'bytes:https://img/jfs/b.png');
});

test('saveItemToFolder reuses an existing brand folder and replaces old images', async () => {
  const root = fakeDir();
  const old = await (await root.getDirectoryHandle('华为(huawei)', { create: true })).getDirectoryHandle('100012345678', { create: true });
  await (await old.getDirectoryHandle('主图', { create: true })).getFileHandle('09.jpg', { create: true });
  await old.getFileHandle('我的备注.txt', { create: true });

  const res = await saveItemToFolder(root, item, { fetchImpl: fakeFetch });
  assert.equal(res.dir, '华为(huawei)/100012345678');
  const files = root.tree();
  assert.ok(!files.includes('华为(huawei)/100012345678/主图/09.jpg'));
  assert.ok(files.includes('华为(huawei)/100012345678/我的备注.txt'));
  assert.ok(!files.some((f) => f.startsWith('华为（HUAWEI）')));
});

test('saveItemToFolder survives network errors on single images', async () => {
  const root = fakeDir();
  const throwing = async (url) => {
    if (url.endsWith('a.jpg')) throw new TypeError('Failed to fetch');
    return fakeFetch(url);
  };
  const res = await saveItemToFolder(root, item, { fetchImpl: throwing });
  assert.deepEqual(res.failed.sort(), ['主图/01.jpg', '详情图/02.jpg']);
  assert.equal(res.saved, 2);
});

test('removeItemFolder deletes brand/sku and the brand folder once it is empty', async () => {
  const root = fakeDir();
  const other = { ...item, id: '100000000001', skuId: '100000000001', product: { ...product, skuId: '100000000001' } };
  await saveItemToFolder(root, item, { fetchImpl: fakeFetch });
  await saveItemToFolder(root, other, { fetchImpl: fakeFetch });

  const first = await removeItemFolder(root, { ...item, local: { dir: '华为（HUAWEI）/100012345678' } });
  assert.deepEqual(first, { dir: '华为（HUAWEI）/100012345678', removed: true });
  assert.ok(root.tree().every((f) => f.startsWith('华为（HUAWEI）/100000000001/')));

  const second = await removeItemFolder(root, other);
  assert.equal(second.removed, true);
  assert.deepEqual(root.tree(), []);
  assert.deepEqual(await removeItemFolder(root, other), { dir: '华为（HUAWEI）/100000000001', removed: false });
});

test('removeItemFolder finds the folder without a recorded path and refuses unsafe paths', async () => {
  const root = fakeDir();
  await saveItemToFolder(root, item, { fetchImpl: fakeFetch });
  await (await root.getDirectoryHandle('华为（HUAWEI）')).getFileHandle('品牌说明.txt', { create: true });

  const res = await removeItemFolder(root, { ...item, local: { dir: '../100012345678' } });
  assert.deepEqual(res, { dir: '华为（HUAWEI）/100012345678', removed: true });
  assert.deepEqual(root.tree(), ['华为（HUAWEI）/品牌说明.txt']);

  assert.equal(await removeItemFolder(root, { ...item, local: { dir: '华为（HUAWEI）/999' }, product: null }), null);
  assert.equal(await removeItemFolder(root, { id: '1', skuId: '1', product: null }), null);
});
