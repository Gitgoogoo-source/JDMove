import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const MEDIA_SRC = readFileSync(new URL('../src/inject/backend-media.js', import.meta.url), 'utf8');

// 京麦“商品描述”的三个模式单选框（2026-10 实际结构：图文编辑带“推荐”角标）
function radio(value, label, checked) {
  const input = { value };
  const el = {
    innerText: label,
    textContent: label,
    isConnected: true,
    offsetParent: {},
    getClientRects: () => [1],
    classList: {
      set: new Set(checked ? ['is-checked'] : []),
      contains(c) {
        return this.set.has(c);
      },
    },
    querySelector: (sel) => (sel === 'input.jd-radio__original' ? input : null),
    click: () => {
      for (const r of radios) r.classList.set.delete('is-checked');
      el.classList.set.add('is-checked');
    },
    dispatchEvent: () => true,
  };
  return el;
}
let radios = [];

function loadMedia() {
  radios = [radio('FLOOR', '图文编辑推荐', false), radio('CODE', '代码编辑', true), radio('ZHUANG_BA', '高级编辑', false)];
  const section = { ...radios[0], querySelectorAll: (sel) => (sel === 'label.jd-radio' ? radios : []) };
  const document = { querySelectorAll: (sel) => (/shop-editor/.test(sel) ? [section] : sel === 'label.jd-radio' ? radios : []) };
  const textOf = (el) => (el ? String(el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim() : '');
  const util = {
    sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))),
    qsa: (sel, root = document) => Array.from(root.querySelectorAll(sel)),
    visible: (el) => !!(el && el.isConnected),
    textOf,
    waitFor: async (fn) => fn(),
    click: (el) => el.click(),
    visibleDialogs: () => [],
    buttonByText: () => null,
  };
  const window = { __JDMOVE__: { backend: { __core: true, util } } };
  const MouseEvent = class {};
  vm.runInNewContext(MEDIA_SRC, { window, document, MouseEvent, Event: class {}, XMLHttpRequest: class {} });
  return window.__JDMOVE__.backend;
}

test('switchDescMode: 图文编辑的文字带“推荐”角标时仍能找到并切换', async () => {
  const B = loadMedia();
  assert.equal(await B.switchDescMode('图文编辑'), true);
  assert.ok(radios[0].classList.contains('is-checked'));
});

test('switchDescMode: 代码编辑按单选框的值识别', async () => {
  const B = loadMedia();
  await B.switchDescMode('图文编辑');
  assert.equal(await B.switchDescMode('代码编辑'), true);
  assert.ok(radios[1].classList.contains('is-checked'));
});
