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
 * @returns {{cateIds: string[], brandId: number|null, model: string, itemNum: string, weightKg: number|null,
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
    itemNum: str(w.item_num),
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

// 型号的来源：主数据型号 > 主数据货号（POP 商品的 model 常是空的，item_num 有值）> 参数里的这些名称（按顺序）
const MODEL_PARAM_NAMES = ['型号', '产品型号', '规格型号', '货号', '款号'];
// 主数据没登记包装尺寸/毛重时是 0，或者是占位值：长宽高都是 1 mm、毛重 0.01 kg（2026-11 实测京喜自营官方店 10120802107169）
const PLACEHOLDER_MAX_MM = 1;
const PLACEHOLDER_MAX_KG = 0.01;
const DIM_KEYS = ['lengthMm', 'widthMm', 'heightMm'];

/** 型号和来源说明；SKU 编号不算型号 */
function sourceModel(product) {
  const vc = product?.vc ?? {};
  const skuId = str(product?.skuId);
  const params = product?.params ?? [];
  const candidates = [
    { value: vc.model, from: '型号' },
    { value: vc.itemNum, from: '货号' },
    ...MODEL_PARAM_NAMES.map((name) => ({ value: params.find((p) => str(p?.name) === name)?.value, from: `参数“${name}”` })),
  ];
  const hit = candidates.map((c) => ({ ...c, value: str(c.value) })).find((c) => c.value && c.value !== skuId);
  return hit ? { model: hit.value, modelFrom: hit.from } : { model: '', modelFrom: '' };
}

/** 长宽高三项都 ≤1 mm 时是占位值，三项一起丢掉 */
function sourceDims(vc) {
  const dims = DIM_KEYS.map((k) => positive(vc?.[k]));
  const fake = dims.every((d) => d != null && d <= PLACEHOLDER_MAX_MM);
  return {
    values: Object.fromEntries(DIM_KEYS.map((k, i) => [k, fake ? null : dims[i]])),
    placeholder: fake ? `长宽高 ${dims.join('×')} mm` : '',
  };
}

function sourceWeight(vc) {
  const kg = positive(vc?.weightKg);
  const fake = kg != null && kg <= PLACEHOLDER_MAX_KG;
  return { weightKg: fake ? null : kg, placeholder: fake ? `毛重 ${kg} kg` : '' };
}

/**
 * VC 发布用的源商品型号、包装长宽高（mm）、毛重（kg）：只取可信的值，并说明来源（发布计划和编辑弹窗共用）。
 * 0 算没有；占位值也算没有，记在 placeholders 里，用来告诉用户为什么缺
 * @param {{skuId?: string, params?: {name: string, value: string}[], vc?: object} | null | undefined} product 归一化后的商品
 * @returns {{model: string, modelFrom: string, lengthMm: number|null, widthMm: number|null, heightMm: number|null,
 *   weightKg: number|null, placeholders: string[]}} modelFrom：'型号' | '货号' | '参数“…”' | ''（没有型号）
 */
export function vcSourceFields(product) {
  const dims = sourceDims(product?.vc);
  const weight = sourceWeight(product?.vc);
  return {
    ...sourceModel(product),
    ...dims.values,
    weightKg: weight.weightKg,
    placeholders: [dims.placeholder, weight.placeholder].filter(Boolean),
  };
}
