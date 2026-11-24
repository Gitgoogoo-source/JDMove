// VC 发布页 SKU 表的“规格”列有两种：抽屉（SaleDrawer，抽纸）和行内平铺（SaleTile，湿厕纸/卷纸）。
// 2026-11-20 实测湿厕纸：规格格子里直接是三个框——产品描述、“请设置”（点开是 单包数量[片/抽/节] × 包装规格[包/提/卷…] 弹层，必填）、备注；
// 字段没有 .shop-dynamic-component-title 标题。以前只找抽屉，找不到就跳过，发布时页面报“请填写规格”
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { el, input } from './helpers/mini-dom.js';

const SRC = readFileSync(new URL('../src/inject/backend-vc-drawer.js', import.meta.url), 'utf8');

/** 旧版单位下拉：点输入框展开选项，点选项写进输入框并收起 */
function unitSelect(options) {
  const box = input('单位', { readOnly: true });
  const list = el('ul.jd-select-dropdown__list', { shown: false });
  options.forEach((o) => list.append(el('li.jd-select-dropdown__item', { ownText: o, onClick: () => ((box.value = o), (list.shown = false)) })));
  box.onClick = () => (list.shown = !list.shown);
  return el('div.jd-select.select-box', {}, [box, list]);
}

const numberUnits = (placeholder, options) =>
  el('div.shop-dynamic-component', {}, [el('div.shop-form-item-tips', {}, [el('div.sale-number-units', {}, [input(placeholder), unitSelect(options)])])]);

const notes = (placeholder) => el('div.shop-dynamic-component', {}, [el('div.shop-form-item-tips', {}, [el('div.sale-custom-notes', {}, [input(placeholder)])])]);

const skuField = (title, control) => el('div.shop-dynamic-component', {}, [
  el('div.shop-dynamic-component-title.is-required-star', { ownText: title }), control,
]);

function skuDrawer(fields, preceding = []) {
  const drawer = el('div.jd-drawer', { shown: false }, [
    ...fields,
    el('button', { ownText: '确定', onClick: () => { drawer.shown = false; } }),
  ]);
  const drawerTrigger = el('button', { onClick: () => { drawer.shown = true; } });
  const tr = el('tr', {}, [el('td', {}, [drawerTrigger])]);
  return { body: el('body', {}, [...preceding, tr, drawer]), tr, drawerTrigger };
}

/** 京麦新版单选：实际选中的文字在 placeholder 节点里，搜索框始终为空。 */
function nativeSelect(options, selected = '') {
  const popup = el('div.jd-select-v2__popper', { shown: false });
  const combo = el('input.jd-select-v2__combobox-input', {
    getAttribute: (key) => key === 'aria-expanded' ? String(popup.shown) : null,
  });
  const display = el('span.jd-select-v2__placeholder');
  function choose(label) {
    display.ownText = label || '请选择';
    if (label) display.classList.add('is-has-model-value');
    popup.shown = false;
  }
  choose(selected);
  const wrapper = el('div.jd-select-v2__wrapper', { onClick: () => { popup.shown = !popup.shown; } }, [combo, display]);
  options.forEach((label) => popup.append(el('li.jd-select-dropdown__option-item', { ownText: label, onClick: () => choose(label) })));
  return el('div.jd-select-v2.adv-select-native', {}, [wrapper, popup]);
}

/** 湿厕纸的规格格子 + “请设置”的弹层；弹层两组都填好后“请设置”框显示组合值（页面：信息全部补充后才会应用） */
function wetWipePage() {
  const pop = el('div.jd-popper', { shown: false }, [
    el('div.group-popper', {}, [numberUnits('单包数量', ['片', '抽', '节']), el('div.shop-dynamic-component', { ownText: '*' }), numberUnits('包装规格', ['包', '提', '卷', '桶', '袋', '盒'])]),
  ]);
  const inner = pop.querySelectorAll('.sale-number-units input');
  const trigger = input('请设置', { readOnly: true, onClick: () => (pop.shown = true) });
  Object.defineProperty(trigger, 'value', {
    get: () => (inner.every((i) => i.value) ? `${inner[0].value}${inner[1].value}*${inner[2].value}${inner[3].value}` : ''),
    set: () => {},
  });
  const group = el('div.shop-dynamic-component', { onClick: () => (pop.shown = false) }, [el('div.shop-form-item-tips', {}, [el('div.sale-base-group', {}, [trigger])])]);
  const desc = notes('产品描述');
  const remark = notes('备注');
  const tile = el('div.sale-tile', {}, [desc, group, remark]);
  const tr = el('tr', {}, [el('td', {}, [el('div.sale-dimension-container', {}, [el('div.content', {}, [el('div.formal-spec', {}, [el('div.content-item', {}, [tile])])])])]), el('td', {}, [input('请输入商品条形码')])]);
  const body = el('body', {}, [el('table', {}, [tr]), pop]);
  return { body, tr, trigger, desc: desc.querySelector('input'), remark: remark.querySelector('input') };
}

function load(page) {
  const util = {
    sleep: async () => {},
    qsa: (sel, root = page.body) => root.querySelectorAll(sel),
    visible: (n) => !!(n && n.offsetParent),
    textOf: (n) => (n ? String(n.textContent).replace(/\s+/g, ' ').trim() : ''),
    norm: (s) => String(s ?? '').toLowerCase().replace(/[\s:：,，()（）\[\]【】*＊/、\-_.]/g, ''),
    waitFor: async (fn) => {
      for (let i = 0; i < 5; i += 1) {
        const v = fn();
        if (v) return v;
      }
      return null;
    },
    setNativeValue: (n, v) => (n.value = v),
    click: (n) => n.click(),
    buttonByText: (label, root) => root.querySelectorAll('button').find((b) => b.textContent === label),
  };
  const backend = {
    __vc: true,
    util,
    mediaUtil: { commitInput: (n, v) => (n.value = v) },
    vcUtil: { vcSkuRows: () => [page.tr], cellOf: () => page.drawerTrigger ?? null },
  };
  class Ev {}
  vm.runInNewContext(SRC, { window: { __JDMOVE__: { backend } }, document: page.body, MouseEvent: Ev, KeyboardEvent: Ev });
  return backend;
}

const WET_WIPE_PLAN = { values: { 香型: '无香型', 包装形式: '箱装' }, units: { 片: '80', 包: '6' }, desc: '王牌爆款' };

test('vcFillSpec：行内规格（湿厕纸）按单位填好 单包数量 × 包装规格，产品描述写规格描述', async () => {
  const page = wetWipePage();
  const res = await load(page).vcFillSpec(WET_WIPE_PLAN);
  assert.equal(page.trigger.value, '80片*6包');
  assert.equal(page.desc.value, '王牌爆款');
  assert.equal(res.confirmed, true);
  assert.deepEqual([...res.missing], []);
  assert.deepEqual([...res.filled].sort(), ['产品描述', '规格'].sort());
});

test('vcFillSpec：行内规格的“备注”不拿规格描述去填', async () => {
  const page = wetWipePage();
  await load(page).vcFillSpec(WET_WIPE_PLAN);
  assert.equal(page.remark.value, '');
});

test('vcFillSpec：行内规格的必填组合填不上（规格里没有对应单位）时不算填好，列出缺的“规格”', async () => {
  const page = wetWipePage();
  const res = await load(page).vcFillSpec({ values: {}, units: { 卷: '12' }, desc: '' });
  assert.equal(page.trigger.value, '');
  assert.equal(res.confirmed, false);
  assert.deepEqual([...res.missing], ['规格']);
});

test('vcFillSpec：既没有抽屉也没有行内规格时报“找不到单元格”', async () => {
  const page = wetWipePage();
  page.tr.children[0].children = [];
  const res = await load(page).vcFillSpec(WET_WIPE_PLAN);
  assert.equal(res.opened, false);
  assert.deepEqual([...res.errors], ['找不到单元格']);
});

test('SKU抽屉的总净含量区间和精确数值分别填写，包装规格切换到实际容器', async () => {
  const field = (title, control) => el('div.shop-dynamic-component', {}, [
    el('div.shop-dynamic-component-title.is-required-star', { ownText: title }), control,
  ]);
  const volume = el('div.sale-number-units', {}, [input('输入数值'), unitSelect(['mL', 'L'])]);
  const ranges = unitSelect(['0-1L', '1.01-3L']);
  const pack = input('请设置', { readOnly: true });
  const count = input('输入数值');
  const containerUnit = unitSelect(['瓶', '桶']);
  containerUnit.querySelector('input').value = '瓶';
  const pop = el('div.jd-popper', { shown: false }, [count, containerUnit, el('button', {
    ownText: '确定', onClick: () => { pack.value = count.value + containerUnit.querySelector('input').value; pop.shown = false; },
  })]);
  pack.onClick = () => { pop.shown = !pop.shown; };
  const drawer = el('div.jd-drawer', { shown: false }, [
    field('总净含量', ranges), field('包装规格', pack), field('总净含量', volume),
    el('button', { ownText: '确定', onClick: () => { drawer.shown = false; } }),
  ]);
  const drawerTrigger = el('button', { onClick: () => { drawer.shown = true; } });
  const tr = el('tr', {}, [el('td', {}, [drawerTrigger])]);
  const body = el('body', {}, [tr, drawer, pop]);
  const values = { 总净含量: '900mL', 包装规格: '1桶' };
  const res = await load({ body, tr, drawerTrigger }).vcFillSkuAttrs({
    values, quantityFields: { select: { 总净含量: '0-1L' }, numbers: values },
  });
  assert.equal(res.confirmed, true);
  assert.equal(ranges.querySelector('input').value, '0-1L');
  assert.equal(pack.value, '1桶');
  assert.deepEqual(volume.querySelectorAll('input').map((i) => i.value), ['900', 'mL']);
});

test('香皂 SKU 使用各自的新版下拉填写已采集的必填项', async () => {
  const shape = nativeSelect(['固体', '液体', '果冻']);
  const license = nativeSelect(['消字号', '非消字号'], '消字号');
  const spec = nativeSelect(['单品', '套装', '小样']);
  // 页面上另一个还未收起的下拉有同名选项，不能点到它。
  const otherPopup = el('div.jd-select-v2__popper', {}, [el('li.jd-select-dropdown__option-item', { ownText: '固体' })]);
  const page = skuDrawer([skuField('形态', shape), skuField('是否消字号商品', license), skuField('规格类型', spec)], [otherPopup]);
  const res = await load(page).vcFillSkuAttrs({ values: { 形态: '固体', 是否消字号商品: '非消字号', 规格类型: '单品' } });
  assert.equal(res.confirmed, true);
  assert.deepEqual([...res.missing], []);
  assert.deepEqual([shape, license, spec].map((box) => box.querySelector('.is-has-model-value')?.textContent), ['固体', '非消字号', '单品']);
});

test('SKU 新版下拉通过组件的选中标记判断必填项，搜索框为空也可以提交', async () => {
  const filled = nativeSelect(['固体', '液体'], '固体');
  const page = skuDrawer([skuField('形态', filled)]);
  const res = await load(page).vcFillSkuAttrs({});
  assert.equal(res.confirmed, true);
  assert.deepEqual([...res.missing], []);

  const blank = skuDrawer([skuField('形态', nativeSelect(['固体', '液体']))]);
  const blankRes = await load(blank).vcFillSkuAttrs({});
  assert.equal(blankRes.confirmed, false);
  assert.deepEqual([...blankRes.missing], ['形态']);
});
