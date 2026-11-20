// VC 发布页“发布商品”/“保存草稿”（backend-media.js 的 runAction）：按接口返回或页面提示判断结果
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

/** 模拟 VC 发布页：点“保存草稿”后弹出 { 保存成功 … 我知道了 } */
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
  const backend = { __core: true, util, collectErrors: () => [], pinia: () => null };
  const window = { __JDMOVE__: { backend } };
  vm.runInNewContext(MEDIA_SRC, { window, document: {}, location: { href: 'https://wares-jdm.jd.com/vcProductPublish/?bId=17519&categoryId=31403' }, ...globals });
  return { B: backend, buttons, state };
}

test('runAction: 保存草稿后的“保存成功”弹窗自动点“我知道了”，按成功处理', async () => {
  const { B, buttons, state } = loadPage('保存成功 请前往商品管理-草稿箱中查看编辑，商品发布且审核通过后可进行售卖。', ['我知道了']);
  const res = await B.runAction('vc_draft');
  assert.equal(res.ok, true);
  assert.equal(res.confirmText, '');
  assert.equal(buttons[0].clicks, 1);
  assert.equal(state.popup, null);
});

test('runAction: 只支持“发布商品”和“保存草稿”，找不到按钮时说明', async () => {
  const { B } = loadPage('保存成功', ['我知道了'], '发布商品');
  for (const action of ['submit_on', 'auto']) {
    const res = await B.runAction(action);
    assert.equal(res.ok, false);
    assert.match(res.error, /不支持的操作/);
  }
  const missing = await B.runAction('vc_draft');
  assert.match(missing.error, /找不到“保存草稿”按钮/);
  const other = loadPage('保存成功', ['我知道了'], '保存草稿');
  assert.match((await other.B.runAction('vc_publish')).error, /找不到“发布商品”按钮/);
});

test('runAction: 确认框有“确定”时点掉继续等结果；草稿箱满（只有“继续保存”）时不点，交给人工', async () => {
  const ok = loadPage('提示 确认保存草稿吗？', ['取消', '确定']);
  const res = await ok.B.runAction('vc_draft', { timeoutMs: 50 });
  assert.equal(ok.buttons[1].clicks, 1);
  assert.match(res.confirmText, /确认保存/);

  const full = loadPage('提示 草稿箱已满，继续保存将删除最早的一条草稿', ['取消', '继续保存']);
  const res2 = await full.B.runAction('vc_draft', { timeoutMs: 50 });
  assert.equal(res2.ok, false);
  assert.match(res2.confirmText, /草稿箱已满/);
  assert.deepEqual(full.buttons.map((b) => b.clicks), [0, 0]);
});

test('runAction: 点击前就在的“批量设置成功”提示不算保存成功', async () => {
  const { B } = loadPage('', [], '保存草稿', { toasts: ['批量设置成功'], showPopup: false });
  const res = await B.runAction('vc_draft', { timeoutMs: 50 });
  assert.equal(res.ok, false);
  assert.match(res.messages.join(), /没有看到保存结果/);
});

test('runAction: 只有“保存成功”这类结果提示才算成功，其它带“成功”字样的提示不算', async () => {
  const { B } = loadPage('', [], '保存草稿', { showPopup: false, toastsAfterClick: ['上传成功'] });
  const res = await B.runAction('vc_draft', { timeoutMs: 50 });
  assert.equal(res.ok, false);
});

test('runAction: 点击后新出现的“保存成功”提示算成功', async () => {
  const { B } = loadPage('', [], '保存草稿', { toasts: ['批量设置成功'], showPopup: false, toastsAfterClick: ['保存成功'] });
  const res = await B.runAction('vc_draft', { timeoutMs: 50 });
  assert.equal(res.ok, true);
});

/** 最小 XHR 替身：send 后立即以 responseText 触发 load */
function fakeXhrClass(responseText, responseURL) {
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

const DRAFT_URL = 'https://sff.jd.com/api?v=1.0&appId=XXX&api=dsm.productbff.product.draft.saveDraftNew';
const draftPage = (body, url = DRAFT_URL) => {
  const Xhr = fakeXhrClass(body, url);
  const page = loadPage('', [], '保存草稿', { showPopup: false, globals: { XMLHttpRequest: Xhr }, afterClick: () => new Xhr().send() });
  return { ...page, Xhr };
};

test('runAction: 保存草稿接口返回草稿编号时算成功（不等页面跳到草稿箱），结束后恢复页面原来的 XHR', async () => {
  const { B, Xhr } = draftPage('{"code":200,"data":{"draftId":414309950}}');
  const originalSend = Xhr.prototype.send;
  const res = await B.runAction('vc_draft', { timeoutMs: 5000 });
  assert.equal(res.ok, true);
  assert.equal(res.draftId, '414309950');
  assert.deepEqual([...res.messages], ['草稿已保存']);
  assert.equal(Xhr.prototype.send, originalSend);
});

test('runAction: 保存草稿接口拒收（[456] 无效的字符串）时不算成功，带出接口原文', async () => {
  const body = '{"code":456,"msg":"无效的字符串，请核对后再试 [456]"}';
  const { B } = draftPage(body);
  const res = await B.runAction('vc_draft', { timeoutMs: 5000 });
  assert.equal(res.ok, false);
  assert.match(res.messages.join(), /保存草稿失败：无效的字符串，请核对后再试 \[456\]/);
  assert.deepEqual([...res.saveResponses], [body]);
});

test('runAction: 限流（bCode 10003）的原始返回带回扩展侧，用来判断整批暂停', async () => {
  const body = '{"msg":"操作过于频繁，请稍后再试","code":201,"bCode":"10003"}';
  const { B } = draftPage(body);
  const res = await B.runAction('vc_draft', { timeoutMs: 5000 });
  assert.equal(res.ok, false);
  assert.deepEqual([...res.saveResponses], [body]);
});

test('runAction: 其他接口的返回不当作保存草稿的结果', async () => {
  const { B } = draftPage('{"code":200,"data":{"draftId":414309950}}', 'https://sff.jd.com/api?api=dsm.productbff.other');
  const res = await B.runAction('vc_draft', { timeoutMs: 50 });
  assert.equal(res.ok, false);
  assert.equal(res.draftId, undefined);
});

// 发布商品：“发布商品”按钮的真实请求是 sff.jd.com/api?…&api=<接口名>。
// 2026-11-20 实测成功返回（tests/fixtures/vc-save-product-new.json）：skuList/productId/skuIdList 都是 null，只有 applyId（32 位十六进制）和 version（服务器时间）
const PUBLISH_URL = 'https://sff.jd.com/api?v=1.0&appId=XXX&api=dsm.productbff.product.warePublishPageSaveProductService.saveProductNew';
const REAL_PUBLISH_OK = readFileSync(new URL('./fixtures/vc-save-product-new.json', import.meta.url), 'utf8').trim();
// 万一京东以后在返回里带上 SKU：照样取
const PUBLISH_WITH_SKUS = '{"code":200,"data":{"productId":10023456789,"applyId":"ab12cd34ef","skuList":[{"uuid":"a1","skuId":100200300401},{"uuid":"a2","skuId":"100200300402"}]}}';
/** 极简 sessionStorage */
function fakeSessionStorage() {
  const map = new Map();
  return { map, getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)), removeItem: (k) => map.delete(k) };
}
const publishPage = (response, { url = PUBLISH_URL, sessionStorage } = {}) => {
  const Xhr = fakeXhrClass(response, url);
  const globals = sessionStorage ? { XMLHttpRequest: Xhr, sessionStorage } : { XMLHttpRequest: Xhr };
  const page = loadPage('', [], '发布商品', { showPopup: false, globals, afterClick: () => new Xhr().send() });
  return { ...page, Xhr };
};

test('runAction: 真实的发布返回（没有 SKU，只有 applyId）算发布成功，带回申请单号和服务器时间，结束后恢复页面原来的 XHR', async () => {
  const { B, Xhr } = publishPage(REAL_PUBLISH_OK);
  const originalSend = Xhr.prototype.send;
  const res = await B.runAction('vc_publish', { timeoutMs: 5000 });
  assert.equal(res.ok, true);
  assert.equal(res.unconfirmed, false);
  assert.equal(res.applyId, '0f0a48ac54454bbe96361b7b0e291030');
  assert.equal(res.serverTime, 1795149004157);
  assert.deepEqual([...res.skuIds], []);
  assert.equal(res.productId, '');
  assert.match(res.messages.join(), /商品已发布（申请单 0f0a48ac54454bbe96361b7b0e291030，SKU 待从商品审核列表取回）/);
  assert.equal(Xhr.prototype.send, originalSend);
});

test('runAction: 发布结果另存到 sessionStorage，带上这次的 nonce（页面跳走后扩展凭它读回）', async () => {
  const store = fakeSessionStorage();
  store.setItem('__jdmove_publish__', JSON.stringify({ nonce: 'old', applyId: 'stale' }));
  const res = await publishPage(REAL_PUBLISH_OK, { sessionStorage: store }).B.runAction('vc_publish', { timeoutMs: 5000, nonce: 'n-1' });
  assert.equal(res.ok, true);
  const mark = JSON.parse(store.getItem('__jdmove_publish__'));
  assert.equal(mark.nonce, 'n-1');
  assert.equal(mark.applyId, '0f0a48ac54454bbe96361b7b0e291030');
  assert.equal(mark.serverTime, 1795149004157);
  assert.equal(mark.failure, null);
});

test('runAction: 返回里带了 skuList / skuIdList 时照样取 SKU', async () => {
  const res = await publishPage(PUBLISH_WITH_SKUS).B.runAction('vc_publish', { timeoutMs: 5000 });
  assert.equal(res.ok, true);
  assert.deepEqual([...res.skuIds], ['100200300401', '100200300402']);
  assert.equal(res.productId, '10023456789');
  assert.equal(res.applyId, 'ab12cd34ef');
  assert.match(res.messages.join(), /商品已发布（商品编号 10023456789，申请单 ab12cd34ef，SKU 100200300401、100200300402）/);
  const list = await publishPage('{"code":200,"data":{"applyId":"x1y2z3","skuIdList":[100200300401]}}').B.runAction('vc_publish', { timeoutMs: 5000 });
  assert.deepEqual([...list.skuIds], ['100200300401']);
});

test('runAction: 业务码不是 200 的返回里带了 applyId 也不算发布成功', async () => {
  const res = await publishPage('{"code":201,"msg":"商品信息有误","data":{"applyId":"0f0a48ac54454bbe96361b7b0e291030"}}').B.runAction('vc_publish', { timeoutMs: 5000 });
  assert.equal(res.ok, false);
  assert.equal(res.applyId, '');
});

test('runAction: 既没有申请单号也没有商品编号、SKU 时不算成功，交给调用方按落地页确认', async () => {
  const empty = await publishPage('{"code":200,"data":null}').B.runAction('vc_publish', { timeoutMs: 5000 });
  assert.equal(empty.ok, false);
  assert.match(empty.messages.join(), /发布接口没有返回商品编号/);
  assert.equal(empty.unconfirmed, true);
});

test('runAction: 编号包在多层 data/result 里时按键名深搜取到', async () => {
  const body = '{"code":200,"data":{"result":{"productId":10023456789,"skuList":[{"skuId":100200300401}]}}}';
  const res = await publishPage(body).B.runAction('vc_publish', { timeoutMs: 5000 });
  assert.equal(res.ok, true);
  assert.equal(res.productId, '10023456789');
  assert.deepEqual([...res.skuIds], ['100200300401']);
});

test('runAction: 发布接口失败（限流 bCode 10003）时不算成功，原始返回带回扩展侧', async () => {
  const body = '{"msg":"操作过于频繁，请稍后再试","code":201,"bCode":"10003"}';
  const res = await publishPage(body).B.runAction('vc_publish', { timeoutMs: 5000 });
  assert.equal(res.ok, false);
  assert.deepEqual([...res.skuIds], []);
  assert.match(res.messages.join(), /发布商品失败：操作过于频繁/);
  assert.deepEqual([...res.saveResponses], [body]);
});

test('runAction: 发布时草稿接口、saveProductNewV2 和其他接口的返回都不当作发布结果', async () => {
  for (const url of [DRAFT_URL, `${PUBLISH_URL}V2`, 'https://sff.jd.com/api?api=dsm.productbff.other']) {
    const res = await publishPage(REAL_PUBLISH_OK, { url }).B.runAction('vc_publish', { timeoutMs: 50 });
    assert.equal(res.ok, false, url);
    assert.equal(res.skuIds, undefined, url);
  }
});

test('runAction: 发布前的“确认发布”框自动点确定；不认识的确认框不点，交给人工', async () => {
  const Xhr = fakeXhrClass(REAL_PUBLISH_OK, PUBLISH_URL);
  const confirm = loadPage('提示 确认发布该商品吗？', ['取消', '确定'], '发布商品', { globals: { XMLHttpRequest: Xhr } });
  confirm.buttons[1].click = function click() {
    this.clicks += 1;
    confirm.state.popup = null;
    new Xhr().send();
  };
  const ok = await confirm.B.runAction('vc_publish', { timeoutMs: 5000 });
  assert.equal(ok.ok, true);
  assert.equal(ok.applyId, '0f0a48ac54454bbe96361b7b0e291030');

  const unknown = loadPage('提示 商品条形码已存在，是否继续？', ['取消', '确定'], '发布商品');
  const res = await unknown.B.runAction('vc_publish', { timeoutMs: 5000 });
  assert.equal(res.ok, false);
  assert.match(res.confirmText, /条形码已存在/);
  assert.equal(unknown.buttons[1].clicks, 0);
});
