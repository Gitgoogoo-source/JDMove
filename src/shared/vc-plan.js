// VC 自营发布的填写计划（纯函数）。字段和规则来自 2026-11 在 wares-jdm.jd.com/vcProductPublish 上的走查：
// 品牌在类目页选定、标题不含品牌（前缀由页面加）、市场价/京东价/采购价/采购员/销售员手动填写、
// 包装长宽高和毛重必填、SKU 表只有商品名称/规格/SKU属性/条形码（没有价格库存列）
import { cleanTitle, truncateWeighted, weightedLength } from './title.js';
import { buildPropPlan, convertInputValue, findSourceValue } from './attr-mapping.js';
import { matchCategoryMap } from './category-pick.js';
import { parseAttrDefaults } from './settings.js';
import { publishImagePlan } from './publish-plan.js';
import { normalizeUpc, productUpc, skuAttrValueMap } from './sku-attrs.js';
import { parseSpecText, quantitiesByUnit } from './vc-spec.js';
import { vcFormEntries, vcWeightKg } from './vc-form-values.js';
import { ERP_LABELS, vcErpCodes } from './vc-erp.js';
import { vcSourceFields } from './vc-source.js';

export { vcWeightKg };

const VC_TITLE_MAX = 60;
const SKU_NAME_MAX = 60;
// 5 个采集不到、需要手动填写的字段里的 3 个价格（采购员/销售员共用 ERP，单独处理）
export const VC_PRICE_LABELS = { marketPrice: '市场价', jdPrice: '京东价', costPrice: '采购价' };
const DIM_LABELS = { lengthMm: '长', widthMm: '宽', heightMm: '高', weightKg: '毛重' };
const PROMO_RE = /【[^】]*】/g;
// 销售单位：包装形式或规格里出现的容器词
const UNIT_WORDS = ['箱', '提', '包', '袋', '盒', '瓶', '罐', '桶', '支', '卷', '条', '片', '块', '套', '组', '件'];
const DEFAULT_SALE_UNIT = '件';
const PACK_PARAM_NAMES = ['包装形式', '包装', '包装方式'];

const positive = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};
const isId = (v) => /^\d+$/.test(String(v ?? '')) && Number(v) > 0;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 品牌名的各种写法：维达（Vinda）→ 维达（Vinda）、维达(Vinda)、Vinda、维达 */
function brandVariants(brandName) {
  const full = String(brandName ?? '').trim();
  if (!full) return [];
  const m = full.match(/^(.*?)[（(](.*?)[）)]$/);
  const parts = m ? [`${m[1]}（${m[2]}）`, `${m[1]}(${m[2]})`, m[1], m[2]] : [full];
  return [...new Set(parts.map((p) => p.trim()).filter(Boolean))].sort((a, b) => b.length - a.length);
}

const MIN_BRAND_CHARS = 2;
const LATIN_START_RE = /^[A-Za-z]/;

/**
 * 去掉标题里的品牌：带括号的完整写法（维达（Vinda））在任何位置都删；
 * 简称（维达、Vinda）只删开头的，英文简称后面还不能紧跟字母（品牌 Pro 不动 Professional），避免误删标题中间同字的词
 */
function stripBrand(text, brandName) {
  const variants = brandVariants(brandName).filter((v) => [...v].length >= MIN_BRAND_CHARS);
  let out = variants.filter((v) => /[（(]/.test(v)).reduce((t, b) => t.replace(new RegExp(escapeRe(b), 'gi'), ' '), text);
  const leading = variants.map((v) => new RegExp(`^${escapeRe(v)}${LATIN_START_RE.test(v) ? '(?![A-Za-z])' : ''}`, 'i'));
  for (let hit = true; hit; ) {
    out = out.trimStart();
    const re = leading.find((r) => r.test(out));
    hit = Boolean(re);
    if (re) out = out.replace(re, ' ');
  }
  return out;
}

/** 去掉【】宣传语和品牌后的标题（不清洗、不截断）：用来判断商品是什么，比如自动选末级类目 */
export const titleWithoutBrand = (raw, brandName) => stripBrand(String(raw ?? '').replace(PROMO_RE, ' '), brandName).trim();

/**
 * VC 标题：去掉【】里的宣传语和品牌（页面自动加品牌前缀，标题里再写品牌会重复），再按设置清洗、截断到 60 字符
 * @param {string} raw
 * @param {string} brandName
 * @param {{removeWords?: string[], prefix?: string, suffix?: string, maxLength?: number}} titleOpts
 */
export function vcTitle(raw, brandName, titleOpts = {}) {
  const noPromo = String(raw ?? '').replace(PROMO_RE, ' ');
  const noBrand = stripBrand(noPromo, brandName);
  const maxLength = Math.min(titleOpts.maxLength ?? VC_TITLE_MAX, VC_TITLE_MAX);
  return cleanTitle(noBrand, { ...titleOpts, maxLength });
}

/**
 * VC 发布页要的末级类目和品牌：类目按 手动指定 > 类目映射 > 源商品主数据；品牌按 编辑里的品牌ID > 源商品
 * @returns {{target: {categoryId: string, cateList: string[], brandId: number, name: string, from: string}} | {error: string}}
 */
export function vcTarget({ product, edits = {}, settings }) {
  const category = vcCategory(product, edits, settings);
  if (!category) return { error: '源商品没有类目ID（之前采集的商品请重新采集），也可以在「编辑」中填写类目ID路径' };
  const brandId = [edits.vc?.brandId, product?.vc?.brandId, product?.brand?.id].map(positive).find(Boolean);
  if (!brandId) return { error: '缺少品牌ID：VC 发布页需要先选定已授权品牌，请重新采集或在「编辑」中填写品牌ID' };
  return { target: { ...category, brandId } };
}

function vcCategory(product, edits, settings) {
  const pick = (ids, name, from) => {
    const cateList = (ids ?? []).map(String).filter(isId);
    return cateList.length ? { categoryId: cateList.at(-1), cateList, name, from } : null;
  };
  if (edits.cateList?.length) return pick(edits.cateList, edits.cateName || '手动指定', 'manual');
  const mapped = matchCategoryMap(settings?.categoryMap, product?.crumbs);
  if (mapped) return pick(mapped.cateList, mapped.name || mapped.source, 'map');
  return pick(product?.vc?.cateIds, product?.leafCategory || '源商品类目', 'source');
}

/** 编辑里的值优先，没有时用源商品里可信的值（型号可以退到货号；0 和占位值不算，见 vcSourceFields） */
const vcField = (product, edits, key) => {
  const own = edits.vc?.[key];
  if (key === 'model') return String(own ?? '').trim() || vcSourceFields(product).model;
  return positive(own) ?? vcSourceFields(product)[key];
};

const EDIT_HINT = '请在「编辑 → VC 自营」中填写';
const RECOLLECT_HINT = '之前采集的商品请重新采集，或在「编辑」中填写';

/** 源商品为什么没有这些值：旧数据没采主数据 / 主数据里是占位值 / 主数据里就没有（POP 商品常见，重新采集也不会有） */
function missingHint(product) {
  if (!product?.vc) return RECOLLECT_HINT;
  const { placeholders } = vcSourceFields(product);
  if (placeholders.length) return `源商品主数据里是占位值：${placeholders.join('，')}；${EDIT_HINT}`;
  return `源商品主数据里没有（POP 店铺的商品常见），${EDIT_HINT}`;
}

const modelHint = (product) => (product?.vc ? `源商品没有型号和货号，${EDIT_HINT}` : RECOLLECT_HINT);

function priceBlockers(prices) {
  const missing = Object.entries(VC_PRICE_LABELS).filter(([k]) => !prices[k]).map(([, label]) => label);
  if (missing.length) return [`缺少 VC 价格：${missing.join('、')}（这几项采集不到，请在「编辑」中填写）`];
  if (prices.jdPrice > prices.marketPrice) return [`京东价不能高于市场价（京东价 ¥${prices.jdPrice}，市场价 ¥${prices.marketPrice}）`];
  return [];
}

const vcPrices = (edits) => Object.fromEntries(Object.keys(VC_PRICE_LABELS).map((k) => [k, positive(edits.vc?.[k])]));

/** 标题：编辑里的优先；否则用京东给的无品牌商品名（没有时用完整标题）去品牌、清洗 */
const planTitle = (product, edits, settings) =>
  edits.title?.trim() || vcTitle(product?.vc?.titleNoBrand || product?.title, product?.brand?.name, settings.title);

/** 价格、长宽高、毛重的格式和范围（缺项上面单独报，这里只报写进去页面也会拦的值） */
function formatBlockers(product, edits) {
  const logistics = {
    length: vcField(product, edits, 'lengthMm'),
    wide: vcField(product, edits, 'widthMm'),
    height: vcField(product, edits, 'heightMm'),
    weight: vcWeightKg(vcField(product, edits, 'weightKg')),
  };
  return vcFormEntries({ prices: vcPrices(edits), logistics }).errors.filter((e) => !e.startsWith('缺少'));
}

/**
 * 打开发布页之前就能判断的缺项（不需要表单结构），缺了就不打开页面
 * @returns {{blockers: string[]}}
 */
export function vcPreflight({ product, edits = {}, settings }) {
  const title = planTitle(product, edits, settings);
  const missingDims = Object.entries(DIM_LABELS).filter(([k]) => !vcField(product, edits, k)).map(([, l]) => l);
  const { mainImageUrls } = publishImagePlan({ product, edits, settings });
  const blockers = [
    ...(title ? [] : ['缺少标题']),
    ...priceBlockers(vcPrices(edits)),
    ...(vcField(product, edits, 'model') ? [] : [`缺少型号（${modelHint(product)}）`]),
    ...(missingDims.length ? [`缺少包装长宽高/毛重：${missingDims.join('、')}（${missingHint(product)}）`] : []),
    ...(mainImageUrls.length ? [] : ['缺少主图']),
    ...(product?.detailImages?.length ? [] : ['缺少详情图（采集时没有拿到详情图，请重新采集后再发布）']),
    ...formatBlockers(product, edits),
  ];
  return { blockers };
}

/** 单规格商品的规格文本（采集时只保留了链接对应的规格）；规格按钮没采到时用主数据里的销售属性 */
function specTextOf(product) {
  const values = Object.values(product?.variants?.[0]?.values ?? {});
  if (values.length) return values.join(' ');
  return (product?.vc?.saleAttrs ?? []).map((a) => a.value).join(' ');
}

const squash = (s) => String(s).replace(/\s+/g, '');

/** SKU 商品名称：标题 + 标题里还没有的规格内容；超长时截标题，保留规格 */
function skuName(title, spec) {
  const tokens = [spec.desc, ...spec.text.replace(PROMO_RE, ' ').replace(/[[\]]/g, ' ').split(/\s+/)].filter(Boolean);
  const extra = [...new Set(tokens)].filter((t) => !squash(title).includes(squash(t))).join(' ');
  if (!extra) return truncateWeighted(title, SKU_NAME_MAX);
  const budget = SKU_NAME_MAX - weightedLength(` ${extra}`);
  return budget > 0 ? `${truncateWeighted(title, budget).trim()} ${extra}` : truncateWeighted(extra, SKU_NAME_MAX);
}

function inferSaleUnit(product, spec) {
  const pack = PACK_PARAM_NAMES.map((n) => (product?.params ?? []).find((p) => p.name === n)?.value).find(Boolean) ?? '';
  // 取文字里最先出现的容器词：“盒装（含6瓶，整箱发货）”是盒
  const fromPack = UNIT_WORDS.map((u) => [u, pack.indexOf(u)])
    .filter(([, at]) => at >= 0)
    .sort((a, b) => a[1] - b[1])[0]?.[0];
  if (fromPack) return { unit: fromPack, from: `包装形式 ${pack}` };
  const fromSpec = spec.quantities.map((q) => q.unit).filter((u) => UNIT_WORDS.includes(u)).at(-1);
  if (fromSpec) return { unit: fromSpec, from: `规格 ${spec.text}` };
  return { unit: DEFAULT_SALE_UNIT, from: '默认' };
}

function shelfLifeDays(source) {
  const found = findSourceValue('保质期', source);
  return found ? positive(convertInputValue(found.value, '天')) : null;
}

function logisticsOf(product, edits, settings, source, saleUnit) {
  return {
    length: vcField(product, edits, 'lengthMm'),
    wide: vcField(product, edits, 'widthMm'),
    height: vcField(product, edits, 'heightMm'),
    weight: vcWeightKg(vcField(product, edits, 'weightKg')),
    unit: saleUnit,
    packSpecification: settings.vc.packSpecification,
    packType: settings.vc.packType,
    warranty: product?.vc?.warranty || settings.vc.warranty,
    // 采集到的包装清单优先于设置：设置里的是所有商品共用的一句话
    packListing: String(edits.vc?.packListing ?? '').trim() || product?.packList || settings.packList || `${product?.leafCategory || '商品'}*1`,
    sldays: shelfLifeDays(source),
  };
}

function saleUnitWarning(unit) {
  if (unit.fromSettings) return [];
  if (unit.from === '默认') return [`销售单位推断不出来，先填“${unit.unit}”：请在设置的「VC 自营 → 销售单位」中指定`];
  return [`销售单位按推断填写：${unit.unit}（依据：${unit.from}），请核对`];
}

/** 没填的 ERP：两个都没填 / 只缺一个时分别提醒 */
function erpWarning(erp) {
  if (!erp.buyer && !erp.saler) return ['采购员/销售员 ERP 没有填写，沿用页面上的默认值，请核对'];
  const missing = Object.entries(ERP_LABELS).filter(([k]) => !erp[k]).map(([, label]) => label);
  return missing.length ? [`${missing.join('、')} 没有填写，沿用页面上的默认值，请核对`] : [];
}

/** 型号不是从编辑或主数据型号来的（用了货号/参数）时提醒核对 */
function modelWarning(product, edits) {
  if (String(edits.vc?.model ?? '').trim()) return [];
  const { model, modelFrom } = vcSourceFields(product);
  return model && modelFrom !== '型号' ? [`型号用的是源商品的${modelFrom}「${model}」，请核对`] : [];
}

function planWarnings({ props, erp, prices, unit, upc, dangerGoods }) {
  const guessed = props.report
    .filter((r) => r.status === 'guessed')
    .map((r) => `属性按推断填写，请核对：${r.title}=${r.label ?? r.raw}（依据：${r.source}）`);
  return [
    ...guessed,
    ...erpWarning(erp),
    ...(prices.costPrice && prices.jdPrice && prices.costPrice >= prices.jdPrice
      ? [`采购价 ¥${prices.costPrice} 不低于京东价 ¥${prices.jdPrice}，毛利为负，请核对`]
      : []),
    ...saleUnitWarning(unit),
    ...(dangerGoods ? ['源商品是危险品：请在发布页核对“危险品”相关选项'] : []),
    ...(upc ? [] : ['没有商品条形码：自营商品入仓需要条形码，请在「编辑 → UPC」中填写']),
  ];
}

/**
 * @param {{product: object, edits?: object, settings: object, schema: {attrs?: object[]}}} input
 */
export function buildVcPublishPlan({ product, edits = {}, settings, schema }) {
  const { blockers } = vcPreflight({ product, edits, settings });
  const attrDefaults = parseAttrDefaults(settings.attrDefaultsText);
  const overrides = edits.attrOverrides ?? {};
  const overrideParams = Object.entries(overrides).map(([name, value]) => ({ name, value }));
  const source = { ...product, params: [...overrideParams, ...(product.params ?? [])] };

  const props = buildPropPlan(schema?.attrs ?? [], source, { defaults: { ...attrDefaults, ...overrides } });
  if (props.missingRequired.length) {
    blockers.push(`必填属性未匹配：${props.missingRequired.join('、')}（源商品页没有这些信息，请在「编辑 → 属性覆盖」或设置的「属性默认值」中填写）`);
  }
  const title = planTitle(product, edits, settings);
  const spec = parseSpecText(specTextOf(product));
  const unit = settings.vc.saleUnit ? { unit: settings.vc.saleUnit, fromSettings: true } : inferSaleUnit(product, spec);
  // 采购员 / 销售员 ERP：编辑里单独填的 > 编辑里共用的 > 设置里的默认 ERP
  const erp = vcErpCodes(edits.vc, settings.vc.erpCode);
  const prices = vcPrices(edits);
  // VC 不用默认 UPC：同一个条码填到所有商品上会被判重码，入仓还要贴码
  const upc = normalizeUpc(edits.upc) || productUpc(product);
  const { mainImageUrls, detailImageUrls } = publishImagePlan({ product, edits, settings });
  const model = vcField(product, edits, 'model');
  const logistics = logisticsOf(product, edits, settings, source, unit.unit);
  const form = vcFormEntries({ model, prices, logistics });
  // 缺项和价格/长宽高的格式 vcPreflight 已经报过
  const formBlockers = form.errors.filter((e) => !e.startsWith('缺少') && !blockers.includes(e));

  return {
    title,
    model,
    erp,
    prices,
    logistics,
    // 按页面格式转好的字符串，页面脚本原样写入（不写数字：数字会被保存接口拒收）
    form: form.entries,
    props,
    images: { mainImageUrls, detailImageUrls, transparentUrl: mainImageUrls[0] ?? null, aiRecUrl: mainImageUrls[0] ?? null },
    sku: { name: skuName(title, spec), spec, upc },
    skuAttrValues: skuAttrValueMap({ params: product.params ?? [], defaults: attrDefaults, overrides }),
    skuAttrUnits: quantitiesByUnit(spec.quantities),
    // 源商品的危险品标记（true/false/null）：页面选项结构没走查过，只提醒不填写
    dangerGoods: product.vc?.dangerGoods ?? null,
    warnings: [
      ...modelWarning(product, edits),
      ...planWarnings({ props, erp, prices, unit, upc, dangerGoods: product.vc?.dangerGoods }),
      ...form.warnings,
    ],
    blockers: [...blockers, ...formBlockers],
  };
}

/**
 * 设置里的“填写完成后”对应 VC 页面上的按钮：VC 只有“发布商品”（提交采销审核）和“保存草稿”。
 * VC 自营一律点“保存草稿”，由人工在草稿箱里检查后再提交；只有“只填写，不保存”时不点按钮
 * @returns {'vc_draft'|null} null = 只填写不保存
 */
export function vcActionLabel(action) {
  if (action === 'none') return null;
  return 'vc_draft';
}
