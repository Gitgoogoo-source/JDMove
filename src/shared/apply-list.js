// 商品管理 → 商品审核（wareList?businessModel=1&activeTab=ApplyWare）列表：找回刚发布商品的 SKU。
// 2026-11-20 实测：发布接口 saveProductNew 的返回里没有 SKU（skuList/productId 都是 null），只有申请单号 applyId（32 位字母数字）。
// 列表接口 queryProductApplyList 的每一行有 applyId、productId（单 SKU 商品的商品编码 = 京东分配的 SKU）、productName、created（毫秒）；
// 页面是 Vue 3，这些行在组件 JdProVTable 的 props.data 里。按 applyId 精确对上，同名商品连发也不会串号。
// 拿不到 applyId（或读不到组件数据）时才按商品名称 + 提交时间兜底，对不准就留空，不猜

export const APPLY_LIST_URL = 'https://wares-jdm.jd.com/ware/wareList?businessModel=1&activeTab=ApplyWare';
// 只有本机时间时（没有发布接口返回的服务器时间）：提交时间在点“发布商品”前这么久以内的都算（列表时间是服务器时间，只到秒）
const SUBMIT_SLACK_MS = 120e3;
// 有服务器时间时（发布接口返回的 version）：提交时间和它相差这么多以内才算
const SERVER_SLACK_MS = 15e3;

const SKU_RE = /商品编码\s*[:：]\s*(\d{6,20})/;
const TIME_RE = /提交\s*[:：]\s*(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})(?::(\d{2}))?/;
const squash = (s) => String(s ?? '').replace(/\s+/g, '');
const idText = (v) => (v != null && /^\d{6,20}$/.test(String(v).trim()) ? String(v).trim() : '');

/**
 * @typedef {{name: string, sku: string, submittedAt: number|null, applyId?: string}} ApplyRow
 *   sku：商品编码（单 SKU 商品就是 SKU）；submittedAt：提交时间（服务器时间，毫秒）；applyId：申请单号（只有从组件数据读到的行才有）
 */

/**
 * 列表行的文字 → 商品
 * @param {string[]} texts 每行的 innerText
 * @returns {ApplyRow[]}
 */
export function parseApplyRows(texts) {
  return (texts ?? []).flatMap((text) => {
    const sku = String(text ?? '').match(SKU_RE)?.[1];
    if (!sku) return [];
    const name = String(text).split(/\r?\n/).map((l) => l.trim()).find((l) => l && !SKU_RE.test(l)) ?? '';
    const t = String(text).match(TIME_RE);
    const submittedAt = t ? new Date(+t[1], +t[2] - 1, +t[3], +t[4], +t[5], +(t[6] ?? 0)).getTime() : null;
    return [{ name, sku, submittedAt }];
  });
}

/**
 * 组件数据里的列表行 → 商品（不可信的页面数据：逐项校验，缺 applyId 或商品编码的行丢掉）
 * @param {unknown} records readApplyRecordsInPage 的返回
 * @returns {ApplyRow[]}
 */
export function parseApplyRecords(records) {
  if (!Array.isArray(records)) return [];
  return records.flatMap((r) => {
    const applyId = String(r?.applyId ?? '').trim();
    const sku = idText(r?.productId);
    if (!applyId || !sku) return [];
    const created = Number(r?.created);
    return [{ applyId, sku, name: String(r?.productName ?? ''), submittedAt: Number.isFinite(created) && created > 0 ? created : null }];
  });
}

/**
 * 按申请单号找刚发布商品的 SKU
 * @param {ApplyRow[]} rows
 * @param {string} applyId
 * @returns {string} 找不到时为 ''
 */
export function skuByApplyId(rows, applyId) {
  const want = String(applyId ?? '').trim();
  if (!want) return '';
  return rows.find((r) => r.applyId === want)?.sku ?? '';
}

/**
 * 兜底：按名称（忽略空格）和提交时间找刚发布商品的 SKU。
 * 有服务器时间（serverTime，发布接口返回的 version）时，提交时间要和它相差 15 秒以内；只有本机时间（since）时放宽到点“发布商品”前 2 分钟。
 * 已经记给别的商品的 SKU（taken）不再选；剩下不止一个时对不准，留空
 * @param {ApplyRow[]} rows
 * @param {{name: string, since: number, serverTime?: number|null, taken?: Set<string>}} want
 * @returns {string} 找不到或对不准时为 ''
 */
export function pickPublishedSku(rows, { name, since, serverTime = null, taken = new Set() }) {
  const target = squash(name);
  if (!target) return '';
  const inWindow = (t) => (serverTime ? Math.abs(t - serverTime) <= SERVER_SLACK_MS : t >= since - SUBMIT_SLACK_MS);
  const skus = new Set(
    rows.filter((r) => squash(r.name) === target && r.submittedAt != null && inWindow(r.submittedAt) && !taken.has(r.sku)).map((r) => r.sku),
  );
  return skus.size === 1 ? [...skus][0] : '';
}

/**
 * 商品审核列表每一行的文字（注入页面执行，必须自包含）。读不到组件数据时用。
 * 2026-11-20 实测页面结构：<div class="product-info">商品编码：<span class="product-id">100343137723</span><div class="show-btn"></div></div>，
 * “商品编码：”和数字不在同一个元素里，所以找“文字里含 商品编码: 数字、但子元素里都不含”的最小元素，再往上找到带“提交:”时间的那一行
 * @param {number} waitMs 列表加载出商品行最多等这么久
 * @returns {Promise<string[]>}
 */
export async function readApplyRowsInPage(waitMs) {
  const SKU = /商品编码\s*[:：]\s*\d{6,}/;
  const has = (e) => SKU.test(e.textContent || '');
  const end = Date.now() + waitMs;
  for (;;) {
    const cells = [...document.querySelectorAll('body *')].filter((e) => has(e) && ![...e.children].some(has));
    const rows = cells.map((cell) => {
      for (let n = cell, i = 0; n && i < 10; i += 1, n = n.parentElement) if (/提交\s*[:：]/.test(n.innerText || '')) return n.innerText;
      return cell.innerText || cell.textContent || '';
    });
    if (rows.length || Date.now() > end) return [...new Set(rows)];
    await new Promise((r) => setTimeout(r, 500));
  }
}

/**
 * 商品审核列表组件里的行数据（注入页面执行，必须自包含）。
 * 页面是 Vue 3 生产包：元素上没有 __vueParentComponent，从挂载点的 _vnode 往下走组件树，
 * 找 props.data 是“带 applyId 的对象数组”的组件（2026-11-20 实测是 JdProVTable）。
 * @param {number} waitMs 列表加载出商品行最多等这么久
 * @returns {Promise<{applyId: string, productId: string, productName: string, created: number}[]|null>}
 *   null：页面上找不到 Vue 挂载点（页面结构变了，改用读文字）；[]：等到超时也没有商品行
 */
export async function readApplyRecordsInPage(waitMs) {
  const MAX_NODES = 20000;
  const isRows = (v) => Array.isArray(v) && v.length > 0 && v[0] !== null && typeof v[0] === 'object' && 'applyId' in v[0];
  const find = (roots) => {
    const stack = [...roots];
    for (let seen = 0; stack.length && seen < MAX_NODES; seen += 1) {
      const vn = stack.pop();
      if (!vn || typeof vn !== 'object') continue;
      const c = vn.component;
      if (c) {
        let data = null;
        try {
          data = c.props && c.props.data;
        } catch {
          /* 读不了的 props 跳过 */
        }
        if (isRows(data)) return data;
        stack.push(c.subTree);
      }
      if (vn.suspense) stack.push(vn.suspense.activeBranch);
      if (Array.isArray(vn.children)) stack.push(...vn.children);
    }
    return null;
  };
  const end = Date.now() + waitMs;
  for (;;) {
    const roots = [...document.querySelectorAll('*')].filter((e) => e.__vue_app__ && e._vnode).map((e) => e._vnode);
    const rows = roots.length ? find(roots) : null;
    if (rows) {
      return rows.map((r) => ({
        applyId: String((r && r.applyId) ?? ''),
        productId: String((r && r.productId) ?? ''),
        productName: String((r && r.productName) ?? ''),
        created: Number(r && r.created) || 0,
      }));
    }
    if (Date.now() > end) return roots.length ? [] : null;
    await new Promise((r) => setTimeout(r, 500));
  }
}

/**
 * 发布页跳走后，在跳转到的页面（同域名）读回发布接口的结果（注入页面执行，必须自包含）。
 * 发布页脚本 backend-media.js 拿到发布接口返回时写进 sessionStorage['__jdmove_publish__']，带上这次点击的 nonce；
 * nonce 对不上（上一次发布留下的）不认。读到后删掉
 * @param {string} nonce
 * @returns {{nonce: string, applyId?: string, serverTime?: number, skuIds?: string[], productId?: string, failure?: string|null, text?: string}|null}
 */
export function readPublishMarkInPage(nonce) {
  const KEY = '__jdmove_publish__';
  try {
    const mark = JSON.parse(sessionStorage.getItem(KEY) || 'null');
    if (!mark || !nonce || mark.nonce !== nonce) return null;
    sessionStorage.removeItem(KEY);
    return mark;
  } catch {
    return null;
  }
}
