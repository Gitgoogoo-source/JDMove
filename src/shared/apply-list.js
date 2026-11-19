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
