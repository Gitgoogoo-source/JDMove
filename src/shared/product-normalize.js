// 把页面抓取到的原始数据归一化为统一商品模型（纯函数）
import { normalizeName } from './text.js';
import { parsePrice } from './pricing.js';
import { toOriginalImageUrl, jfsPathOf } from './url-utils.js';

const NOISE_PARAMS = new Set(['商品编号', '店铺', '店铺名称'].map(normalizeName));
const BAD_IMAGE_RE = /blank\.gif|loading|misc\.360buyimg\.com|^data:|\/\/static\.360buyimg\.com/i;

const str = (v) => (v == null ? '' : String(v)).trim();

function cleanDocTitle(docTitle) {
  return str(docTitle)
    .replace(/【行情[^】]*】/g, '')
    .replace(/^【[^】]*】/, '')
    .replace(/[-–—]\s*京东.*$/, '')
    .trim();
}

function dedupeImages(urls) {
  const seen = new Set();
  const out = [];
  for (const raw of urls) {
    const url = toOriginalImageUrl(str(raw));
    if (!url || BAD_IMAGE_RE.test(url)) continue;
    const key = jfsPathOf(url) ?? url;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(url);
  }
  return out;
}

function normalizeParams(pairs) {
  const seen = new Set();
  const out = [];
  for (const pair of pairs ?? []) {
    const name = str(pair?.[0]).replace(/[：:]$/, '');
    const value = str(pair?.[1]);
    const key = normalizeName(name);
    if (!key || !value || NOISE_PARAMS.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push({ name, value });
  }
  return out;
}

function fromColorSize(colorSize) {
  const list = Array.isArray(colorSize) ? colorSize.filter((x) => x && x.skuId != null) : [];
  if (list.length === 0) return null;
  const dimNames = [...new Set(list.flatMap((x) => Object.keys(x).filter((k) => k !== 'skuId')))];
  const saleDims = dimNames.map((name) => ({
    name,
    values: [...new Set(list.map((x) => str(x[name])).filter(Boolean))],
  }));
  const variants = list.map((x) => ({
    skuId: String(x.skuId),
    values: Object.fromEntries(dimNames.map((n) => [n, str(x[n])]).filter(([, v]) => v)),
  }));
  return { saleDims: saleDims.filter((d) => d.values.length > 0), variants };
}

function fromDomDims(domDims) {
  const dims = (domDims ?? []).filter((d) => d && str(d.name) && Array.isArray(d.values) && d.values.length);
  const saleDims = dims.map((d) => ({
    name: str(d.name),
    values: [...new Set(d.values.map((v) => str(v.text)).filter(Boolean))],
  }));
  // 只有单维度时 DOM 上的 skuId 才能一一对应
  const variants =
    dims.length === 1
      ? dims[0].values
          .filter((v) => v.skuId)
          .map((v) => ({ skuId: String(v.skuId), values: { [str(dims[0].name)]: str(v.text) } }))
      : [];
  return { saleDims, variants };
}

// 每个规格在京东上是独立 SKU、价格各不相同；默认只保留当前 SKU，避免用同一价格铺满所有规格
function onlyCurrent(dims, skuId) {
  const current = dims.variants.find((v) => v.skuId === skuId);
  if (!current) return { saleDims: [], variants: [] };
  return {
    saleDims: Object.entries(current.values).map(([name, value]) => ({ name, values: [value] })),
    variants: [current],
  };
}

/**
 * @param {object} raw 页面抓取结果（见 src/inject/jd-item-extract.js）
 * @param {{allVariants?: boolean}} [opts] allVariants=true 时保留全部规格
 */
export function normalizeProduct(raw = {}, opts = {}) {
  const pc = raw.pageConfig ?? null;
  const params = normalizeParams(raw.params);
  const brandParam = params.find((p) => normalizeName(p.name) === '品牌');
  const pcImages = Array.isArray(pc?.imageList) ? pc.imageList : [];
  const crumbs = (raw.crumbs ?? []).map(str).filter(Boolean);
  const skuId = str(raw.skuId || pc?.skuid);
  const allDims = fromColorSize(pc?.colorSize) ?? fromDomDims(raw.saleDims);
  const dims = opts.allVariants || allDims.variants.length === 0 ? allDims : onlyCurrent(allDims, skuId);
  const brandName = str(raw.brandText) || brandParam?.value || '';
  // 面包屑最后一级通常是品牌，倒数第二级才是叶子类目
  const leafIdx = brandName && crumbs.length > 1 && normalizeName(crumbs.at(-1)) === normalizeName(brandName) ? -2 : -1;

  return {
    skuId,
    url: str(raw.url),
    title: str(raw.domTitle) || str(pc?.name) || cleanDocTitle(raw.docTitle),
    brand: { id: Number.isFinite(Number(pc?.brand)) && pc?.brand ? Number(pc.brand) : null, name: brandName },
    crumbs,
    leafCategory: crumbs.at(leafIdx) ?? '',
    price: parsePrice(raw.priceText),
    params: params.filter((p) => p !== brandParam),
    mainImages: dedupeImages(pcImages.length ? pcImages : raw.mainImages ?? []),
    detailImages: dedupeImages(raw.detailImages ?? []),
    saleDims: dims.saleDims,
    variants: dims.variants,
    isSelf: raw.isSelf ?? null,
  };
}

/**
 * @returns {string[]} 缺失项列表（为空表示可发布）
 */
export function validateProduct(p) {
  const errs = [];
  if (!p?.title) errs.push('缺少标题');
  if (!p?.mainImages?.length) errs.push('缺少主图');
  if (!(p?.price > 0)) errs.push('缺少价格');
  return errs;
}
