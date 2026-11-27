import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  THUMB_LIMIT,
  cleanShopTitle,
  formatVariantTitle,
  normalizeSpus,
  spuListSkus,
  spuListTitles,
  needsItemPage,
  normalizeItemSkus,
  normalizeItemTitles,
} from '../src/shared/shop-spu.js';

test('normalizeSpus: 只保留数字编码，缩略图去重；页面没有缩略图栏时 sids 为 null', () => {
  const raw = [
    { sku: '100000481562', sids: ['100000481562', '8923703', '8923703', 'x', ''] },
    { sku: '7481134', sids: null },
    { sku: 'abc', sids: ['1234567'] },
    null,
    { sku: '100000481562', sids: [] },
  ];
  assert.deepEqual(normalizeSpus(raw), [
    { sku: '100000481562', sids: ['100000481562', '8923703'] },
    { sku: '7481134', sids: null },
  ]);
  assert.deepEqual(normalizeSpus(undefined), []);
  assert.deepEqual(normalizeSpus({}), []);
});

test('spuListSkus: 列表上能看到的全部 SKU（主 SKU + 缩略图），保持顺序去重', () => {
  const spus = [
    { sku: '1000001', sids: ['1000001', '1000002'] },
    { sku: '1000003', sids: null },
    { sku: '1000004', sids: ['1000002', '1000005'] },
  ];
  assert.deepEqual(spuListSkus(spus), ['1000001', '1000002', '1000003', '1000004', '1000005']);
});

test('needsItemPage: 缩略图少于 5 个时列表已完整，不打开商品页', () => {
  const sids = (n) => Array.from({ length: n }, (_, i) => String(1000000 + i));
  assert.equal(THUMB_LIMIT, 5);
  assert.equal(needsItemPage({ sku: '1000000', sids: sids(4) }, new Set()), false);
  assert.equal(needsItemPage({ sku: '1000000', sids: [] }, new Set()), false);
  // 正好 5 个可能被截断（实测 14 个规格的 SPU 列表上只显示 5 个）
  assert.equal(needsItemPage({ sku: '1000000', sids: sids(5) }, new Set()), true);
  // 模板不显示缩略图时无法判断，需要打开
  assert.equal(needsItemPage({ sku: '1000000', sids: null }, new Set()), true);
});

test('needsItemPage: 主 SKU 已在之前打开的商品页里读到过（同一个 SPU）时不再打开', () => {
  const sids = Array.from({ length: 5 }, (_, i) => String(1000000 + i));
  assert.equal(needsItemPage({ sku: '1000000', sids }, new Set(['1000000'])), false);
  assert.equal(needsItemPage({ sku: '2000000', sids: null }, new Set(['1000000'])), true);
});

test('normalizeItemSkus: 商品页读到的编码只保留数字并去重，主 SKU 放在最前', () => {
  assert.deepEqual(normalizeItemSkus({ skuIds: ['8923703', '100000481562', '8923703', 'bad'] }, '100000481562'), ['100000481562', '8923703']);
  assert.deepEqual(normalizeItemSkus({ skuIds: [] }, '100000481562'), []);
  assert.deepEqual(normalizeItemSkus(null, '100000481562'), []);
});

test('normalizeSpus + spuListTitles: 保留并清洗商品名称与缩略图规格名，主 SKU 标题优先于其他卡片的派生标题', () => {
  const raw = [
    {
      sku: '100103856391',
      title: '  威露士 沐浴露1L*3家庭装  ',
      sids: ['100103856391', '100043025636', '100043025632'],
      specs: { 100043025636: '氨基酸经典丨大瓶装1L', 100043025632: '  白茶无花果  ', bad: '忽略', 100103856391: '  ' },
    },
    {
      sku: '100043025632',
      title: '威露士白茶无花果沐浴露1L',
      sids: ['100043025632'],
      specs: {},
    },
  ];
  const spus = normalizeSpus(raw);
  assert.deepEqual(spus, [
    {
      sku: '100103856391',
      sids: ['100103856391', '100043025636', '100043025632'],
      title: '威露士 沐浴露1L*3家庭装',
      specs: { 100043025636: '氨基酸经典丨大瓶装1L', 100043025632: '白茶无花果' },
    },
    {
      sku: '100043025632',
      sids: ['100043025632'],
      title: '威露士白茶无花果沐浴露1L',
    },
  ]);
  assert.deepEqual(spuListTitles(spus), {
    100103856391: '威露士 沐浴露1L*3家庭装',
    100043025636: '威露士 沐浴露1L*3家庭装（氨基酸经典丨大瓶装1L）',
    100043025632: '威露士白茶无花果沐浴露1L',
  });
});

test('formatVariantTitle + cleanShopTitle: 标题已包含规格时不重复追加，缺主标题时退回规格名', () => {
  assert.equal(cleanShopTitle('  多 空格\n标题 '), '多 空格 标题');
  assert.equal(cleanShopTitle(null), '');
  assert.equal(formatVariantTitle('威露士沐浴露1L', '1L'), '威露士沐浴露1L');
  assert.equal(formatVariantTitle('威露士沐浴露', '大瓶装1L'), '威露士沐浴露（大瓶装1L）');
  assert.equal(formatVariantTitle('', '大瓶装1L'), '大瓶装1L');
  assert.equal(formatVariantTitle('威露士沐浴露', ''), '威露士沐浴露');
});

test('normalizeItemTitles: 展开 SPU 时主 SKU 保留主标题，其余规格附带规格名，商品页缺标题时回退卡片标题', () => {
  assert.deepEqual(
    normalizeItemTitles(
      {
        skuIds: ['100103856391', '100043025636', '100453517450'],
        title: '威露士沐浴露1L*3',
        specs: { 100103856391: '【家庭装】大瓶1L*3', 100043025636: '氨基酸经典丨大瓶装1L', 100453517450: '沐浴香皂洗护套装' },
      },
      '100103856391',
      '卡片标题',
    ),
    {
      100103856391: '威露士沐浴露1L*3',
      100043025636: '威露士沐浴露1L*3（氨基酸经典丨大瓶装1L）',
      100453517450: '威露士沐浴露1L*3（沐浴香皂洗护套装）',
    },
  );
  assert.deepEqual(
    normalizeItemTitles({ skuIds: ['1000001', '1000002'], title: '', specs: { 1000002: '2瓶装' } }, '1000001', '卡片主标题'),
    {
      1000001: '卡片主标题',
      1000002: '卡片主标题（2瓶装）',
    },
  );
});
