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

/** 京麦的价格/库存输入框：只有失焦（blur）后值才进入表单数据 */
function input(placeholder, { sticky = true } = {}) {
  return {
    placeholder,
    value: '',
    committed: '',
    readOnly: false,
    isConnected: true,
    classList: { contains: () => false },
    dispatchEvent(e) {
      if (e.type === 'blur' && sticky) this.committed = this.value;
      if (e.type === 'blur' && !sticky) this.value = '';
      return true;
    },
  };
}

function skuRow(opts) {
  const price = input('请输入', opts);
  const stock = input('请输入', opts);
  const sw = { classList: { contains: (c) => c === 'is-checked' }, click() {} };
  return {
    price,
    stock,
    isConnected: true,
    scrollIntoView() {},
    querySelectorAll: (sel) => (sel === 'input[placeholder="请输入"]' ? [price, stock] : []),
    querySelector: (sel) => (sel === '.jd-switch' ? sw : null),
  };
}

/**
 * 京麦的销售属性维度：在末尾空输入框里录入后，值被挪到新渲染的输入框里成为“临时”值（末尾框保持为空），
 * 只有持有该值的输入框获得焦点后再失焦，才会转为正式值；合成的回车事件不会提交
 */
function saleDim(name, { commitOnBlur = true } = {}) {
  const modelValue = [];
  const container = { type: { name: 'SaleDimensionContainer' }, props: { modelValue } };
  const inputs = [];
  const newInput = (value = '') => ({
    placeholder: `请设置${name}`,
    value,
    focused: false,
    __vueParentComponent: { type: { name: 'JdInput' }, parent: container },
    click() {
      this.focused = true;
    },
    focus() {
      this.focused = true;
    },
    blur() {
      if (!this.focused) return;
      this.focused = false;
      const hit = modelValue.find((m) => m.attrValueAlias === this.value);
      if (hit && commitOnBlur) hit.specType = 'formal';
    },
    dispatchEvent: () => true,
  });
  const trailing = newInput();
  Object.defineProperty(trailing, 'value', {
    get: () => '',
    set: (v) => {
      if (!v) return;
      modelValue.push({ attrValueAlias: v, specType: 'temporary' });
      inputs.splice(inputs.length - 1, 0, newInput(v));
    },
  });
  inputs.push(trailing);
  return { inputs, modelValue };
}

function loadPage(rows, extraInputs = () => []) {
  const batchPrice = input('京东价(元)');
  const batchStock = input('库存');
  // 批量应用：把批量框里“已提交”的值写到每一行
  const applyBtn = {
    innerText: '批量应用',
    click() {
      for (const r of rows) {
        r.price.value = batchPrice.committed;
        r.stock.value = batchStock.committed;
      }
    },
  };
  const util = {
    sleep: () => Promise.resolve(),
    qsa: (sel, root) => (root ? Array.from(root.querySelectorAll(sel)) : sel === 'input' ? [batchPrice, batchStock, ...extraInputs()] : sel === 'tr' ? rows : []),
    visible: () => true,
    textOf: (e) => String(e?.innerText ?? ''),
    waitFor: async (fn) => fn(),
    click: (e) => e.click(),
    setNativeValue: (el, v) => {
      el.value = v;
    },
    buttonByText: (label) => (label === '批量应用' ? applyBtn : null),
  };
  const backend = { __core: true, util };
  vm.runInNewContext(MEDIA_SRC, { window: { __JDMOVE__: { backend } }, Event, FocusEvent: Event });
  return { B: backend, batchPrice };
}

test('setSkuRows: 批量价格框先失焦再点“批量应用”，价格才会生效', async () => {
  const rows = [skuRow()];
  const { B, batchPrice } = loadPage(rows);
  await B.setSkuRows([{ enabled: true, price: 45.9, stock: 100 }]);
  assert.equal(batchPrice.committed, '45.9');
  assert.equal(rows[0].price.committed, '45.9');
  assert.equal(rows[0].stock.committed, '100');
});

test('setSkuRows: 写入后值没留住时报告缺失的行，而不是假装成功', async () => {
  const rows = [skuRow({ sticky: false })];
  const { B } = loadPage(rows);
  const res = await B.setSkuRows([{ enabled: true, price: 45.9, stock: 100 }]);
  assert.equal(res.ok, false);
  assert.equal(JSON.stringify(res.missing), JSON.stringify([{ row: 0, price: '45.9', stock: '100' }]));
});

const specState = (dim) => JSON.stringify(dim.modelValue.map((m) => [m.attrValueAlias, m.specType]));

test('setSaleValues: 让持有新值的输入框失焦，临时规格值转为正式值，SKU 表才会带上规格', async () => {
  const dim = saleDim('规格');
  const { B } = loadPage([skuRow()], () => dim.inputs);
  const res = await B.setSaleValues([{ name: '规格', values: ['黑巧480g'] }], { stableMs: 0 });
  assert.equal(specState(dim), JSON.stringify([['黑巧480g', 'formal']]));
  assert.equal(res.ok, true);
});

test('setSaleValues: 已录入但仍是临时状态的值也会被提交，不重复录入', async () => {
  const dim = saleDim('规格');
  const { B } = loadPage([skuRow()], () => dim.inputs);
  dim.inputs[0].value = '黑巧480g';
  const res = await B.setSaleValues([{ name: '规格', values: ['黑巧480g'] }], { stableMs: 0 });
  assert.equal(specState(dim), JSON.stringify([['黑巧480g', 'formal']]));
  assert.equal(res.ok, true);
});

test('setSaleValues: 规格值没能转为正式值时报告出来，避免带着会被清空的价格/库存继续保存', async () => {
  const dim = saleDim('规格', { commitOnBlur: false });
  const { B } = loadPage([skuRow()], () => dim.inputs);
  const res = await B.setSaleValues([{ name: '规格', values: ['黑巧480g'] }], { stableMs: 0 });
  assert.equal(res.ok, false);
  assert.equal(JSON.stringify(res.uncommitted), JSON.stringify(['规格:黑巧480g']));
});

test('drawerFields: 识别新版 SKU属性抽屉（.shop-dynamic-component），必填按 is-required-star 判断', () => {
  const { B } = loadPage([]);
  const field = (label, required) => {
    const root = { label };
    return { innerText: label, parentElement: root, classList: { contains: (c) => required && c === 'is-required-star' } };
  };
  const titles = [field('最小可售单位UPC', true), field('建议零售价', true), field('生产日期', false)];
  const drawer = { querySelectorAll: (sel) => (sel === '.shop-dynamic-component-title' ? titles : []) };
  const fields = B.drawerFields(drawer);
  assert.equal(JSON.stringify(fields.map((f) => [f.label, f.required])), JSON.stringify([['最小可售单位UPC', true], ['建议零售价', true], ['生产日期', false]]));
});

test('waitSkuTableStable: 等京麦重建完 SKU 表（行 id 不再变化）才返回', async () => {
  const ids = ['a', 'a', 'b', 'b', 'b', 'b', 'b', 'b', 'b', 'b', 'b', 'b'];
  let reads = 0;
  const tr = { querySelector: (sel) => (sel === 'input' ? { id: ids[Math.min(reads++, ids.length - 1)] } : null) };
  const rows = [Object.assign(skuRow(), { querySelector: (sel) => (sel === '.jd-switch' ? {} : tr.querySelector(sel)) })];
  const { B } = loadPage(rows);
  const stable = await B.waitSkuTableStable({ quietMs: 30, timeout: 1000, interval: 5 });
  assert.equal(stable, true);
  assert.ok(reads >= 3, '至少要观察到一次重建');
});
