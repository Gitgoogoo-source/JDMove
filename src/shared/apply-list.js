// 商品管理 → 商品审核（wareList?businessModel=1&activeTab=ApplyWare）列表的读取（纯函数）。
// 2026-11-19 实测：每行显示“品牌+商品标题”“商品编码: 100448634314”“提交: 2026-11-09 17:21:58”，
// 单 SKU 商品的商品编码就是京东分配的 SKU（详情页 SKU 表里的 skuId）。
// 发布接口的返回没抓到（页面跳转太快）时，用这个列表按商品名称和提交时间找回 SKU

export const APPLY_LIST_URL = 'https://wares-jdm.jd.com/ware/wareList?businessModel=1&activeTab=ApplyWare';
// 列表上的提交时间只到秒，页面时间和本机时间可能有偏差：提交时间在点“发布商品”前这么久以内的都算
const SUBMIT_SLACK_MS = 120e3;

const SKU_RE = /商品编码\s*[:：]\s*(\d{6,20})/;
const TIME_RE = /提交\s*[:：]\s*(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})(?::(\d{2}))?/;
const squash = (s) => String(s ?? '').replace(/\s+/g, '');

/**
 * 列表行的文字 → 商品
 * @param {string[]} texts 每行的 innerText
 * @returns {{name: string, sku: string, submittedAt: number|null}[]}
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
 * 刚发布的商品的 SKU：名称一致（忽略空格）、提交时间不早于点“发布商品”的时间；有多个时取最近提交的
 * @param {{name: string, sku: string, submittedAt: number|null}[]} rows
 * @param {{name: string, since: number}} want
 * @returns {string} 找不到时为 ''
 */
export function pickPublishedSku(rows, { name, since }) {
  const target = squash(name);
  if (!target) return '';
  const hits = rows
    .filter((r) => squash(r.name) === target && r.submittedAt != null && r.submittedAt >= since - SUBMIT_SLACK_MS)
    .sort((a, b) => b.submittedAt - a.submittedAt);
  return hits[0]?.sku ?? '';
}

/**
 * 商品审核列表每一行的文字（注入页面执行，必须自包含）。
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
