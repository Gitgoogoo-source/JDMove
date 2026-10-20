// 店铺列表里的 SPU 展开成全部 SKU（纯函数）
//
// 店铺“全部商品”页每张卡片是一个 SPU：主图/标题链接只指向一个主 SKU，
// 卡片下方的规格缩略图（li[sid]）是同一 SPU 的其他 SKU，但最多只显示 5 个。
// 缩略图少于 5 个时列表上已是全部规格；正好 5 个（可能被截断）或模板不显示缩略图时，
// 打开主 SKU 的商品页读取全部规格的 SKU 编码，商品链接即 item.jd.com/{SKU}.html。

/** 卡片上最多显示的规格缩略图数量（实测 14 个规格的 SPU 也只显示 5 个） */
export const THUMB_LIMIT = 5;

const SKU_RE = /^\d{6,}$/;
const skuOrNull = (v) => {
  const t = String(v ?? '').trim();
  return SKU_RE.test(t) ? t : null;
};
const uniqueSkus = (list) => [...new Set((Array.isArray(list) ? list : []).map(skuOrNull).filter(Boolean))];

/**
 * @typedef {{sku: string, sids: string[]|null}} Spu sids 为卡片上的缩略图 SKU；null 表示模板不显示缩略图
 */

/**
 * 整理页面脚本读到的 SPU（页面数据不可信：丢弃无效编码，同一主 SKU 只保留第一次）
 * @param {unknown} raw
 * @returns {Spu[]}
 */
export function normalizeSpus(raw) {
  const seen = new Set();
  const out = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    const sku = skuOrNull(item?.sku);
    if (!sku || seen.has(sku)) continue;
    seen.add(sku);
    out.push({ sku, sids: Array.isArray(item.sids) ? uniqueSkus(item.sids) : null });
  }
  return out;
}

/**
 * 列表上能直接看到的 SKU：主 SKU + 缩略图，保持顺序去重
 * @param {Spu[]} spus
 * @returns {string[]}
 */
export function spuListSkus(spus) {
  return [...new Set(spus.flatMap((s) => [s.sku, ...(s.sids ?? [])]))];
}

/**
 * 是否需要打开主 SKU 的商品页读取全部规格
 * @param {Spu} spu
 * @param {Set<string>} fromItemPages 已打开过的商品页里读到的全部 SKU（同一 SPU 的 SKU 不再重复打开）
 */
export function needsItemPage(spu, fromItemPages) {
  if (fromItemPages.has(spu.sku)) return false;
  return spu.sids == null || spu.sids.length >= THUMB_LIMIT;
}

/**
 * 商品页读到的 SKU 编码：只保留数字编码并去重，主 SKU 在最前；没读到时返回空数组
 * @param {{skuIds?: unknown}|null} res
 * @param {string} mainSku
 * @returns {string[]}
 */
export function normalizeItemSkus(res, mainSku) {
  const ids = uniqueSkus(res?.skuIds);
  if (!ids.length) return [];
  return ids.includes(mainSku) ? [mainSku, ...ids.filter((id) => id !== mainSku)] : ids;
}
