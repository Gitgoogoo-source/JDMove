// 商品审核列表（apply-list.js）：读组件数据 / 页面行 → 解析 → 按申请单号（兜底按名称和提交时间）找回刚发布商品的 SKU
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  parseApplyRecords,
  parseApplyRows,
  pickPublishedSku,
  readApplyRecordsInPage,
  readApplyRowsInPage,
  readPublishMarkInPage,
  skuByApplyId,
} from '../src/shared/apply-list.js';

// 2026-11-20 实测的商品审核列表接口行（第 1、4 行同名：同一个商品发布了两次）
const REAL_ROWS = JSON.parse(readFileSync(new URL('./fixtures/vc-apply-list-rows.json', import.meta.url), 'utf8'));

/** 极简 DOM 节点：text 是自己的文字（不含子元素），innerText/textContent 拼上子元素的 */
function el(tag, text = '', kids = []) {
  const node = { tagName: tag, ownText: text, children: kids, parentElement: null };
  kids.forEach((k) => (k.parentElement = node));
  const full = () => [node.ownText, ...kids.map((k) => k.textContent)].filter(Boolean).join('\n');
  Object.defineProperty(node, 'textContent', { get: full });
  Object.defineProperty(node, 'innerText', { get: full });
  return node;
}
const descendants = (n) => n.children.flatMap((k) => [k, ...descendants(k)]);

/** 2026-11-20 实测结构：商品编码：是文字节点，数字在子元素 span.product-id 里 */
const applyRow = (title, sku, time) =>
  el('TR', '', [
    el('TD', '', [
      el('DIV', title),
      el('DIV', '商品编码：', [el('SPAN', sku), el('DIV', '')]),
    ]),
    el('TD', '', [el('DIV', `提交： ${time}`)]),
    el('TD', '审核通过'),
  ]);

async function withDocument(body, fn) {
  const prev = globalThis.document;
  globalThis.document = { querySelectorAll: (sel) => (sel === 'body *' ? descendants(body) : []) };
  try {
    return await fn();
  } finally {
    globalThis.document = prev;
  }
}

test('readApplyRowsInPage: “商品编码：”和数字分在两个元素里（真实页面结构）也能读出每一行', async () => {
  const body = el('BODY', '', [
    el('TABLE', '', [
      applyRow('维达抽纸 细韧3层100抽*6包S码 细腻柔韧 纸巾纸抽 餐巾纸', '100343137725', '2026-11-20 01:59:14'),
      applyRow('维达无芯卷纸 超韧4层80克*10卷 厚韧 卫生纸厕纸 卷筒纸纸巾卫卷', '100343137723', '2026-11-20 01:57:56'),
    ]),
  ]);
  const texts = await withDocument(body, () => readApplyRowsInPage(0));
  assert.equal(texts.length, 2);
  const rows = parseApplyRows(texts);
  assert.deepEqual(rows.map((r) => r.sku), ['100343137725', '100343137723']);
  assert.equal(rows[1].name, '维达无芯卷纸 超韧4层80克*10卷 厚韧 卫生纸厕纸 卷筒纸纸巾卫卷');
  const since = new Date(2026, 10, 20, 1, 57, 50).getTime();
  assert.equal(pickPublishedSku(rows, { name: '维达无芯卷纸 超韧4层80克*10卷 厚韧 卫生纸厕纸 卷筒纸纸巾卫卷', since }), '100343137723');
});

test('readApplyRowsInPage: 同一行的文字只返回一次；没有商品行时等到超时返回 []', async () => {
  const body = el('BODY', '', [el('DIV', '暂无数据')]);
  assert.deepEqual(await withDocument(body, () => readApplyRowsInPage(0)), []);
});

test('pickPublishedSku: 同名商品发布过多次时，取点“发布商品”之后提交的那个', () => {
  const rows = parseApplyRows([
    '维达无芯卷纸\n商品编码：\n100343137723\n提交： 2026-11-20 01:57:56',
    '维达无芯卷纸\n商品编码：\n100343137287\n提交： 2026-11-20 01:23:55',
  ]);
  const since = new Date(2026, 10, 20, 1, 57, 50).getTime();
  assert.equal(pickPublishedSku(rows, { name: '维达无芯卷纸', since }), '100343137723');
  // 新提交的还没进列表时不能错拿旧的
  assert.equal(pickPublishedSku(rows.slice(1), { name: '维达无芯卷纸', since }), '');
});

test('pickPublishedSku: 同一个商品连发两次（如常规价、促销价），第二次跳过已经记下的 SKU，新提交的还没进列表时返回空', () => {
  // 第一次 01:57:56 提交、已记为 100343137723；第二次 01:58:40 点“发布商品”，都在 2 分钟容差内
  const since = new Date(2026, 10, 20, 1, 58, 40).getTime();
  const first = '维达无芯卷纸\n商品编码：\n100343137723\n提交： 2026-11-20 01:57:56';
  const second = '维达无芯卷纸\n商品编码：\n100343137999\n提交： 2026-11-20 01:58:43';
  const taken = new Set(['100343137723']);
  assert.equal(pickPublishedSku(parseApplyRows([first]), { name: '维达无芯卷纸', since, taken }), '');
  assert.equal(pickPublishedSku(parseApplyRows([second, first]), { name: '维达无芯卷纸', since, taken }), '100343137999');
  // 列表时间只到秒，第二次的提交时间和第一次相同时也不会拿成第一次的
  const sameSecond = '维达无芯卷纸\n商品编码：\n100343137999\n提交： 2026-11-20 01:57:56';
  assert.equal(pickPublishedSku(parseApplyRows([first, sameSecond]), { name: '维达无芯卷纸', since, taken }), '100343137999');
});

test('parseApplyRecords + skuByApplyId: 真实列表行按申请单号对上，同名的两次发布各是各的 SKU', () => {
  const rows = parseApplyRecords(REAL_ROWS);
  assert.equal(rows.length, 4);
  assert.equal(rows[0].name, rows[3].name, '真实数据里确实有同名商品');
  assert.equal(skuByApplyId(rows, '0f0a48ac54454bbe96361b7b0e291030'), '100454553496');
  assert.equal(skuByApplyId(rows, 'b27db901a3574d9caaf7918c36d21179'), '100343266561');
  assert.equal(skuByApplyId(rows, 'not-there'), '');
  assert.equal(skuByApplyId(rows, ''), '');
  assert.equal(rows[0].submittedAt, 1795149004000);
});

test('parseApplyRecords: 页面数据不可信——没有申请单号、商品编码不是数字、不是数组的都丢掉', () => {
  assert.deepEqual(parseApplyRecords(null), []);
  assert.deepEqual(parseApplyRecords('x'), []);
  const rows = parseApplyRecords([{ applyId: '', productId: 100454553496 }, { applyId: 'a1', productId: 'abc' }, null, { applyId: 'a2', productId: '100454553496', created: 'x' }]);
  assert.deepEqual(rows, [{ applyId: 'a2', sku: '100454553496', name: '', submittedAt: null }]);
});

test('pickPublishedSku: 有服务器时间时只认 15 秒内提交的；同名商品 75 秒前那次不算', () => {
  const rows = parseApplyRecords(REAL_ROWS);
  const name = '维达抽纸 超韧3层110抽*24包S码 湿水不易破 卫生纸面巾纸 新旧随机发';
  assert.equal(pickPublishedSku(rows, { name, since: 0, serverTime: 1795149004157 }), '100454553496');
  // 新提交的那行还没进列表：只剩上午那次，时间对不上，留空
  assert.equal(pickPublishedSku(rows.slice(1), { name, since: 0, serverTime: 1795149004157 }), '');
  // 上午那次发布时（服务器时间 1795144726xxx）只对得上它自己
  assert.equal(pickPublishedSku(rows, { name, since: 0, serverTime: 1795144726500 }), '100343266561');
});

test('pickPublishedSku: 时间窗口里同名的不止一个（又没有记过的可排除）时对不准，留空不猜', () => {
  const rows = parseApplyRows([
    '维达无芯卷纸\n商品编码：\n100343137999\n提交： 2026-11-20 01:58:43',
    '维达无芯卷纸\n商品编码：\n100343137723\n提交： 2026-11-20 01:57:56',
  ]);
  const since = new Date(2026, 10, 20, 1, 58, 40).getTime();
  assert.equal(pickPublishedSku(rows, { name: '维达无芯卷纸', since }), '');
});

/** 极简 Vue 3 生产包页面：挂载点上有 __vue_app__ 和 _vnode，组件 vnode.component.props / subTree */
function vueDocument(rows) {
  const table = { component: { props: { data: rows }, subTree: { children: [] } } };
  const other = { component: { props: { data: [{ id: 1 }] }, subTree: { children: [table] } } };
  const app = { __vue_app__: {}, _vnode: { children: [{ component: { props: {}, subTree: other } }] } };
  return { querySelectorAll: () => [{}, app] };
}

test('readApplyRecordsInPage: 从 Vue 挂载点往下找到带 applyId 的表格数据（JdProVTable 的 props.data）', async () => {
  const prev = globalThis.document;
  try {
    globalThis.document = vueDocument(REAL_ROWS.map((r) => ({ ...r, extra: { deep: true } })));
    const got = await readApplyRecordsInPage(0);
    assert.equal(got.length, 4);
    assert.deepEqual(got[0], { applyId: '0f0a48ac54454bbe96361b7b0e291030', productId: '100454553496', productName: REAL_ROWS[0].productName, created: 1795149004000 });
    globalThis.document = vueDocument([]);
    assert.deepEqual(await readApplyRecordsInPage(0), [], '有 Vue 但还没有商品行');
    globalThis.document = { querySelectorAll: () => [{}] };
    assert.equal(await readApplyRecordsInPage(0), null, '找不到 Vue 挂载点：页面结构变了');
  } finally {
    globalThis.document = prev;
  }
});

test('readPublishMarkInPage: 只认这次发布的 nonce，读到后删掉', () => {
  const prev = globalThis.sessionStorage;
  const map = new Map();
  globalThis.sessionStorage = { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => map.set(k, v), removeItem: (k) => map.delete(k) };
  try {
    map.set('__jdmove_publish__', JSON.stringify({ nonce: 'n-1', applyId: 'a1' }));
    assert.equal(readPublishMarkInPage('n-2'), null);
    assert.equal(readPublishMarkInPage(''), null);
    assert.deepEqual(readPublishMarkInPage('n-1'), { nonce: 'n-1', applyId: 'a1' });
    assert.equal(map.size, 0);
    map.set('__jdmove_publish__', '{bad json');
    assert.equal(readPublishMarkInPage('n-1'), null);
  } finally {
    globalThis.sessionStorage = prev;
  }
});
