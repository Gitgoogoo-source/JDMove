// 已发布商品的京东今日价检查：和发布时填的 VC 京东价对比
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { salePriceOf, priceStatus, checkedToday, priceCheckPatch, alertItems } from '../src/shared/price-watch.js';
import { mergeSettings } from '../src/shared/settings.js';

const settings = mergeSettings({});
const archived = (extra = {}) => ({ id: '100001', status: 'published', publishedAt: 1, product: { price: 50 }, edits: {}, ...extra });

test('salePriceOf: 发布时记下的 VC 京东价优先，没有时用编辑里填的京东价；都没有时为 null（不再按源价格推算）', () => {
  assert.equal(salePriceOf(archived({ salePrice: 59, edits: { vc: { jdPrice: 58 } } })), 59);
  assert.equal(salePriceOf(archived({ edits: { vc: { jdPrice: 58 } } })), 58);
  assert.equal(salePriceOf(archived()), null);
  assert.equal(salePriceOf(archived({ edits: { price: 58 } })), null, '旧版本 POP 的售价不再使用');
  assert.equal(salePriceOf(null), null);
});

test('priceStatus: 没有发布记录时按编辑里的 VC 京东价判断倒挂', () => {
  const st = priceStatus(archived({ edits: { vc: { jdPrice: 69.9 } }, priceCheck: { price: 72, checkedAt: 9 } }), settings);
  assert.deepEqual([st.sale, st.profit, st.inverted], [69.9, -2.1, true]);
});

test('priceStatus: flags an inversion when today’s JD price is above the shop price', () => {
  const st = priceStatus(archived({ salePrice: 55, priceCheck: { price: 60.5, label: '京东价', checkedAt: 9 } }), settings);
  assert.equal(st.sale, 55);
  assert.equal(st.jd, 60.5);
  assert.equal(st.profit, -5.5);
  assert.equal(st.inverted, true);
  assert.equal(st.alert, true);
});

test('priceStatus: equal price is not an inversion; no check means no alert', () => {
  assert.equal(priceStatus(archived({ salePrice: 55, priceCheck: { price: 55, checkedAt: 9 } }), settings).alert, false);
  const none = priceStatus(archived({ salePrice: 55 }), settings);
  assert.equal(none.jd, null);
  assert.equal(none.profit, null);
  assert.equal(none.alert, false);
  const failed = priceStatus(archived({ salePrice: 55, priceCheck: { price: null, error: '没有价格', checkedAt: null, errorAt: 9 } }), settings);
  assert.equal(failed.alert, false);
});

test('priceStatus: a failed re-check keeps alerting on the last good price', () => {
  const prev = { price: 60, label: '京东价', checkedAt: 5 };
  const patch = priceCheckPatch({ status: 'error', message: '页面加载超时' }, 9, prev);
  assert.equal(priceStatus(archived({ salePrice: 55, ...patch }), settings).inverted, true);
});

test('priceStatus: alert margin also warns about thin profit, without calling it an inversion', () => {
  const s = mergeSettings({ priceWatch: { alertMargin: 3 } });
  const st = priceStatus(archived({ salePrice: 55, priceCheck: { price: 53, checkedAt: 9 } }), s);
  assert.equal(st.profit, 2);
  assert.equal(st.inverted, false);
  assert.equal(st.alert, true);
  assert.equal(priceStatus(archived({ salePrice: 55, priceCheck: { price: 52, checkedAt: 9 } }), s).alert, false);
});

test('priceStatus: profit is rounded to cents', () => {
  const st = priceStatus(archived({ salePrice: 19.9, priceCheck: { price: 19.7, checkedAt: 9 } }), settings);
  assert.equal(st.profit, 0.2);
});

test('alertItems: only archived items with an alert, biggest loss first', () => {
  const items = [
    archived({ id: 'a', salePrice: 50, priceCheck: { price: 51 } }),
    archived({ id: 'b', salePrice: 50, priceCheck: { price: 60 } }),
    archived({ id: 'c', salePrice: 50, priceCheck: { price: 40 } }),
    { id: 'd', status: 'collected', salePrice: 50, priceCheck: { price: 90 }, product: { price: 1 } },
  ];
  assert.deepEqual(alertItems(items, settings).map((i) => i.id), ['b', 'a']);
});

test('checkedToday compares local calendar days', () => {
  const now = new Date(2026, 9, 19, 10, 0).getTime();
  assert.equal(checkedToday({ priceCheck: { checkedAt: new Date(2026, 9, 19, 0, 5).getTime() } }, now), true);
  assert.equal(checkedToday({ priceCheck: { checkedAt: new Date(2026, 9, 18, 23, 59).getTime() } }, now), false);
  assert.equal(checkedToday({}, now), false);
  // 最近一次检查失败的算没检查，下次默认会重试
  assert.equal(checkedToday({ priceCheck: { price: 50, checkedAt: now, error: '超时', errorAt: now } }, now), false);
});

test('priceCheckPatch records the price, or the error while keeping the last good price', () => {
  assert.deepEqual(priceCheckPatch({ status: 'ok', price: 60.5, label: '补贴价' }, 7), {
    priceCheck: { price: 60.5, label: '补贴价', checkedAt: 7 },
  });
  assert.deepEqual(priceCheckPatch({ status: 'error', message: '没有价格' }, 7), {
    priceCheck: { price: null, label: '', checkedAt: null, error: '没有价格', errorAt: 7 },
  });
  const prev = { price: 60.5, label: '补贴价', checkedAt: 3 };
  assert.deepEqual(priceCheckPatch({ status: 'error', message: '超时' }, 7, prev), {
    priceCheck: { price: 60.5, label: '补贴价', checkedAt: 3, error: '超时', errorAt: 7 },
  });
  // 成功后清掉失败记录
  assert.deepEqual(priceCheckPatch({ status: 'ok', price: 58, label: '' }, 9, { ...prev, error: '超时', errorAt: 7 }), {
    priceCheck: { price: 58, label: '', checkedAt: 9 },
  });
});
