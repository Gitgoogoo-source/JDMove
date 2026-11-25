import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findCollectedItems, readLocalPublishImages, saveItemToFolder, removeItemFolder } from '../src/lib/local-store.js';
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

test('findCollectedItems reads only requested source SKUs and ignores corrupt archives', async () => {
  const root = fakeDir();
  const archived = { ...item, product: { ...product, skuId: '100000000002' }, edits: { vc: { marketPrice: 30 } } };
  const saved = await saveItemToFolder(root, archived, { fetchImpl: fakeFetch });
  const corrupt = await (await root.getDirectoryHandle('另一个品牌', { create: true })).getDirectoryHandle('100000000003', { create: true });
  const info = await corrupt.getFileHandle('商品信息.json', { create: true });
  await (await info.createWritable()).write('broken json');

  const result = await findCollectedItems(root, ['100000000002', '100000000003', '100000000004', archived.skuId]);
  assert.deepEqual(result.items.map(({ skuId, product, edits, local }) => ({ skuId, product, edits, dir: local.dir })), [
    { skuId: archived.skuId, product: archived.product, edits: archived.edits, dir: saved.dir },
  ]);
  assert.deepEqual(result.unreadable, ['100000000003']);
  assert.deepEqual(await findCollectedItems(root, ['100000000004']), { items: [], unreadable: [] });
});

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

test('saveItemToFolder: 采集时写入原始数据；之后“保存到本地”没有原始数据时保留原来的文件', async () => {
  const root = fakeDir();
  const raw = { pageType: 'item', skuId: '100012345678' };
  await saveItemToFolder(root, item, { fetchImpl: fakeFetch, raw });
  const path = '华为（HUAWEI）/100012345678/原始数据.json';
  const rawIn = async () => JSON.parse(await root.read(path).text()).raw;
  assert.deepEqual(await rawIn(), raw);
  await saveItemToFolder(root, item, { fetchImpl: fakeFetch });
  assert.ok(root.tree().includes(path));
  assert.deepEqual(await rawIn(), raw);
});

test('发布主图按实际文件和自然顺序读取，保留同目录的透明 PNG，且重读磁盘修改', async () => {
  const root = fakeDir();
  const brand = await root.getDirectoryHandle('华为（HUAWEI）', { create: true });
  const sku = await brand.getDirectoryHandle(item.skuId, { create: true });
  const main = await sku.getDirectoryHandle('主图', { create: true });
  const detail = await sku.getDirectoryHandle('详情图', { create: true });
  const put = async (dir, name, value) => (await (await dir.getFileHandle(name, { create: true })).createWritable()).write(value);
  await put(main, '10.jpg', 'ten');
  await put(main, '2.JPG', 'two');
  await put(main, '06.png', 'transparent');
  await put(main, '01.jpg', 'edited front');
  await put(main, '.hidden.jpg', '');
  await put(main, '备注.txt', '');
  await put(detail, '03.jpg', 'detail');
  const opts = { isTransparent: async (file) => file.name === '06.png' };
  const read = () => readLocalPublishImages(root, { ...item, edits: { brandName: '发布时改了品牌' }, local: { dir: `旧目录/${item.skuId}` } }, opts);
  const local = await read();
  assert.equal(local.dir, `华为（HUAWEI）/${item.skuId}/主图`);
  assert.deepEqual(local.main.map((file) => file.name), ['01.jpg', '2.JPG', '10.jpg']);
  assert.equal(await local.main[0].text(), 'edited front');
  assert.equal(await local.transparent.text(), 'transparent');
  await put(main, '01.jpg', 'edited again');
  const latest = await read();
  assert.equal(await latest.main[0].text(), 'edited again');
  assert.equal(await readLocalPublishImages(root, { ...item, skuId: '1234' }), null);
});

test('普通 06.png 仍作主图，空主图目录不回到采集链接', async () => {
  const root = fakeDir();
  const brand = await root.getDirectoryHandle('华为（HUAWEI）', { create: true });
  const sku = await brand.getDirectoryHandle(item.skuId, { create: true });
  const main = await sku.getDirectoryHandle('主图', { create: true });
  assert.deepEqual((await readLocalPublishImages(root, item)).main, []);
  const file = await main.getFileHandle('06.png', { create: true });
  await (await file.createWritable()).write('opaque PNG');
  const local = await readLocalPublishImages(root, item, { isTransparent: async () => false });
  assert.deepEqual(local.main.map((file) => file.name), ['06.png']);
  assert.equal(local.transparent, null);
});
