import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  salePriceOf,
  priceStatus,
  checkedToday,
  priceFromJd,
  deriveEditUrlTemplate,
  buildEditUrl,
  normalizeWareId,
  parseWareId,
  pricesMatch,
  priceCheckPatch,
  repricePatch,
  alertItems,
} from '../src/shared/price-watch.js';
import { mergeSettings } from '../src/shared/settings.js';

const settings = mergeSettings({ price: { multiplier: 1.1, add: 0, rounding: 'cent' } });
const archived = (extra = {}) => ({ id: '100001', status: 'published', publishedAt: 1, product: { price: 50 }, edits: {}, ...extra });

test('salePriceOf: recorded shop price wins, then edited price, then the pricing rule', () => {
  assert.equal(salePriceOf(archived({ salePrice: 59, edits: { price: 58 } }), settings.price), 59);
  assert.equal(salePriceOf(archived({ edits: { price: 58 } }), settings.price), 58);
  assert.equal(salePriceOf(archived(), settings.price), 55);
  assert.equal(salePriceOf(archived({ product: null }), settings.price), null);
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

test('priceFromJd: today’s JD price plus a markup, in cents; null without a price', () => {
  assert.equal(priceFromJd({ priceCheck: { price: 60.5 } }), 60.5);
  assert.equal(priceFromJd({ priceCheck: { price: 60.5 } }, 1.2), 61.7);
  assert.equal(priceFromJd({ priceCheck: { price: 0.5 } }, -1), 0.01);
  assert.equal(priceFromJd({ priceCheck: { error: 'x' } }), null);
  assert.equal(priceFromJd({}), null);
});

test('deriveEditUrlTemplate: replaces the product id in a pasted edit link', () => {
  assert.deepEqual(deriveEditUrlTemplate('https://wares-jdm.jd.com/popPublish/?wareId=10088812345&publishType=2'), {
    template: 'https://wares-jdm.jd.com/popPublish/?wareId={wareId}&publishType=2',
    sampleId: '10088812345',
  });
  assert.deepEqual(deriveEditUrlTemplate('https://shop.jd.com/jdm/#/ware/edit?skuId=100123456789'), {
    template: 'https://shop.jd.com/jdm/#/ware/edit?skuId={wareId}',
    sampleId: '100123456789',
  });
  assert.deepEqual(deriveEditUrlTemplate(' https://ware.shop.jd.com/edit/10088812345.html?from=list '), {
    template: 'https://ware.shop.jd.com/edit/{wareId}.html?from=list',
    sampleId: '10088812345',
  });
});

test('deriveEditUrlTemplate: refuses links with several ids, so items never all open the sample product', () => {
  assert.equal(deriveEditUrlTemplate('https://wares-jdm.jd.com/popPublish?skuId=100012345678&wareId=10088812345'), null);
  assert.equal(deriveEditUrlTemplate('https://wares-jdm.jd.com/e?id=1000123&wareId=10088812345'), null);
  assert.equal(deriveEditUrlTemplate('https://wares-jdm.jd.com/a/10088812345/b/10088812399'), null);
  assert.equal(deriveEditUrlTemplate('https://wares-jdm.jd.com/e?wareId={wareId}&skuId=100012345678'), null);
  // 用户自己写模板、删掉多余编号后可以用
  assert.equal(deriveEditUrlTemplate('https://wares-jdm.jd.com/e?wareId={wareId}&publishType=2').template, 'https://wares-jdm.jd.com/e?wareId={wareId}&publishType=2');
});

test('deriveEditUrlTemplate: rejects userinfo links that would corrupt the host', () => {
  assert.equal(deriveEditUrlTemplate('https://user@wares-jdm.jd.com/edit/10088812345'), null);
  assert.equal(deriveEditUrlTemplate('https://evil.com@wares-jdm.jd.com/e?wareId={wareId}'), null);
});

test('deriveEditUrlTemplate: accepts a ready template; rejects non-JD or id-less links', () => {
  assert.deepEqual(deriveEditUrlTemplate('https://wares-jdm.jd.com/edit?wareId={wareId}'), {
    template: 'https://wares-jdm.jd.com/edit?wareId={wareId}',
    sampleId: '',
  });
  assert.equal(deriveEditUrlTemplate('https://evil.example.com/edit?wareId=10088812345'), null);
  assert.equal(deriveEditUrlTemplate('http://wares-jdm.jd.com/edit?wareId=10088812345'), null);
  assert.equal(deriveEditUrlTemplate('https://wares-jdm.jd.com/list'), null);
  assert.equal(deriveEditUrlTemplate('https://jd.com.evil.cn/edit?wareId=10088812345'), null);
  assert.equal(deriveEditUrlTemplate(''), null);
});

test('buildEditUrl fills the id and refuses bad input', () => {
  assert.equal(buildEditUrl('https://wares-jdm.jd.com/e?wareId={wareId}', '10088812345'), 'https://wares-jdm.jd.com/e?wareId=10088812345');
  assert.throws(() => buildEditUrl('', '10088812345'), /编辑页地址/);
  assert.throws(() => buildEditUrl('https://wares-jdm.jd.com/e?wareId={wareId}', '12ab'), /店铺商品编号/);
});

test('normalizeWareId keeps digits-only ids', () => {
  assert.equal(normalizeWareId(' 10088812345 '), '10088812345');
  assert.equal(normalizeWareId('abc'), '');
  assert.equal(normalizeWareId(''), '');
  assert.equal(normalizeWareId(null), '');
});

test('parseWareId: captured response, then url, then message text', () => {
  assert.equal(parseWareId({ captured: ['10088812345'], url: 'https://x.jd.com/?wareId=111111111' }), '10088812345');
  assert.equal(parseWareId({ captured: ['10088812345', '10088812345'] }), '10088812345');
  // 抓到多个不同编号时不知道哪个是新商品：不采用
  assert.equal(parseWareId({ captured: ['10088812345', '10099999999'] }), '');
  assert.equal(parseWareId({ captured: ['10088812345', '10099999999'], url: 'https://x.jd.com/ok?wareId=10088812345' }), '10088812345');
  assert.equal(parseWareId({ url: 'https://wares-jdm.jd.com/success?wareId=10088812345' }), '10088812345');
  assert.equal(parseWareId({ messages: ['发布成功，商品编号：10088812345'] }), '10088812345');
  assert.equal(parseWareId({ messages: ['保存成功'] }), '');
  assert.equal(parseWareId(), '');
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

test('pricesMatch: the edit page price must be within 1% (at least 1 cent) of the recorded sale price', () => {
  assert.equal(pricesMatch(['55'], 55), true);
  assert.equal(pricesMatch(['55.50', '60'], 55), true);
  assert.equal(pricesMatch(['55.56'], 55), false);
  assert.equal(pricesMatch(['0.02'], 0.01), true);
  assert.equal(pricesMatch(['99'], 55), false);
  assert.equal(pricesMatch(['', '0'], 55), false);
  assert.equal(pricesMatch(['55'], null), false);
});

test('repricePatch: success updates shop price and edited price; failure keeps prices', () => {
  const item = archived({ salePrice: 55, edits: { title: 't' } });
  const ok = repricePatch(item, { status: 'ok', price: 61, from: '55', message: '提交成功' }, 9);
  assert.equal(ok.salePrice, 61);
  assert.deepEqual(ok.edits, { title: 't', price: 61 });
  assert.deepEqual(ok.reprice, { at: 9, from: '55', to: 61, status: 'ok', message: '提交成功' });
  assert.match(ok.message, /已改价为 ¥61/);
  const draft = repricePatch(item, { status: 'ok', draft: true, price: 61, message: '保存成功' }, 9);
  assert.equal('salePrice' in draft, false);
  assert.equal('edits' in draft, false);
  assert.match(draft.message, /草稿/);
  const bad = repricePatch(item, { status: 'failed', price: 61, message: '找不到按钮' }, 9);
  assert.equal('salePrice' in bad, false);
  assert.equal('edits' in bad, false);
  assert.match(bad.message, /改价未完成：找不到按钮/);
  assert.deepEqual(item.edits, { title: 't' });
});
