// VC 发布页“图片信息识别”的“+”菜单：发布页不在前台时悬停不一定能把菜单显示出来，
// 这时要直接点隐藏的“图片空间”（菜单常驻 DOM，点隐藏的菜单项照样打开图片空间，2026-11-08 实测）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SRC = readFileSync(new URL('../src/inject/backend-vc-images.js', import.meta.url), 'utf8');

/** 叶子节点：shown=false 表示菜单隐藏（display:none） */
const leaf = (text, shown) => ({ text, shown, children: [] });

function popper(entries) {
  return { classList: { contains: (c) => c === 'jd-popper' }, all: entries, children: entries };
}

/** “+” → JdOnlyChild → … → JdTooltip，JdTooltip 的渲染树里有 .jd-popper（真实页面的组件链） */
function plusWithTooltip(pop) {
  const tooltip = {
    type: { name: 'JdTooltip' },
    parent: null,
    subTree: { children: [{ component: { subTree: { el: { classList: { contains: () => false } }, children: [{ el: pop }] } } }] },
  };
  const trigger = { type: { name: 'JdTooltipTrigger' }, parent: { type: { name: 'JdPopper' }, parent: tooltip } };
  return { __vueParentComponent: { type: { name: 'JdOnlyChild' }, parent: trigger } };
}

function load(poppers) {
  const util = {
    sleep: async () => {},
    qsa: (sel, root) => (sel === '*' ? root.all : sel === '.jd-popper *' ? poppers.flatMap((p) => p.all) : []),
    visible: (el) => Boolean(el && el.shown),
    textOf: (el) => (el ? el.text : ''),
    waitFor: async (fn) => fn() || null,
    click() {},
    buttonByText: () => null,
    messages: () => [],
    setNativeValue() {},
  };
  const backend = { __vc: true, util, mediaUtil: {}, vcUtil: { aiRecState: () => null } };
  const ctx = { window: { __JDMOVE__: { backend } } };
  vm.runInNewContext(SRC, ctx);
  return backend.vcImagesUtil;
}

test('aiRecMenuEntry: 菜单没显示时返回“+”自己弹层里隐藏的“图片空间”', () => {
  const entry = leaf('图片空间', false);
  const own = popper([leaf('本地上传', false), entry, leaf('截图上传', false)]);
  const { aiRecMenuEntry } = load([own]);
  const found = aiRecMenuEntry(plusWithTooltip(own));
  assert.equal(found.entry, entry);
  assert.equal(found.shown, false);
});

test('aiRecMenuEntry: 菜单显示时返回显示的那个', () => {
  const entry = leaf('图片空间', true);
  const own = popper([leaf('本地上传', true), entry]);
  const found = load([own]).aiRecMenuEntry(plusWithTooltip(own));
  assert.equal(found.entry, entry);
  assert.equal(found.shown, true);
});

test('aiRecMenuEntry: 找到“+”自己的弹层时，不点别的字段弹层里的同名菜单', () => {
  const other = popper([leaf('图片空间', true)]);
  const mine = leaf('图片空间', false);
  const own = popper([mine]);
  const found = load([other, own]).aiRecMenuEntry(plusWithTooltip(own));
  assert.equal(found.entry, mine);
});

test('aiRecMenuEntry: 组件链里没有 JdTooltip 时在页面所有弹层里找，优先显示的', () => {
  const hidden = leaf('图片空间', false);
  const shown = leaf('图片空间', true);
  const util = load([popper([hidden]), popper([shown])]);
  assert.equal(util.aiRecMenuEntry({}).entry, shown);
  assert.equal(load([popper([hidden])]).aiRecMenuEntry({}).entry, hidden);
});

test('aiRecMenuEntry: 没有“图片空间”菜单项时为 null；只匹配叶子节点的完整文字', () => {
  const wrapper = { text: '图片空间', shown: true, children: [leaf('图片空间xx', true)] };
  const own = popper([leaf('本地上传', true), wrapper, ...wrapper.children]);
  assert.equal(load([own]).aiRecMenuEntry(plusWithTooltip(own)), null);
});

test('tooltipPopper: “+”不在 Vue 组件里时为 null', () => {
  assert.equal(load([]).tooltipPopper({}), null);
  assert.equal(load([]).tooltipPopper(null), null);
});
