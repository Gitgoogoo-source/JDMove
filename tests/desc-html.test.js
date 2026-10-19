import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const MEDIA_SRC = readFileSync(new URL('../src/inject/backend-media.js', import.meta.url), 'utf8');

class Event {
  constructor(type) {
    this.type = type;
  }
}

const HTML = '<div><p><img src="https://img10.360buyimg.com/imgzone/jfs/t1/a.jpg" /></p></div>';

/**
 * 代码编辑模式的发布页：编辑器内容由页面同步到表单值 productDesc.notes。
 * sync=false 表示编辑器始终不同步；overwriteOnce 表示第一次写入后页面又用旧内容覆盖了表单值
 */
function loadPage({ sync = true, overwriteOnce = false, codeChecked = true, lateConfirm = 0 } = {}) {
  const form = { productDesc: { notes: '', introductionUseFlag: 1 } };
  let writes = 0;
  const editor = {
    isConnected: true,
    _html: '',
    focus() {},
    dispatchEvent() {
      return true;
    },
    get innerHTML() {
      return this._html;
    },
    set innerHTML(v) {
      this._html = v;
      writes += 1;
      if (sync) form.productDesc = { ...form.productDesc, notes: v };
      if (overwriteOnce && writes === 1) form.productDesc = { ...form.productDesc, notes: '<p>旧内容</p>' };
    },
  };
  const radioEl = {
    classList: { set: new Set(codeChecked ? ['is-checked'] : []), contains(c) { return this.set.has(c); } },
    querySelector: () => ({ value: 'CODE' }),
    innerText: '代码编辑',
    isConnected: true,
    click() {},
  };
  let dialogPolls = 0;
  const okBtn = { clicks: 0, click() { this.clicks += 1; radioEl.classList.set.add('is-checked'); } };
  const dialog = { innerText: '是否切换代码模式？', isConnected: true };
  const dialogOpen = () => lateConfirm > 0 && okBtn.clicks === 0 && ++dialogPolls > lateConfirm;
  const api = {
    getValue: (k) => form[k],
    setValue: (k, v) => {
      form[k] = v;
    },
  };
  const util = {
    sleep: () => Promise.resolve(),
    qsa: (sel) => (sel === '.w-e-text' ? [editor] : /jd-radio/.test(sel) ? [radioEl] : []),
    visible: (el) => !!(el && el.isConnected),
    textOf: (el) => String(el?.innerText ?? ''),
    waitFor: async (fn) => {
      for (let i = 0; i < 20; i += 1) {
        const v = fn();
        if (v) return v;
      }
      return null;
    },
    click: (el) => el.click(),
    visibleDialogs: () => (dialogOpen() ? [dialog] : []),
    buttonByText: (label) => (label === '确定' ? okBtn : null),
  };
  const backend = { __core: true, util, getFApi: () => api };
  vm.runInNewContext(MEDIA_SRC, { window: { __JDMOVE__: { backend } }, document: { querySelectorAll: () => [] }, Event, FocusEvent: Event });
  return { B: backend, form, okBtn };
}

const fast = { settleMs: 0 };

test('setDescriptionHtml: 编辑器同步到表单值后返回成功', async () => {
  const { B, form } = loadPage();
  const res = await B.setDescriptionHtml(HTML, fast);
  assert.equal(res.ok, true);
  assert.equal(res.direct, undefined);
  assert.equal(form.productDesc.notes, HTML);
});

test('setDescriptionHtml: 页面重建编辑器覆盖了刚写的内容时重新写入', async () => {
  const { B, form } = loadPage({ overwriteOnce: true });
  const res = await B.setDescriptionHtml(HTML, fast);
  assert.equal(res.ok, true);
  assert.equal(form.productDesc.notes, HTML);
});

test('setDescriptionHtml: 编辑器始终不同步时直接写表单值，并保留其它字段', async () => {
  const { B, form } = loadPage({ sync: false });
  const res = await B.setDescriptionHtml(HTML, fast);
  assert.equal(res.ok, true);
  assert.equal(res.direct, true);
  assert.equal(form.productDesc.notes, HTML);
  assert.equal(form.productDesc.introductionUseFlag, 1);
});

test('setDescriptionHtml: 写不进去时报告编辑器和表单的实际长度', async () => {
  const { B, form } = loadPage({ sync: false });
  const api = { getValue: (k) => form[k], setValue: () => {} };
  B.getFApi = () => api;
  const res = await B.setDescriptionHtml(HTML, fast);
  assert.equal(res.ok, false);
  assert.match(res.error, /编辑器 \d+ 字符，表单 0 字符/);
});

test('switchDescMode: 确认框晚出现时仍会点确定，并只点一次', async () => {
  const { B, okBtn } = loadPage({ codeChecked: false, lateConfirm: 3 });
  assert.equal(await B.switchDescMode('代码编辑'), true);
  assert.equal(okBtn.clicks, 1);
});
