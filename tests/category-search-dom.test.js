import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const CORE_SRC = readFileSync(new URL('../src/inject/backend-core.js', import.meta.url), 'utf8');
const FAST = { settleMs: 120, interval: 10, timeout: 1500 };

const node = (text = '') => ({
  innerText: text,
  textContent: text,
  isConnected: true,
  offsetParent: {},
  getClientRects: () => [1],
  focus() {},
});

/**
 * 模拟京麦类目选择页：输入关键词 latencyMs 后下拉框才换成新结果；
 * 在此之前一直显示上一次搜索留下的内容（stale）
 */
function loadCategoryPage({ tree, stale = { items: [], empty: false }, latencyMs = 60, clearHides = false, bodyText = '', aigcTab = false }) {
  const view = { items: stale.items.map(node), empty: stale.empty };
  const emptyBox = node('暂无数据');
  let timer = null;
  class FakeInput {
    constructor() {
      this.placeholder = '请输入类目名称';
      this._value = '';
      Object.assign(this, node());
    }
    get value() { return this._value; }
    set value(v) { this._value = v; }
    dispatchEvent(e) {
      if (e.type !== 'input') return true;
      clearTimeout(timer);
      const kw = this._value;
      if (!kw) {
        if (clearHides) Object.assign(view, { items: [], empty: false });
        return true;
      }
      timer = setTimeout(() => {
        const hits = tree.filter((t) => t.includes(kw)).map(node);
        Object.assign(view, { items: hits, empty: hits.length === 0 });
      }, latencyMs);
      return true;
    }
  }
  const input = new FakeInput();
  // 京麦类目页默认停在“智能发品”：类目搜索框要点“普通发品”后才出现
  const page = { searchVisible: !aigcTab, tabClicks: 0, aigcClicks: 0 };
  const aigcInput = { ...node(), placeholder: '建议文本格式：商品品牌+商品品名（类目产品词+合格证/外包装商品品名）' };
  const tabs = [
    { ...node('智能发品 预填商品信息发品提效 25%'), dispatchEvent() {}, click() { page.aigcClicks += 1; } },
    { ...node('普通发品 手动录入精准填写信息'), dispatchEvent() {}, click() { page.tabClicks += 1; page.searchVisible = true; } },
  ];
  const document = {
    body: { get innerText() { return [bodyText, view.empty ? '暂无数据' : ''].join('\n'); } },
    querySelector: () => null,
    querySelectorAll: (sel) => {
      if (sel === 'input') return page.searchVisible ? [input] : [aigcInput];
      if (sel === '.jd-tabs__item') return tabs;
      if (sel.includes('jd-dropdown-menu__item')) return view.items;
      if (sel.includes('dropdown') || sel.includes('popper')) return view.empty ? [emptyBox] : [];
      return [];
    },
  };
  class Ev { constructor(type) { this.type = type; } }
  const window = { __JDMOVE__: {} };
  vm.runInNewContext(CORE_SRC, {
    window,
    document,
    location: { href: 'https://wares-jdm.jd.com/ware/categorySelectNew?source=1', pathname: '/ware/categorySelectNew' },
    HTMLInputElement: FakeInput,
    HTMLTextAreaElement: class {},
    Event: Ev,
    MouseEvent: Ev,
    setTimeout,
    clearTimeout,
  });
  return Object.assign(window.__JDMOVE__.backend, { page });
}

/** 结果数组来自 vm 上下文，转成本上下文的数组再比较 */
const texts = (res) => [...res.results];

const TREE = ['（京喜通）休闲零食[17991] > 糖巧布丁[17994] > 巧克力[18132]', '（京喜通）休闲零食[17991] > 糖巧布丁[17994] > 软糖[18133]'];

test('searchCategory: 上一次搜索留下的“暂无数据”不会被当成这次的结果', async () => {
  const B = loadCategoryPage({ tree: TREE, stale: { items: [], empty: true }, latencyMs: 60 });
  const res = await B.searchCategory('巧克力', FAST);
  assert.equal(res.ok, true);
  assert.deepEqual(texts(res), [TREE[0]]);
});

test('searchCategory: 页面其他位置的“暂无数据”不影响判断', async () => {
  const B = loadCategoryPage({ tree: TREE, latencyMs: 60, bodyText: '最近使用类目 暂无数据' });
  const res = await B.searchCategory('软糖', FAST);
  assert.deepEqual(texts(res), [TREE[1]]);
});

test('searchCategory: 上一次的旧结果不会被当成这次的结果', async () => {
  const B = loadCategoryPage({ tree: TREE, stale: { items: [TREE[0]], empty: false }, latencyMs: 60 });
  const res = await B.searchCategory('软糖', FAST);
  assert.deepEqual(texts(res), [TREE[1]]);
});

test('searchCategory: 确实没有结果时返回空列表', async () => {
  const B = loadCategoryPage({ tree: TREE, latencyMs: 20, clearHides: true });
  const started = Date.now();
  const res = await B.searchCategory('牛奶巧克力', FAST);
  assert.deepEqual(texts(res), []);
  assert.ok(Date.now() - started >= FAST.settleMs, '空结果至少等待 settleMs 才认定');
});

test('searchCategory: 新结果和旧结果相同时，等待稳定后照常返回', async () => {
  const B = loadCategoryPage({ tree: TREE, stale: { items: [TREE[0]], empty: false }, latencyMs: 20 });
  const res = await B.searchCategory('巧克力', FAST);
  assert.deepEqual(texts(res), [TREE[0]]);
});

test('searchCategory: 类目页停在“智能发品”时先切到“普通发品”再搜索', async () => {
  const b = loadCategoryPage({ tree: TREE, aigcTab: true });
  const res = await b.searchCategory('巧克力', FAST);
  assert.equal(res.ok, true);
  assert.deepEqual(texts(res), [TREE[0]]);
  assert.equal(b.page.tabClicks, 1);
  assert.equal(b.page.aigcClicks, 0, '只走普通发品，不能点智能发品');
});

test('searchCategory: 已经在“普通发品”时不再点标签', async () => {
  const b = loadCategoryPage({ tree: TREE });
  await b.searchCategory('巧克力', FAST);
  assert.equal(b.page.tabClicks, 0);
});
