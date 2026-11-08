// 源类目在 VC 后台不是末级类目时自动选子类目（shared/vc-category.js）。
// 子类目数据见 fixtures/vc-categories.js（2026-11-08 在 VC 类目选择页实测）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { childKeywords, leafHints, pickLeafChild } from '../src/shared/vc-category.js';
import { CHOUZHI_CHILDREN, ROLL_CHILDREN, leaf } from './fixtures/vc-categories.js';

/** SKU 10077221167161 采集到的商品信息（节选）：源类目只有三级 15901 > 15902 > 15908 */
const SAMPLE = {
  title: '维达（Vinda）抽纸 硬盒盒装抽纸 精品面巾纸卫生纸巾加厚3层100抽餐巾纸擦手纸 自然无香8盒2提装',
  brand: { id: 17519, name: '维达（Vinda）' },
  crumbs: ['家庭清洁/纸品', '清洁纸品', '抽纸', '维达（Vinda）'],
  params: [
    { name: '原料成分', value: '原生木浆' },
    { name: '类别', value: '面巾纸' },
    { name: '包装', value: '盒装' },
    { name: '类型', value: '硬盒装' },
    { name: '层数', value: '3层' },
  ],
};

test('childKeywords: 子类目名 + 说明里“包含…商品”列出的词（冒号可有可无）', () => {
  assert.deepEqual(childKeywords(CHOUZHI_CHILDREN[2]), ['常规抽纸', '三层抽纸', '四层抽纸', '软抽纸']);
  assert.deepEqual(childKeywords(CHOUZHI_CHILDREN[3]), ['本色抽纸', '原色抽纸', '无漂白抽纸']);
  assert.deepEqual(childKeywords(leaf('1', '大盘纸')), ['大盘纸']);
});

test('leafHints: 标题去掉品牌，属性覆盖排在源属性前面，不含面包屑', () => {
  const hints = leafHints(SAMPLE, { attrOverrides: { 类别: '擦手纸' } });
  assert.ok(hints.title.startsWith('抽纸'), hints.title);
  assert.ok(!hints.title.includes('维达'));
  assert.deepEqual(hints.texts.slice(0, 2), ['擦手纸', '原生木浆']);
  assert.ok(!hints.texts.includes('抽纸'), '面包屑只有上级类目名，不算依据');
});

test('pickLeafChild: SKU 10077221167161 标题末尾堆了“擦手纸”也不选擦手纸，选常规抽纸', () => {
  const res = pickLeafChild(CHOUZHI_CHILDREN, leafHints(SAMPLE));
  assert.equal(res.child?.id, '31403', JSON.stringify(res));
  assert.match(res.reason, /常规/);
});

test('pickLeafChild: 属性里写明是擦手纸时选擦手纸', () => {
  const product = { ...SAMPLE, params: [{ name: '类别', value: '商用擦手纸' }] };
  const res = pickLeafChild(CHOUZHI_CHILDREN, leafHints(product));
  assert.equal(res.child?.id, '44479');
  assert.match(res.reason, /擦手纸/);
});

test('pickLeafChild: 标题开头就是子类目的词时选它', () => {
  const product = { ...SAMPLE, title: '维达（Vinda）本色抽纸 竹浆3层100抽*24包', params: [] };
  assert.equal(pickLeafChild(CHOUZHI_CHILDREN, leafHints(product)).child?.id, '31402');
});

test('pickLeafChild: 卷纸没有常规类目，按标题里出现的子类目名选', () => {
  const lead = { title: '维达（Vinda）有芯卷纸 蓝色经典4层140g*27卷', brand: SAMPLE.brand, crumbs: ['清洁纸品', '卷纸'], params: [] };
  assert.equal(pickLeafChild(ROLL_CHILDREN, leafHints(lead)).child?.id, '40883');
  const tail = { ...lead, title: '维达（Vinda）卷纸 4层加厚卫生纸巾家用厕纸整箱 无芯卷纸' };
  assert.equal(pickLeafChild(ROLL_CHILDREN, leafHints(tail)).child?.id, '40884');
});

test('pickLeafChild: 没有依据又没有常规类目时不猜，返回候选', () => {
  const product = { title: '维达（Vinda）卷纸 4层加厚卫生纸巾', brand: SAMPLE.brand, crumbs: ['卷纸'], params: [] };
  const res = pickLeafChild(ROLL_CHILDREN, leafHints(product));
  assert.equal(res.child, null);
  assert.deepEqual(res.candidates.map((c) => c.id), ['44477', '40883', '40884']);
});

test('pickLeafChild: 不能发布的末级类目不算候选；只剩一个时直接选它', () => {
  const children = [leaf('44477', '大盘纸', '', false), leaf('40883', '有芯卷纸'), leaf('40884', '无芯卷纸', '', false)];
  const res = pickLeafChild(children, leafHints({ title: '卷纸', params: [] }));
  assert.equal(res.child?.id, '40883');
  assert.match(res.reason, /只有/);
});

test('pickLeafChild: 一个可发布的子类目都没有时返回空候选', () => {
  const res = pickLeafChild([leaf('1', '甲', '', false)], leafHints({ title: '甲', params: [] }));
  assert.equal(res.child, null);
  assert.deepEqual(res.candidates, []);
});

test('pickLeafChild: 非末级子类目也是候选（还要再往下选）', () => {
  const children = [{ id: '9', name: '有芯卷纸', isLeaf: false, publishEnable: false, interpretation: '' }, leaf('8', '大盘纸')];
  const res = pickLeafChild(children, leafHints({ title: '有芯卷纸 4层', params: [] }));
  assert.equal(res.child?.id, '9');
});

test('pickLeafChild: 说明里列了上级类目名的子类目不会因此得分', () => {
  const children = [leaf('1', '有芯卷纸', '该类目经营卷纸商品，包含有芯卷纸、卷纸商品'), leaf('2', '无芯卷纸')];
  const hints = leafHints({ title: '卷纸 加厚4层家用卫生纸整箱装 无芯卷纸', params: [] });
  assert.equal(pickLeafChild(children, hints).child?.id, '1', '不给上级名时“卷纸”命中标题开头');
  assert.equal(pickLeafChild(children, hints, '卷纸').child?.id, '2');
});
