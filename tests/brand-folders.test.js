import { test } from 'node:test';
import assert from 'node:assert/strict';
import { itemBrand, groupPublishedByBrand, filterFolders, UNKNOWN_BRAND } from '../src/shared/brand-folders.js';

const item = (id, status, brand, extra = {}) => ({
  id,
  status,
  product: brand === undefined ? null : { brand: brand ? { name: brand } : null },
  edits: {},
  updatedAt: Number(id),
  ...extra,
});

test('itemBrand prefers the brand used for publishing (edited) over the collected one', () => {
  assert.equal(itemBrand(item('1', 'published', '华为（HUAWEI）')), '华为（HUAWEI）');
  assert.equal(itemBrand(item('2', 'published', '华为', { edits: { brandName: ' 荣耀 ' } })), '荣耀');
  assert.equal(itemBrand(item('3', 'published', '')), UNKNOWN_BRAND);
  assert.equal(itemBrand(item('4', 'published', undefined)), UNKNOWN_BRAND);
});

test('groupPublishedByBrand only keeps published items, one folder per brand', () => {
  const items = [
    item('1', 'published', '华为（HUAWEI）'),
    item('2', 'need_action', '华为（HUAWEI）'),
    item('3', 'published', '小米（MI）'),
    item('4', 'published', '华为(huawei)'),
    item('5', 'published', ''),
    item('6', 'collected', '小米（MI）'),
  ];
  const folders = groupPublishedByBrand(items);
  assert.deepEqual(
    folders.map((f) => [f.brand, f.items.map((i) => i.id)]),
    [
      ['华为（HUAWEI）', ['4', '1']],
      ['小米（MI）', ['3']],
      [UNKNOWN_BRAND, ['5']],
    ],
  );
  assert.equal(folders[0].key, folders.find((f) => f.brand === '华为（HUAWEI）').key);
  assert.deepEqual(items.map((i) => i.id), ['1', '2', '3', '4', '5', '6']);
});

test('groupPublishedByBrand sorts by count, then by name; unknown brand goes last', () => {
  const folders = groupPublishedByBrand([
    item('1', 'published', ''),
    item('2', 'published', ''),
    item('3', 'published', 'B牌'),
    item('4', 'published', 'A牌'),
  ]);
  assert.deepEqual(folders.map((f) => f.brand), ['A牌', 'B牌', UNKNOWN_BRAND]);
  assert.deepEqual(groupPublishedByBrand([]), []);
});

test('filterFolders matches brand names case-insensitively', () => {
  const folders = groupPublishedByBrand([item('1', 'published', '华为（HUAWEI）'), item('2', 'published', '小米')]);
  assert.deepEqual(filterFolders(folders, 'huawei').map((f) => f.brand), ['华为（HUAWEI）']);
  assert.equal(filterFolders(folders, '  ').length, 2);
});
