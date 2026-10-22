import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const CORE_SRC = readFileSync(new URL('../src/inject/backend-core.js', import.meta.url), 'utf8');

/**
 * 京麦的 jd-select（如品牌下拉框）：每次点击在“展开/收起”之间切换，Vue 在微任务里才把下拉层渲染出来；
 * 选项要等展开 optionsDelayMs 之后才出现（品牌列表加载慢）。opens=false 表示点了也打不开。
 * 定时器按后台标签页限流：每个 setTimeout 至少 1 秒（用虚拟时钟，测试不真的等待）
 */
function loadSelectPage({ optionsDelayMs = 0, opens = true } = {}) {
  let clock = 0;
  const state = { expanded: false, rendered: false, openedAt: 0, clicks: 0 };
  const shown = (el) => Object.assign(el, { isConnected: true, get offsetParent() { return state.rendered ? {} : null; }, getClientRects: () => (state.rendered ? [1] : []) });
  const popper = shown({});
  const item = { isConnected: true, get offsetParent() { return state.rendered && clock - state.openedAt >= optionsDelayMs ? {} : null; }, getClientRects() { return this.offsetParent ? [1] : []; } };
  const toggle = () => {
    state.clicks += 1;
    if (!opens) return;
    state.expanded = !state.expanded;
    if (state.expanded) state.openedAt = clock;
    queueMicrotask(() => {
      state.rendered = state.expanded;
    });
  };
  const target = () => ({ dispatchEvent: () => true, click: toggle });
  // 与京麦品牌字段一致：没有 .jd-select__wrapper
  const parts = { '.jd-input__wrapper': target(), '.select-trigger': target(), '.jd-input': target(), input: target() };
  const root = { querySelector: (sel) => parts[sel] ?? null };
  const body = { click() {} };
  const document = {
    body,
    activeElement: body,
    querySelector: () => null,
    querySelectorAll: (sel) => {
      if (sel === '.jd-select-dropdown__item') return [item];
      if (sel.includes('jd-select__popper')) return [popper];
      return [];
    },
  };
  class Ev {
    constructor(type) {
      this.type = type;
    }
  }
  const window = { __JDMOVE__: {} };
  vm.runInNewContext(CORE_SRC, {
    window,
    document,
    location: { href: 'https://wares-jdm.jd.com/popPublish/', pathname: '/popPublish/' },
    HTMLInputElement: class {},
    HTMLTextAreaElement: class {},
    Event: Ev,
    MouseEvent: Ev,
    Date: { now: () => clock },
    setTimeout: (fn, ms) => {
      clock += Math.max(ms ?? 0, 1000);
      setImmediate(fn);
    },
    clearTimeout: () => {},
  });
  return { B: window.__JDMOVE__.backend, state, root };
}

test('waitFor: 定时器被限流、一次 sleep 就越过时限时，超时前最后再检查一次', async () => {
  const { B } = loadSelectPage();
  let ready = false;
  queueMicrotask(() => {
    ready = true;
  });
  assert.equal(await B.util.waitFor(() => ready, { timeout: 800, interval: 200 }), true);
  assert.equal(await B.util.waitFor(() => false, { timeout: 800 }), null);
});

test('openSelect: 后台标签页里第一次点击就打开了，不再点别处把下拉框关上（“品牌下拉框无法打开”）', async () => {
  const { B, state, root } = loadSelectPage();
  assert.equal(await B.util.openSelect(root), true);
  assert.equal(state.clicks, 1, '只点一次');
  assert.equal(state.expanded, true, '下拉框保持展开');
});

test('openSelect: 下拉层已弹出但品牌列表还没加载出来时等选项，不再点击', async () => {
  const { B, state, root } = loadSelectPage({ optionsDelayMs: 2500 });
  assert.equal(await B.util.openSelect(root), true);
  assert.equal(state.clicks, 1, '再点会把下拉框关上');
  assert.equal(state.expanded, true);
});

test('openSelect: 点了也打不开时如实返回 false', async () => {
  const { B, state, root } = loadSelectPage({ opens: false });
  assert.equal(await B.util.openSelect(root), false);
  assert.equal(state.clicks, 4, '每个入口都试过');
});
