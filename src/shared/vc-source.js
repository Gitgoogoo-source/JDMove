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

/** features2 是 “键:值;键:值” 的字符串，值里可能还有冒号 */
function parseFeatures(text) {
  const out = {};
  for (const part of str(text).split(';')) {
    const at = part.indexOf(':');
    if (at > 0) out[part.slice(0, at).trim()] = part.slice(at + 1).trim();
  }
  return out;
}

/** sale_attributes 是 JSON 字符串：[{saleName, saleValue}]，解析失败时返回空数组 */
function parseSaleAttrs(text) {
  let list;
  try {
    list = JSON.parse(str(text) || '[]');
  } catch {
    return [];
  }
  if (!Array.isArray(list)) return [];
  return list
    .map((a) => ({ name: str(a?.saleName), value: str(a?.saleValue) }))
    .filter((a) => a.name && a.value);
}

/** 危险品标记：1 是、0 否，其他（缺失）为 null */
function dangerFlag(v) {
  const s = str(v);
  if (s === '1') return true;
  if (s === '0') return false;
  return null;
}

/**
 * @param {Record<string, unknown> | null | undefined} wareInfo 商品页 wareInfoReadMap 的节选
 * @returns {{cateIds: string[], brandId: number|null, model: string, weightKg: number|null,
 *   lengthMm: number|null, widthMm: number|null, heightMm: number|null, warranty: string,
 *   spuId: string, seriesId: string, dangerGoods: boolean|null, shortTitle: string, titleNoBrand: string,
 *   saleAttrs: {name: string, value: string}[]}}
 *   cateIds：一级到末级类目 ID（三级类目的商品没有第四级）；长宽高单位 mm，毛重单位 kg；
 *   spuId：realSpuId（没有时用 main_sku_id）；titleNoBrand：京东给的去掉品牌的商品名
 */
export function vcSourceInfo(wareInfo) {
  const w = wareInfo ?? {};
  const ids = CATEGORY_KEYS.map((k) => str(w[k])).filter(isId);
  const features = parseFeatures(w.features2);
  return {
    cateIds: [...new Set(ids)],
    brandId: positive(w.brand_id),
    model: str(w.model),
    weightKg: positive(w.weight),
    lengthMm: positive(w.length),
    widthMm: positive(w.width),
    heightMm: positive(w.height),
    warranty: str(w.warranty),
    spuId: [str(w.realSpuId), str(w.main_sku_id)].find(isId) ?? '',
    seriesId: isId(str(w.seriesId)) ? str(w.seriesId) : '',
    dangerGoods: dangerFlag(w.isdangergoods),
    shortTitle: features.shortTitle ?? '',
    titleNoBrand: features.skuNameWithoutBrand ?? '',
    saleAttrs: parseSaleAttrs(w.sale_attributes),
  };
}
