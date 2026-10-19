import { test } from 'node:test';
import assert from 'node:assert/strict';
import { safeName, imageFileName, pickBrandDir, buildLocalPlan, IMAGE_DIRS, INFO_JSON, INFO_TXT } from '../src/shared/local-layout.js';
import { UNKNOWN_BRAND } from '../src/shared/brand-folders.js';

const product = {
  skuId: '100012345678',
  url: 'https://item.jd.com/100012345678.html',
  title: '华为 Mate 60 Pro',
  brand: { id: 8557, name: '华为（HUAWEI）' },
  crumbs: ['手机通讯', '手机', '手机'],
  price: 6999,
  params: [{ name: '产地', value: '中国大陆' }],
  mainImages: ['https://img14.360buyimg.com/n0/jfs/t1/a.jpg', 'https://img14.360buyimg.com/n0/jfs/t1/b.png!q70'],
  detailImages: ['https://img30.360buyimg.com/sku/jfs/t1/d.jpg.avif?x=1'],
  saleDims: [{ name: '颜色', values: ['雅丹黑'] }],
};
const item = { id: '100012345678', skuId: '100012345678', url: product.url, product, edits: {} };

test('safeName strips characters that are invalid in folder names', () => {
  assert.equal(safeName('A/B:C*?"<>|D'), 'A_B_C______D');
  assert.equal(safeName('  品牌.. '), '品牌');
  assert.equal(safeName('..'), '_');
  assert.equal(safeName('', '备用'), '备用');
  assert.equal(safeName('x'.repeat(200)).length, 80);
});

test('imageFileName numbers images and keeps a real image extension', () => {
  assert.equal(imageFileName('https://a/jfs/x.jpg', 0), '01.jpg');
  assert.equal(imageFileName('https://a/jfs/x.PNG!q70', 9), '10.png');
  assert.equal(imageFileName('https://a/jfs/x.jpg.avif?x=1', 2), '03.avif');
  assert.equal(imageFileName('https://a/jfs/x', 0), '01.jpg');
});

test('pickBrandDir reuses an existing folder of the same brand spelled differently', () => {
  assert.equal(pickBrandDir(['小米', '华为(huawei)'], '华为（HUAWEI）'), '华为(huawei)');
  assert.equal(pickBrandDir(['小米'], '华为（HUAWEI）'), '华为（HUAWEI）');
  assert.equal(pickBrandDir([], 'A/B'), 'A_B');
});

// 旧数据里的 /n0/ 主图带京东水印，保存时换成 /sku/ 无水印原图
test('buildLocalPlan puts images and info under brand/sku', () => {
  const plan = buildLocalPlan(item, { now: new Date('2026-10-19T08:00:00Z') });
  assert.equal(plan.brand, '华为（HUAWEI）');
  assert.equal(plan.skuDir, '100012345678');
  assert.deepEqual(plan.images, [
    { dir: IMAGE_DIRS.main, name: '01.jpg', url: 'https://img14.360buyimg.com/sku/jfs/t1/a.jpg' },
    { dir: IMAGE_DIRS.main, name: '02.png', url: 'https://img14.360buyimg.com/sku/jfs/t1/b.png' },
    { dir: IMAGE_DIRS.detail, name: '01.avif', url: product.detailImages[0] },
  ]);
  const json = JSON.parse(plan.files.find((f) => f.name === INFO_JSON).text);
  assert.equal(json.app, 'jdmove');
  assert.deepEqual(json.items[0].product, product);
  assert.deepEqual(json.items[0].localImages, { [IMAGE_DIRS.main]: ['01.jpg', '02.png'], [IMAGE_DIRS.detail]: ['01.avif'] });
  const txt = plan.files.find((f) => f.name === INFO_TXT).text;
  assert.match(txt, /标题：华为 Mate 60 Pro/);
  assert.match(txt, /SKU：100012345678/);
  assert.match(txt, /产地：中国大陆/);
  assert.match(txt, /颜色：雅丹黑/);
});

test('buildLocalPlan uses the edited brand and falls back to the unknown-brand folder', () => {
  assert.equal(buildLocalPlan({ ...item, edits: { brandName: '荣耀' } }).brand, '荣耀');
  assert.equal(buildLocalPlan({ ...item, product: { ...product, brand: null } }).brand, UNKNOWN_BRAND);
  assert.throws(() => buildLocalPlan({ ...item, product: null }), /尚未采集/);
});
