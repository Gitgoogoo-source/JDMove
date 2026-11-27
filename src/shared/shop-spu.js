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

/** 整理店铺列表 / 规格名文本（去首尾空白、合并连续空格） */
export const cleanShopTitle = (raw) => (typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : '');

/**
 * 组合 SPU 标题与子规格名称：标题里已包含该规格字样时不重复追加
 * @param {string} baseTitle
 * @param {string} [spec]
 */
export function formatVariantTitle(baseTitle, spec = '') {
  const base = cleanShopTitle(baseTitle);
  const label = cleanShopTitle(spec);
  if (!base) return label;
  if (!label || base.includes(label)) return base;
  return `${base}（${label}）`;
}

function normalizeSpecs(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    const sku = skuOrNull(k);
    const label = cleanShopTitle(v);
    if (sku && label) out[sku] = label;
  }
  return Object.keys(out).length ? out : null;
}

/**
 * @typedef {{sku: string, sids: string[]|null, title?: string, specs?: Record<string, string>}} Spu
 *   sids 为卡片上的缩略图 SKU；null 表示模板不显示缩略图；title 为卡片主标题；specs 为缩略图 SKU 的规格名
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
    const title = cleanShopTitle(item?.title);
    const specs = normalizeSpecs(item?.specs);
    out.push({
      sku,
      sids: Array.isArray(item.sids) ? uniqueSkus(item.sids) : null,
      ...(title ? { title } : {}),
      ...(specs ? { specs } : {}),
    });
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
 * 列表上直接抓到的商品名称（主 SKU 用卡片标题，缩略图 SKU 优先附带规格名；不覆盖别的卡片的主 SKU 精确标题）
 * @param {Spu[]} spus
 * @returns {Record<string, string>}
 */
export function spuListTitles(spus) {
  const titles = {};
  for (const spu of spus) {
    if (spu.title) titles[spu.sku] = spu.title;
  }
  for (const spu of spus) {
    for (const sid of spu.sids ?? []) {
      if (titles[sid]) continue;
      const t = formatVariantTitle(spu.title, spu.specs?.[sid]);
      if (t) titles[sid] = t;
    }
  }
  return titles;
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

/**
 * 展开 SPU 时顺带整理出每个规格 SKU 的商品名称（不额外打开其他规格页面）
 * @param {{skuIds?: unknown, title?: unknown, specs?: unknown}|null} res
 * @param {string} mainSku
 * @param {string} [fallbackTitle] 店铺列表卡片上抓到的主标题
 * @returns {Record<string, string>}
 */
export function normalizeItemTitles(res, mainSku, fallbackTitle = '') {
  const ids = normalizeItemSkus(res, mainSku);
  if (!ids.length) return {};
  const baseTitle = cleanShopTitle(res?.title) || cleanShopTitle(fallbackTitle);
  const specs = normalizeSpecs(res?.specs) ?? {};
  const titles = {};
  for (const id of ids) {
    const t = id === mainSku ? baseTitle : formatVariantTitle(baseTitle, specs[id]);
    if (t) titles[id] = t;
  }
  return titles;
}
