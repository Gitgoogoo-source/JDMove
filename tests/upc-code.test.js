import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const CORE_SRC = readFileSync(new URL('../src/inject/backend-core.js', import.meta.url), 'utf8');

/**
 * 只有表单 API 的发布页：fields 是页面上的字段，rules 给出字段标题；
 * sticky=false 模拟写不进去（页面把值改回去）
 */
function loadPublishPage({ fields, rules = {}, values = {}, sticky = true }) {
  const state = { ...values };
  const api = {
    fields: () => fields,
    getRule: (f) => rules[f] ?? { field: f },
    getValue: (f) => state[f],
    setValue: (f, v) => {
      if (sticky) state[f] = v;
    },
  };
  const component = { type: { name: 'PublishProduct' }, setupState: { fApi: api }, subTree: null };
  const app = { _container: { _vnode: { component } } };
  const document = { querySelector: (sel) => (sel === '#app' ? { __vue_app__: app } : null), querySelectorAll: () => [] };
  const window = { __JDMOVE__: {} };
  class Ev {
    constructor(type) {
      this.type = type;
    }
  }
  vm.runInNewContext(CORE_SRC, {
    window,
    document,
    location: { href: 'https://wares-jdm.jd.com/popPublish/?categoryId=18130', pathname: '/popPublish/' },
    HTMLInputElement: class {},
    HTMLTextAreaElement: class {},
    Event: Ev,
    MouseEvent: Ev,
    setTimeout,
    clearTimeout,
  });
  return { B: window.__JDMOVE__.backend, state };
}

const plain = (o) => JSON.parse(JSON.stringify(o));

test('setUpcCode: 把条形码写进商品基本信息的 upcCode 字段并读回', () => {
  const { B, state } = loadPublishPage({ fields: ['productTitle', 'brandId', 'features.model', 'itemNum', 'upcCode', 'skus'] });
  assert.deepEqual(plain(B.setUpcCode('6901845044423')), { ok: true, present: true, value: '6901845044423' });
  assert.equal(state.upcCode, '6901845044423');
});

test('setUpcCode: 字段名不是 upcCode 时按标题“商品条形码”找', () => {
  const { B, state } = loadPublishPage({ fields: ['productTitle', 'goodsCode'], rules: { goodsCode: { field: 'goodsCode', title: '商品条形码' } } });
  assert.equal(B.setUpcCode('6901845044423').ok, true);
  assert.equal(state.goodsCode, '6901845044423');
});

test('setUpcCode: 没有这个字段的类目不报错', () => {
  const { B } = loadPublishPage({ fields: ['productTitle', 'brandId', 'skus'] });
  assert.deepEqual(plain(B.setUpcCode('6901845044423')), { ok: true, present: false, value: '' });
});

test('setUpcCode: 没有可填的值时只读回当前值；写不进去时 ok=false', () => {
  const empty = loadPublishPage({ fields: ['upcCode'] }).B.setUpcCode('');
  assert.deepEqual(plain(empty), { ok: true, present: true, value: '' });
  const kept = loadPublishPage({ fields: ['upcCode'], values: { upcCode: '6914973039001' } }).B.setUpcCode('');
  assert.equal(kept.value, '6914973039001');
  const lost = loadPublishPage({ fields: ['upcCode'], sticky: false }).B.setUpcCode('6901845044423');
  assert.deepEqual(plain(lost), { ok: false, present: true, value: '' });
});
