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
function loadPage(popupText, popupButtons, actionLabel = '保存草稿', { toasts = [], showPopup = true, toastsAfterClick = [], afterClick, globals = {} } = {}) {
  const state = { popup: null, toasts: [...toasts] };
  const buttons = popupButtons.map((t) => el(t, { onClick: () => (state.popup = null) }));
  const popup = { ...el(popupText, { classes: ['jd-message-box'] }), buttons };
  const saveBtn = el(actionLabel, {
    onClick: () => {
      if (showPopup) state.popup = popup;
      state.toasts.push(...toastsAfterClick);
      afterClick?.();
    },
  });
  const textOf = (e) => (e ? String(e.innerText || '').replace(/\s+/g, ' ').trim() : '');
  const util = {
    sleep: () => new Promise((r) => setTimeout(r, 1)),
    qsa: () => [],
    visible: () => true,
    textOf,
    waitFor: async (fn) => fn(),
    click: (e) => e.click(),
    visibleDialogs: () => (state.popup ? [state.popup] : []),
    messages: () => state.toasts,
    buttonByText: (label, root) => (root ? root.buttons : [saveBtn]).find((b) => textOf(b) === label) ?? null,
  };
  const backend = { __core: true, util, collectErrors: () => [], status: () => ({}) };
  const window = { __JDMOVE__: { backend } };
  vm.runInNewContext(MEDIA_SRC, { window, document: {}, location: { href: 'https://wares-jdm.jd.com/popPublish/?a=1' }, ...globals });
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

test('runAction: 点击前就在的“批量设置成功”提示不算保存成功（之前因此误报成功并立刻关掉了标签页）', async () => {
  const { B } = loadPage('', [], '保存草稿', { toasts: ['批量设置成功'], showPopup: false });
  const res = await B.runAction('draft', { timeoutMs: 50 });
  assert.equal(res.ok, false);
});

test('runAction: 只有“保存成功”这类结果提示才算成功，其它带“成功”字样的提示不算', async () => {
  const { B } = loadPage('', [], '保存草稿', { showPopup: false, toastsAfterClick: ['上传成功'] });
  const res = await B.runAction('draft', { timeoutMs: 50 });
  assert.equal(res.ok, false);
});

test('runAction: 点击后新出现的“保存成功”提示算成功', async () => {
  const { B } = loadPage('', [], '保存草稿', { toasts: ['批量设置成功'], showPopup: false, toastsAfterClick: ['保存成功'] });
  const res = await B.runAction('draft', { timeoutMs: 50 });
  assert.equal(res.ok, true);
});

test('runAction: auto（改价）在编辑页上找“保存”类按钮点击，成功弹窗按成功处理', async () => {
  const { B, buttons } = loadPage('保存成功', ['我知道了'], '保存');
  const res = await B.runAction('auto');
  assert.equal(res.ok, true);
  assert.equal(buttons[0].clicks, 1);
  assert.deepEqual([...res.wareIds], []);
});

test('runAction: auto 找不到提交/保存按钮时不乱点其他按钮', async () => {
  const { B } = loadPage('保存成功', ['我知道了'], '提交并上架');
  const res = await B.runAction('auto');
  assert.equal(res.ok, false);
  assert.match(res.error, /找不到“提交”或“保存”/);
});

/** 最小 XHR 替身：send 后立即以 responseText 触发 load */
function fakeXhrClass(responseText, responseURL = 'https://wares-jdm.jd.com/dsm/other') {
  return class FakeXhr {
    constructor() {
      this.listeners = [];
      this.responseText = responseText;
      this.responseURL = responseURL;
    }
    addEventListener(type, fn) {
      if (type === 'load') this.listeners.push(fn);
    }
    send() {
      this.listeners.forEach((fn) => fn());
    }
  };
}

test('runAction: 记下点击后提交接口返回的店铺商品编号，结束后恢复页面原来的 XHR', async () => {
  const Xhr = fakeXhrClass('{"code":200,"data":{"wareId":10088812345}}');
  const originalSend = Xhr.prototype.send;
  const { B } = loadPage('保存成功', ['我知道了'], '提交并上架', {
    globals: { XMLHttpRequest: Xhr },
    afterClick: () => new Xhr().send(),
  });
  const res = await B.runAction('submit_on');
  assert.equal(res.ok, true);
  assert.deepEqual([...res.wareIds], ['10088812345']);
  assert.equal(Xhr.prototype.send, originalSend);
});

const SAVE_URL = 'https://wares-jdm.jd.com/dsm/dsm.wareshop.product.writeservice.saveproduct';

test('runAction: 提交并上架后京麦直接跳转成功页、不弹提示：以提交接口返回的 productId 判定成功并记下编号', async () => {
  const Xhr = fakeXhrClass('{"code":200,"data":{"productId":10036327675342}}', SAVE_URL);
  const { B } = loadPage('', [], '提交并上架', {
    showPopup: false,
    globals: { XMLHttpRequest: Xhr },
    afterClick: () => new Xhr().send(),
  });
  const res = await B.runAction('submit_on', { timeoutMs: 5000 });
  assert.equal(res.ok, true);
  assert.deepEqual([...res.wareIds], ['10036327675342']);
  assert.match(res.messages.join(), /提交成功/);
});

test('runAction: 其他接口里的 productId（如标准产品编号）不当作新商品编号', async () => {
  const Xhr = fakeXhrClass('{"data":{"productId":123456789}}');
  const { B } = loadPage('', [], '提交并上架', {
    showPopup: false,
    globals: { XMLHttpRequest: Xhr },
    afterClick: () => new Xhr().send(),
  });
  const res = await B.runAction('submit_on', { timeoutMs: 50 });
  assert.equal(res.ok, false);
  assert.deepEqual([...res.wareIds], []);
});

test('runAction: 提交接口没有返回商品编号（提交失败）时不算成功', async () => {
  const Xhr = fakeXhrClass('{"code":500,"message":"类目需缴纳保证金"}', SAVE_URL);
  const { B } = loadPage('', [], '提交并上架', {
    showPopup: false,
    globals: { XMLHttpRequest: Xhr },
    afterClick: () => new Xhr().send(),
  });
  const res = await B.runAction('submit_on', { timeoutMs: 50 });
  assert.equal(res.ok, false);
});

test('runAction: 按钮叫“提交审核并上架”时也能点到', async () => {
  const { B } = loadPage('提交成功', ['我知道了'], '提交审核并上架');
  const res = await B.runAction('submit_on');
  assert.equal(res.ok, true);
});

test('runAction: 提交接口返回了 productId 但标着错误码时不算成功', async () => {
  const Xhr = fakeXhrClass('{"code":500,"success":false,"data":{"productId":123456789}}', SAVE_URL);
  const { B } = loadPage('', [], '提交并上架', {
    showPopup: false,
    globals: { XMLHttpRequest: Xhr },
    afterClick: () => new Xhr().send(),
  });
  const res = await B.runAction('submit_on', { timeoutMs: 50 });
  assert.equal(res.ok, false);
});

test('runAction: 保存草稿时提交接口返回的编号不当作店铺编号，仍按“保存成功”弹窗判断', async () => {
  const Xhr = fakeXhrClass('{"code":200,"data":{"productId":10036327675342}}', SAVE_URL);
  const { B, buttons } = loadPage('保存成功', ['我知道了'], '保存草稿', {
    globals: { XMLHttpRequest: Xhr },
    afterClick: () => new Xhr().send(),
  });
  const res = await B.runAction('draft');
  assert.equal(res.ok, true);
  assert.equal(buttons[0].clicks, 1, '仍点掉保存成功弹窗');
  assert.deepEqual([...res.wareIds], []);
});

const THROTTLED_BODY =
  '{"msg":"操作过于频繁，请稍后再试 2026-10-23 00:21:36","code":201,"dsm-trace-id":"5513108.41661.17926860967607905","bCode":"10003"}';
const SAVE_NEW_URL = 'https://sff.jd.com/api?v=1.0&api=dsm.productbff.product.warePublishPageSaveProductService.saveProductNew';

test('runAction: 带回点击后提交接口的原始返回（限流时 bCode 10003），不算成功', async () => {
  const Xhr = fakeXhrClass(THROTTLED_BODY, SAVE_NEW_URL);
  const { B } = loadPage('', [], '提交并上架', {
    showPopup: false,
    globals: { XMLHttpRequest: Xhr },
    afterClick: () => new Xhr().send(),
  });
  const res = await B.runAction('submit_on', { timeoutMs: 50 });
  assert.equal(res.ok, false);
  assert.deepEqual([...res.saveResponses], [THROTTLED_BODY]);
});

test('runAction: 提交接口已返回失败、页面没有弹提示时，不再等满超时', async () => {
  const Xhr = fakeXhrClass(THROTTLED_BODY, SAVE_NEW_URL);
  const { B } = loadPage('', [], '提交并上架', {
    showPopup: false,
    globals: { XMLHttpRequest: Xhr },
    afterClick: () => new Xhr().send(),
  });
  const started = Date.now();
  const res = await B.runAction('submit_on', { timeoutMs: 8000 });
  assert.equal(res.ok, false);
  assert.ok(Date.now() - started < 4000, `等了 ${Date.now() - started}ms`);
});

test('runAction: 其他接口的返回不算提交接口的返回', async () => {
  const Xhr = fakeXhrClass('{"code":200,"msg":"成功"}');
  const { B } = loadPage('', [], '提交并上架', {
    showPopup: false,
    globals: { XMLHttpRequest: Xhr },
    afterClick: () => new Xhr().send(),
  });
  const res = await B.runAction('submit_on', { timeoutMs: 50 });
  assert.deepEqual([...res.saveResponses], []);
});

test('runAction: 提交接口返回成功但没带编号时，仍等页面的“保存成功”提示（改价编辑页）', async () => {
  const Xhr = fakeXhrClass('{"code":200,"msg":"成功","data":true}', SAVE_NEW_URL);
  let page;
  page = loadPage('', [], '保存', {
    showPopup: false,
    globals: { XMLHttpRequest: Xhr },
    afterClick: () => {
      new Xhr().send();
      setTimeout(() => page.state.toasts.push('保存成功'), 1500);
    },
  });
  const res = await page.B.runAction('auto', { timeoutMs: 5000 });
  assert.equal(res.ok, true);
});

test('runAction: 提交接口的成功返回不带 code 200 时（如 success:true），仍等页面提示，不提前结束', async () => {
  const Xhr = fakeXhrClass('{"success":true,"msg":"成功","data":true}', SAVE_NEW_URL);
  let page;
  page = loadPage('', [], '保存', {
    showPopup: false,
    globals: { XMLHttpRequest: Xhr },
    afterClick: () => {
      new Xhr().send();
      setTimeout(() => page.state.toasts.push('保存成功'), 1500);
    },
  });
  const res = await page.B.runAction('auto', { timeoutMs: 5000 });
  assert.equal(res.ok, true);
});

test('runAction: 提交接口返回失败、页面没弹提示时，把接口返回的错误文字带回来', async () => {
  const Xhr = fakeXhrClass('{"code":500,"msg":"类目需缴纳保证金"}', SAVE_NEW_URL);
  const { B } = loadPage('', [], '提交并上架', {
    showPopup: false,
    globals: { XMLHttpRequest: Xhr },
    afterClick: () => new Xhr().send(),
  });
  const res = await B.runAction('submit_on', { timeoutMs: 5000 });
  assert.equal(res.ok, false);
  assert.ok(res.messages.includes('类目需缴纳保证金'), res.messages.join());
});
