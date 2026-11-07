// 商品页主数据（wareInfoReadMap）里 VC 自营发布要用的字段（纯函数）。
// 京东自营与 VC 供应商后台共用同一套类目 ID 和品牌 ID，所以可以直接拿来打开 VC 发布页。

const CATEGORY_KEYS = ['category_id1', 'category_id2', 'category_id', 'category_id4'];

const str = (v) => (v == null ? '' : String(v)).trim();

/** 正数；不是数字、为 0 或负数时返回 null */
function positive(v) {
  const n = Number(str(v));
  return Number.isFinite(n) && n > 0 ? n : null;
}

const isId = (v) => /^\d+$/.test(v) && Number(v) > 0;

/**
 * @param {Record<string, unknown> | null | undefined} wareInfo 商品页 wareInfoReadMap 的节选
 * @returns {{cateIds: string[], brandId: number|null, model: string, weightKg: number|null,
 *   lengthMm: number|null, widthMm: number|null, heightMm: number|null, warranty: string}}
 *   cateIds：一级到末级类目 ID（三级类目的商品没有第四级）；长宽高单位 mm，毛重单位 kg
 */
export function vcSourceInfo(wareInfo) {
  const w = wareInfo ?? {};
  const ids = CATEGORY_KEYS.map((k) => str(w[k])).filter(isId);
  return {
    cateIds: [...new Set(ids)],
    brandId: positive(w.brand_id),
    model: str(w.model),
    weightKg: positive(w.weight),
    lengthMm: positive(w.length),
    widthMm: positive(w.width),
    heightMm: positive(w.height),
    warranty: str(w.warranty),
  };
}
