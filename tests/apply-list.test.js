// 商品审核列表（apply-list.js）：读页面行 → 解析 → 按名称和提交时间找回刚发布商品的 SKU
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseApplyRows, pickPublishedSku, readApplyRowsInPage } from '../src/shared/apply-list.js';

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
