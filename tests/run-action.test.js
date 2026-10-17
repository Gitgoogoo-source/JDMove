import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const MEDIA_SRC = readFileSync(new URL('../src/inject/backend-media.js', import.meta.url), 'utf8');

const el = (text, extra = {}) => ({
  innerText: text,
  textContent: text,
  isConnected: true,
  classList: { contains: (c) => (extra.classes ?? []).includes(c) },
  disabled: false,
  clicks: 0,
  click() {
    this.clicks += 1;
    extra.onClick?.();
  },
  dispatchEvent: () => true,
});

/** 模拟京麦发布页：点“保存草稿”后弹出 { 保存成功 … 我知道了 } */
function loadPage(popupText, popupButtons, actionLabel = '保存草稿') {
  const state = { popup: null };
  const buttons = popupButtons.map((t) => el(t, { onClick: () => (state.popup = null) }));
  const popup = { ...el(popupText, { classes: ['jd-message-box'] }), buttons };
  const saveBtn = el(actionLabel, { onClick: () => (state.popup = popup) });
  const textOf = (e) => (e ? String(e.innerText || '').replace(/\s+/g, ' ').trim() : '');
  const util = {
    sleep: () => new Promise((r) => setTimeout(r, 1)),
    qsa: () => [],
    visible: () => true,
    textOf,
    waitFor: async (fn) => fn(),
    click: (e) => e.click(),
    visibleDialogs: () => (state.popup ? [state.popup] : []),
    messages: () => [],
    buttonByText: (label, root) => (root ? root.buttons : [saveBtn]).find((b) => textOf(b) === label) ?? null,
  };
  const backend = { __core: true, util, collectErrors: () => [], status: () => ({}) };
  const window = { __JDMOVE__: { backend } };
  vm.runInNewContext(MEDIA_SRC, { window, document: {}, location: { href: 'https://wares-jdm.jd.com/popPublish/?a=1' } });
  return { B: backend, buttons, state };
}

test('runAction: 保存草稿后的“保存成功”弹窗自动点“我知道了”，按成功处理', async () => {
  const { B, buttons, state } = loadPage('保存成功 请前往商品管理-草稿箱中查看编辑，商品发布且审核通过后可进行售卖。', ['我知道了']);
  const res = await B.runAction('draft');
  assert.equal(res.ok, true);
  assert.equal(res.confirmText, '');
  assert.equal(buttons[0].clicks, 1);
  assert.equal(state.popup, null);
});

test('runAction: 提交类操作遇到非成功的确认框仍交给人工', async () => {
  const { B, buttons } = loadPage('提示 确认提交该商品吗？', ['取消', '确定'], '提交暂不上架');
  const res = await B.runAction('submit_off');
  assert.match(res.confirmText, /确认提交/);
  assert.equal(buttons[1].clicks, 0);
});
