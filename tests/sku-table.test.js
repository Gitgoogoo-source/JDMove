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
  const sw = { classList: { contains: (c) => c === 'is-checked' && opts?.enabled !== false }, click() {} };
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
function saleDim(name, { commitOnBlur = true, windowFocused = true, commitAfterBlurs = 1 } = {}) {
  const modelValue = [];
  const container = { type: { name: 'SaleDimensionContainer' }, props: { modelValue } };
  const inputs = [];
  let blurs = 0;
  const newInput = (value = '') => ({
    placeholder: `请设置${name}`,
    value,
    focused: false,
    listeners: [],
    __vueParentComponent: { type: { name: 'JdInput' }, parent: container },
    addEventListener(type, fn) {
      this.listeners.push([type, fn]);
    },
    removeEventListener(type, fn) {
      this.listeners = this.listeners.filter(([t, f]) => t !== type || f !== fn);
    },
    click() {
      this.focused = true;
    },
    // 窗口没有系统焦点时，原生 focus()/blur() 不派发事件
    focus() {
      if (windowFocused) this.focused = true;
    },
    blur() {
      if (!this.focused) return;
      this.focused = false;
      this.dispatchEvent(new Event('blur'));
    },
    dispatchEvent(e) {
      this.listeners.filter(([t]) => t === e.type).forEach(([, fn]) => fn(e));
      if (e.type !== 'blur') return true;
      blurs += 1;
      const hit = modelValue.find((m) => m.attrValueAlias === this.value);
      if (hit && commitOnBlur && blurs >= commitAfterBlurs) hit.specType = 'formal';
      return true;
    },
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

test('setSkuPrices: 编辑页改价只改已启用 SKU 的京东价，库存和未启用的行不动', async () => {
  const rows = [skuRow(), skuRow({ enabled: false }), skuRow()];
  rows.forEach((r, i) => {
    r.price.value = String(50 + i);
    r.stock.value = '7';
  });
  const { B } = loadPage(rows);
  const res = await B.setSkuPrices(61.5);
  assert.equal(res.ok, true);
  assert.equal(res.rows, 2);
  assert.deepEqual([...res.before], ['50', '52']);
  assert.deepEqual(rows.map((r) => r.price.committed), ['61.5', '', '61.5']);
  assert.equal(rows[1].price.value, '51');
  assert.deepEqual(rows.map((r) => r.stock.value), ['7', '7', '7']);
});

test('setSkuPrices: 价格没写进去或页面没有 SKU 表时如实报告', async () => {
  const lost = [skuRow({ sticky: false })];
  lost[0].price.value = '50';
  const res = await loadPage(lost).B.setSkuPrices(61.5);
  assert.equal(res.ok, false);
  assert.match(res.error, /第 1 个 SKU/);
  const empty = await loadPage([]).B.setSkuPrices(61.5);
  assert.equal(empty.ok, false);
  assert.match(empty.error, /没有找到 SKU 价格表/);
});

test('readSkuPrices / setSkuPrices: 原价一直没加载出来时不改价，避免随后加载的数据覆盖新价格', async () => {
  const rows = [skuRow()];
  const { B } = loadPage(rows);
  const read = await B.readSkuPrices();
  assert.equal(read.ok, false);
  assert.match(read.error, /没有加载出来/);
  const set = await B.setSkuPrices(61.5);
  assert.equal(set.ok, false);
  assert.equal(rows[0].price.value, '');
  rows[0].price.value = '55';
  assert.deepEqual(JSON.parse(JSON.stringify(await B.readSkuPrices())), { ok: true, prices: ['55'] });
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

test('setSaleValues: 窗口没有焦点、原生 blur 不触发时，补发合成 blur 提交规格值', async () => {
  const dim = saleDim('规格', { windowFocused: false });
  const { B } = loadPage([skuRow()], () => dim.inputs);
  const res = await B.setSaleValues([{ name: '规格', values: ['黑巧480g'] }], { stableMs: 0 });
  assert.equal(specState(dim), JSON.stringify([['黑巧480g', 'formal']]));
  assert.equal(res.ok, true);
});

test('setSaleValues: 页面忙、第一次失焦没生效时重试，不直接判失败', async () => {
  const dim = saleDim('规格', { commitAfterBlurs: 2 });
  const { B } = loadPage([skuRow()], () => dim.inputs);
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

/** 只有表单 API 与 pinia 的发布页：用来测 SKU属性的读取 */
function loadStatePage({ skus, columns, tableData }) {
  const api = { getValue: (f) => (f === 'skus' ? skus : undefined) };
  const store = { saleAttrConfig: { skuTableColumn: columns } };
  // SKU属性单元格 -> 上层 SKU 表组件（props.tableData 是表格当前数据）
  const cell = { __vueParentComponent: { props: {}, parent: { props: { tableData }, parent: null } } };
  const qsa = (sel) => (sel === '.shop-sku-attribute' && tableData ? [cell] : []);
  const backend = {
    __core: true,
    util: { sleep: () => Promise.resolve(), qsa, visible: () => true, textOf: () => '', waitFor: async (fn) => fn() },
    getFApi: () => api,
    pinia: () => ({ state: { value: { 'publish-product': store } } }),
  };
  vm.runInNewContext(MEDIA_SRC, { window: { __JDMOVE__: { backend } }, Event, FocusEvent: Event });
  return backend;
}

const SKU_ATTR_COLUMN = {
  field: 'skuProps',
  componentCode: 'SkuAttr',
  children: [
    {
      componentCode: 'ATTR_REQUIRED',
      children: [
        { field: '256076', title: '最小可售单位UPC', props: { rule: { required: true } } },
        { field: '393788', title: '建议零售价', props: { rule: { required: true } } },
      ],
    },
    { componentCode: 'ATTR_NO_REQUIRED', children: [{ field: '265829', title: '生产日期', props: { rule: { required: false } } }] },
  ],
};

test('readSkuAttrState: 从表单 skus 读每行 skuProps，从 SKU属性列配置读必填项', () => {
  const B = loadStatePage({
    skus: [{ skuProps: { 256076: '6914973609563', 393788: '25.9' } }, { skuProps: null }],
    columns: [{ field: 'jdPrice' }, SKU_ATTR_COLUMN],
  });
  const st = B.readSkuAttrState();
  assert.equal(st.ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(st.required)), [
    { field: '256076', label: '最小可售单位UPC' },
    { field: '393788', label: '建议零售价' },
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(st.skuProps)), [{ 256076: '6914973609563', 393788: '25.9' }, null]);
});

test('readSkuAttrState: 没有 SKU属性列的类目没有必填项；读不到 skus 时报告失败', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(loadStatePage({ skus: [{}], columns: [] }).readSkuAttrState().required)), []);
  assert.equal(loadStatePage({ skus: undefined, columns: [SKU_ATTR_COLUMN] }).readSkuAttrState().ok, false);
});

test('readSkuAttrState: 新发布页的表单 skus 在保存前是空的，按 SKU 表当前数据核对', () => {
  const B = loadStatePage({
    skus: [],
    tableData: [{ skuProps: { 256076: '6914973609563', 393788: '24.5' } }, { skuProps: {} }],
    columns: [SKU_ATTR_COLUMN],
  });
  const st = B.readSkuAttrState();
  assert.equal(st.ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(st.skuProps)), [{ 256076: '6914973609563', 393788: '24.5' }, {}]);
});

test('readSkuAttrState: SKU 表一行都没有时报告失败，而不是当作没有缺项', () => {
  assert.equal(loadStatePage({ skus: [], tableData: [], columns: [SKU_ATTR_COLUMN] }).readSkuAttrState().ok, false);
  assert.equal(loadStatePage({ skus: [], columns: [SKU_ATTR_COLUMN] }).readSkuAttrState().ok, false);
});

/**
 * 一行 SKU 和它的 SKU属性抽屉。京麦的数字输入框失焦后过一会儿才把值写进表单：
 * 在那之前点“确定”会报“请输入…”、抽屉不关；okNeeds 表示第几次点“确定”才关上
 */
function loadDrawerPage({ okNeeds = 1 } = {}) {
  const sleeps = [];
  const clicks = { ok: 0, cancel: 0 };
  const drawer = { visible: false, innerText: 'SKU属性' };
  const field = (label) => {
    const input = { value: '', readOnly: false, dispatchEvent: () => true };
    const root = { querySelector: (sel) => (sel.startsWith('input.jd-input__inner') ? input : null) };
    return { innerText: label, textContent: label, parentElement: root, classList: { contains: (c) => c === 'is-required-star' }, input };
  };
  const titles = [field('最小可售单位UPC'), field('建议零售价')];
  const okBtn = { innerText: '确定', click: () => { clicks.ok += 1; if (clicks.ok >= okNeeds) drawer.visible = false; } };
  const cancelBtn = { innerText: '取消', click: () => { clicks.cancel += 1; drawer.visible = false; } };
  const trigger = { value: 'SKU属性', placeholder: '', click: () => { drawer.visible = true; } };
  const priceInputs = [{ placeholder: '请输入', value: '25.9' }, { placeholder: '请输入', value: '100' }];
  const tr = {
    scrollIntoView() {},
    querySelectorAll: (sel) => (sel === 'input[placeholder="请输入"]' ? priceInputs : []),
    querySelector: (sel) => (sel === '.jd-switch' ? { classList: { contains: () => true } } : sel === '.shop-sku-attribute input' ? trigger : null),
  };
  const visible = (e) => e.visible !== false;
  const util = {
    sleep: (ms) => { sleeps.push(ms); return Promise.resolve(); },
    qsa: (sel, root) => {
      if (root === drawer) return sel === '.shop-dynamic-component-title' ? titles : sel === 'button' ? [okBtn, cancelBtn] : [];
      if (root) return [];
      return sel === 'tr' ? [tr] : sel === '.jd-drawer' ? [drawer] : [];
    },
    visible,
    textOf: (e) => String(e?.innerText ?? ''),
    waitFor: async (fn) => fn(),
    click: (e) => e.click(),
    setNativeValue: (el, v) => { el.value = v; },
    buttonByText: (label, root) => util.qsa('button', root).find((b) => visible(b) && b.innerText === label) || null,
    norm: (s) => String(s ?? '').toLowerCase().replace(/\s/g, ''),
  };
  const backend = { __core: true, util };
  vm.runInNewContext(MEDIA_SRC, { window: { __JDMOVE__: { backend } }, Event, FocusEvent: Event });
  return { B: backend, clicks, sleeps, titles };
}

const ATTR_VALUES = { 最小可售单位UPC: '6914973609563', 建议零售价: '24.5' };

test('fillSkuAttrDrawers: 填完先等页面同步再点“确定”', async () => {
  const { B, clicks, sleeps } = loadDrawerPage();
  const res = await B.fillSkuAttrDrawers(ATTR_VALUES);
  assert.equal(res.results[0].confirmed, true);
  assert.equal(clicks.ok, 1);
  assert.ok(sleeps.some((ms) => ms >= 400), `点“确定”前应等待，实际 sleep：${sleeps.join(',')}`);
});

test('fillSkuAttrDrawers: 第一次“确定”被页面校验拦下时再点，而不是直接取消', async () => {
  const { B, clicks, titles } = loadDrawerPage({ okNeeds: 2 });
  const res = await B.fillSkuAttrDrawers(ATTR_VALUES);
  assert.equal(res.results[0].confirmed, true);
  assert.equal(clicks.ok, 2);
  assert.equal(clicks.cancel, 0, '不应取消');
  assert.equal(titles[0].input.value, '6914973609563');
});

test('fillSkuAttrDrawers: 多次“确定”都关不上才取消，并报告未保存', async () => {
  const { B, clicks } = loadDrawerPage({ okNeeds: 99 });
  const res = await B.fillSkuAttrDrawers(ATTR_VALUES);
  assert.equal(res.results[0].confirmed, false);
  assert.equal(clicks.ok, 3);
  assert.equal(clicks.cancel, 1);
});

test('checkSkuRows: 只读核对京东价/库存，不重新写入', async () => {
  const rows = [skuRow()];
  rows[0].price.value = '45.9';
  rows[0].stock.value = '';
  const { B } = loadPage(rows);
  const res = B.checkSkuRows([{ enabled: true, price: 45.9, stock: 100 }]);
  assert.deepEqual(JSON.parse(JSON.stringify(res.missing)), [{ row: 0, price: '45.9', stock: '100' }]);
  assert.equal(rows[0].stock.value, '', '不应写入');
});
