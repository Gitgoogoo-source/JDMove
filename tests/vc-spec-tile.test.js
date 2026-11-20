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
    buttonByText: () => null,
  };
  const backend = {
    __vc: true,
    util,
    mediaUtil: { commitInput: (n, v) => (n.value = v) },
    vcUtil: { vcSkuRows: () => [page.tr], cellOf: () => null },
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
