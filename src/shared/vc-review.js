// 发布前检查（纯函数）：点「发布选中」后先弹窗，按每个商品对应的上架模板（templates/vc/）列出发布页要填的内容——
// 基本信息、价格与采销、包装物流、图片、商品属性、SKU属性——每一项发布时会填什么、从哪来、缺不缺。
// 缺的在弹窗里补，存进商品的编辑内容（和「编辑」弹窗是同一份数据）。判断用发布流程同一套规则（vcTarget / buildVcPublishPlan），
// 弹窗里“齐全”的商品，打开发布页之前的检查也会通过。商品匹配不到模板时可以自己选模板：选模板就是指定 VC 类目
import { buildVcPublishPlan, defaultPackListing, DEFAULT_DIMS, vcCategory, vcTarget, vcTitle } from './vc-plan.js';
import { vcSourceFields } from './vc-source.js';
import { decimalText, vcNumberRule } from './vc-form-values.js';
import { ERP_FORMAT_HINT, isErpCode, ownErp, withErp } from './vc-erp.js';
import { normalizeUpc, productUpc, UPC_LABEL } from './sku-attrs.js';
import { weightedLength } from './title.js';
import { ATTR_KEY_PREFIX, attrProblem, reviewPropAttrs, reviewSkuAttrs, skuValueSources } from './vc-review-attrs.js';
import { findCatalogTemplate, vcTemplateAttrs, vcTemplateCategory, vcTemplateFieldLimits, vcTemplateLabel, vcTemplateLeaves, vcTemplateSkuAttrs } from './vc-templates.js';

const TITLE_MAX = 60;
// 没有类目（源商品没读到类目ID、也没选模板）时缺项里的名字：选了模板就有类目
export const NO_CATEGORY = '上架模板（类目）';
export const REVIEW_GROUPS = { basic: '基本信息', price: '价格与采销', logistics: '包装与物流' };

/**
 * 弹窗里的字段。rule：vcNumberRule 的键（长宽高/毛重按模板换上下限）；field：模板 baseFields 的字段名
 * @type {ReadonlyArray<{key: string, label: string, group: string, input: 'text'|'number', step?: string, required?: boolean, rule?: string, field?: string}>}
 */
export const REVIEW_FIELDS = Object.freeze([
  { key: 'title', label: '商品标题', group: 'basic', input: 'text', required: true },
  { key: 'brandId', label: '品牌ID', group: 'basic', input: 'number', step: '1', required: true },
  { key: 'model', label: '型号', group: 'basic', input: 'text', required: true, field: 'features.model' },
  { key: 'upc', label: '商品条形码', group: 'basic', input: 'text' },
  { key: 'marketPrice', label: '市场价(元)', group: 'price', input: 'number', step: '0.01', required: true, rule: 'marketPrice' },
  { key: 'jdPrice', label: '京东价(元)', group: 'price', input: 'number', step: '0.01', required: true, rule: 'jdPrice' },
  { key: 'costPrice', label: '采购价(元)', group: 'price', input: 'number', step: '0.0001', required: true, rule: 'costPrice' },
  { key: 'buyer', label: '采购员ERP', group: 'price', input: 'text' },
  { key: 'saler', label: '销售员ERP', group: 'price', input: 'text' },
  { key: 'lengthMm', label: '包装长(mm)', group: 'logistics', input: 'number', step: '1', required: true, rule: 'length', field: 'length' },
  { key: 'widthMm', label: '包装宽(mm)', group: 'logistics', input: 'number', step: '1', required: true, rule: 'wide', field: 'wide' },
  { key: 'heightMm', label: '包装高(mm)', group: 'logistics', input: 'number', step: '1', required: true, rule: 'height', field: 'height' },
  { key: 'weightKg', label: '毛重(kg)', group: 'logistics', input: 'number', step: '0.001', required: true, rule: 'weight', field: 'weight' },
  { key: 'packListing', label: '包装清单', group: 'logistics', input: 'text', required: true, field: 'packListing' },
]);

const FIELD_BY_KEY = new Map(REVIEW_FIELDS.map((f) => [f.key, f]));
const ERP_KEYS = ['buyer', 'saler'];
const NUMBER_KEYS = new Set(REVIEW_FIELDS.filter((f) => f.input === 'number').map((f) => f.key));

const positive = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};
const withKey = (obj, key, value) => {
  const rest = Object.fromEntries(Object.entries(obj ?? {}).filter(([k]) => k !== key));
  return value === undefined ? rest : { ...rest, [key]: value };
};
const nonEmpty = (obj) => (obj && Object.keys(obj).length ? obj : undefined);

/** 输入框里显示的值：编辑里自己填的（没填时为空，显示自动值作提示） */
export function reviewOwnValue(edits, key) {
  if (key === 'title') return String(edits?.title ?? '');
  if (key === 'upc') return String(edits?.upc ?? '');
  if (key.startsWith(ATTR_KEY_PREFIX)) return String(edits?.attrOverrides?.[key.slice(ATTR_KEY_PREFIX.length)] ?? '');
  if (ERP_KEYS.includes(key)) return ownErp(edits?.vc)[key];
  return String(edits?.vc?.[key] ?? '');
}

/**
 * 把弹窗里填的一个值写进编辑内容（返回新对象，不改原对象）；空值表示清掉自己填的、改回自动值
 * @param {object} edits
 * @param {string} key REVIEW_FIELDS 的 key，或 attr:属性名
 * @param {unknown} raw
 */
export function applyReviewValue(edits, key, raw) {
  const text = String(raw ?? '').trim();
  if (key === 'title') return withKey(edits, 'title', text || undefined);
  if (key === 'upc') return withKey(edits, 'upc', normalizeUpc(text) || undefined);
  if (key.startsWith(ATTR_KEY_PREFIX)) {
    const overrides = withKey(edits?.attrOverrides, key.slice(ATTR_KEY_PREFIX.length), text || undefined);
    return withKey(edits, 'attrOverrides', nonEmpty(overrides));
  }
  if (!FIELD_BY_KEY.has(key)) return edits;
  const vc = edits?.vc ?? {};
  const value = NUMBER_KEYS.has(key) ? positive(text) ?? undefined : text || undefined;
  const next = ERP_KEYS.includes(key) ? withErp(vc, { ...ownErp(vc), [key]: text }) : withKey(vc, key, value);
  return withKey(edits, 'vc', nonEmpty(next));
}

/** 字段在这个类目的上下限：模板里有就用模板的 */
function numberRule(def, template) {
  const rule = vcNumberRule(def.rule);
  const limits = def.field ? vcTemplateFieldLimits(template, def.field) : null;
  return { ...rule, ...(limits?.min != null ? { min: limits.min } : {}), ...(limits?.max != null ? { max: limits.max } : {}) };
}

const rangeText = (r) => `${decimalText(r.min, r.decimals)}~${r.max}${r.unit ? ` ${r.unit}` : ''}`;
const decimalsOf = (n) => (String(n).split('.')[1] ?? '').length;
const baseMaxLength = (template, field) => template?.baseFields?.find((f) => f.field === field)?.maxLength ?? 0;

/**
 * 一个值合不合规：数字的范围和小数位数（按类目）、品牌ID整数、ERP格式、条形码、标题长度；合规时返回 ''
 * @param {string} key
 * @param {unknown} raw
 * @param {object|null} template
 * @param {{typed?: boolean}} [opts] typed：用户自己填的（检查小数位数）；采集到的值发布时会四舍五入，只查范围
 */
export function reviewValueError(key, raw, template = null, { typed = true } = {}) {
  const text = String(raw ?? '').trim();
  const def = FIELD_BY_KEY.get(key);
  if (!text || !def) return '';
  if (def.rule) {
    const r = numberRule(def, template);
    const n = Number(text);
    if (!Number.isFinite(n) || n <= 0) return `${def.label}要填正数`;
    if (typed && r.decimals > 0 && decimalsOf(n) > r.decimals) return `最多 ${r.decimals} 位小数`;
    const value = Number(decimalText(n, r.decimals));
    if (!(value >= r.min && value <= r.max)) return `超出本类目允许的范围（${rangeText(r)}）`;
    return '';
  }
  if (key === 'brandId') return /^\d+$/.test(text) && Number(text) > 0 ? '' : '品牌ID是数字';
  if (ERP_KEYS.includes(key)) return isErpCode(text) ? '' : ERP_FORMAT_HINT;
  if (key === 'upc') return normalizeUpc(text) ? '' : '不是有效的条形码（8~14 位数字，校验位要对）';
  if (key === 'title') return weightedLength(text) > TITLE_MAX ? `超过 ${TITLE_MAX} 个字符（汉字算 2 个）` : '';
  const max = baseMaxLength(template, def.field);
  return max && text.length > max ? `最多 ${max} 个字` : '';
}

/** 没自己填时发布用的值和来源；state：default 用了默认值 / warn 需要核对 */
function autoValue(key, { product, settings }) {
  const src = vcSourceFields(product);
  const scraped = (v, from = '采集') => (v ? { text: String(v), from } : { text: '' });
  switch (key) {
    case 'title':
      return scraped(vcTitle(product?.vc?.titleNoBrand || product?.title, product?.brand?.name, settings.title), '按源标题生成');
    case 'brandId':
      return scraped(positive(product?.vc?.brandId) ?? positive(product?.brand?.id));
    case 'model':
      if (!src.model) return { text: '' };
      return src.modelFrom === '型号' ? scraped(src.model) : { text: src.model, from: `采集（${src.modelFrom}）`, state: 'warn', note: '用的不是型号，请核对' };
    case 'upc': {
      const upc = productUpc(product);
      return upc ? scraped(upc) : { text: '', state: 'warn', note: '没有条形码：自营商品入仓需要条形码' };
    }
    case 'buyer':
    case 'saler':
      return settings.vc.erpCode ? scraped(settings.vc.erpCode, '设置') : { text: '', note: '留空沿用发布页默认的人' };
    case 'packListing':
      if (product?.packList) return scraped(product.packList);
      return settings.packList ? scraped(settings.packList, '设置') : scraped(defaultPackListing(product), '自动生成');
    default:
      if (!(key in DEFAULT_DIMS)) return { text: '' };
      if (src[key]) return scraped(src[key]);
      return { text: String(DEFAULT_DIMS[key]), from: '默认值', state: 'default', note: `源商品没有${src.placeholders.length ? '（是占位值）' : ''}，按默认值填写，请核对` };
  }
}

/** 字段之间的关系：京东价不能高于市场价；采购价不低于京东价时毛利为负 */
function crossCheck(key, prices) {
  if (key === 'jdPrice' && prices.jdPrice && prices.marketPrice && prices.jdPrice > prices.marketPrice) return { state: 'error', note: '京东价不能高于市场价' };
  if (key === 'costPrice' && prices.costPrice && prices.jdPrice && prices.costPrice >= prices.jdPrice) return { state: 'warn', note: '采购价不低于京东价，毛利为负' };
  return null;
}

/**
 * @typedef {{key: string, label: string, group: string, input: string, step?: string, required: boolean, own: string,
 *   auto: string, from: string, value: string, state: 'ok'|'missing'|'error'|'default'|'warn', note: string, limits: string}} ReviewField
 *   own：自己填的；auto/from：没填时用的值和来源；value：发布时会填的值；limits：取值范围说明
 */
function fieldState(def, ctx) {
  const own = reviewOwnValue(ctx.edits, def.key);
  const auto = autoValue(def.key, ctx);
  const value = own || auto.text;
  const error = value ? reviewValueError(def.key, value, ctx.template, { typed: Boolean(own) }) : '';
  const cross = crossCheck(def.key, ctx.prices);
  const limits = def.rule && def.field ? `范围 ${rangeText(numberRule(def, ctx.template))}` : '';
  const base = { ...def, required: Boolean(def.required), own, auto: auto.text, from: own ? '' : auto.from ?? '', value, limits };
  if (error) return { ...base, state: 'error', note: own ? error : `${auto.from}的值“${auto.text}”${error}，请填写` };
  if (cross?.state === 'error') return { ...base, ...cross };
  if (def.required && !value) return { ...base, state: 'missing', note: '缺少，必填' };
  if (cross) return { ...base, ...cross };
  if (!own && auto.state) return { ...base, state: auto.state, note: auto.note ?? '' };
  return { ...base, state: 'ok', note: own ? '' : auto.note ?? '' };
}

/**
 * 商品对应的上架模板：按发布时用的类目（手动指定 > 类目映射 > 源商品类目）在模板目录里找
 * @param {{product: object, edits?: object, settings: object, catalog: import('./vc-templates.js').VcTemplateCatalog}} input
 * @returns {{template: object|null, category: object|null, from: 'manual'|'map'|'source'|null}}
 */
export function reviewTemplate({ product, edits = {}, settings, catalog }) {
  const category = vcCategory(product, edits, settings);
  return { template: category ? findCatalogTemplate(catalog, category.cateList) : null, category, from: category?.from ?? null };
}

/** 模板下拉框的选项：每个模板一组，组里是可以发布的末级类目；值是“模板ID:末级类目ID” */
export function templateChoices(catalog) {
  return (catalog?.entries ?? [])
    .map((e) => catalog.byId.get(e.categoryId))
    .filter(Boolean)
    .map((t) => ({
      group: vcTemplateLabel(t),
      options: vcTemplateLeaves(t).map((leaf) => ({
        value: `${t.categoryId}:${leaf.id}`,
        label: leaf.name === t.categoryName ? t.categoryName : `${t.categoryName} > ${leaf.name}`,
      })),
    }));
}

/** 下拉框当前选中的值：自动匹配的为 ''；手动选的模板为“模板ID:末级类目ID”；手动指定的类目没有模板时为 null */
export function currentChoice({ template, category, from }) {
  if (from !== 'manual') return '';
  if (!template) return null;
  const leaf = vcTemplateLeaves(template).find((l) => l.id === category?.categoryId);
  return `${template.categoryId}:${leaf?.id ?? template.publishCategoryId}`;
}

/**
 * 选模板：存成编辑里的类目ID路径（发布页按它打开）；value 为 '' 时清掉手动指定的类目，改回自动匹配
 * @returns {object} 新的编辑内容
 */
export function applyTemplateChoice(edits, catalog, value) {
  if (!value) return withKey(withKey(edits, 'cateList', undefined), 'cateName', undefined);
  const [templateId, leafId] = String(value).split(':');
  const template = catalog?.byId.get(templateId);
  if (!template) return edits;
  const { cateList, cateName } = vcTemplateCategory(template, leafId);
  return { ...(edits ?? {}), cateList, cateName };
}

/** 不用手动指定的类目时会匹配到什么（下拉框里“自动”这一项的说明） */
export function autoTemplate({ product, edits = {}, settings, catalog }) {
  const rest = withKey(withKey(edits, 'cateList', undefined), 'cateName', undefined);
  return reviewTemplate({ product, edits: rest, settings, catalog });
}

function imagesOf(plan, product) {
  const main = plan.images.mainImageUrls;
  return {
    main,
    transparent: main[0] ?? '',
    detailCount: plan.images.detailImageUrls.length,
    problems: [...(main.length ? [] : ['主图']), ...(product?.detailImages?.length ? [] : ['详情图'])],
  };
}

/**
 * @typedef {{fields: ReviewField[], props: import('./vc-review-attrs.js').ReviewAttr[], skuAttrs: import('./vc-review-attrs.js').ReviewAttr[],
 *   skuAttrsOn: boolean, images: {main: string[], transparent: string, detailCount: number, problems: string[]},
 *   blockers: string[], warnings: string[], problems: string[], checks: number, ready: boolean}} Review
 *   blockers：打开发布页前会被拦下的原因（发布流程的原文）；problems：缺项/错项的名字；checks：需要核对的项数；
 *   ready：齐全，可以发布
 */

/**
 * 一个商品的发布前检查结果
 * @param {{product: object, edits?: object, settings: object, template?: object|null}} input
 * @returns {Review}
 */
export function buildReview({ product, edits = {}, settings, template = null }) {
  const propAttrs = vcTemplateAttrs(template);
  const plan = buildVcPublishPlan({ product, edits, settings, schema: { attrs: propAttrs }, template });
  const target = vcTarget({ product, edits, settings });
  const ctx = { product, edits, settings, template, prices: plan.prices };
  const fields = REVIEW_FIELDS.map((def) => fieldState(def, ctx));
  const props = reviewPropAttrs(propAttrs, plan.props.report, edits.attrOverrides);
  const skuAttrsOn = settings.publish.fillSkuAttrs !== false;
  const upc = plan.sku.upc ? { [UPC_LABEL]: plan.sku.upc } : {};
  const skuAttrs = reviewSkuAttrs(vcTemplateSkuAttrs(template), { sources: skuValueSources(product, edits, settings), units: plan.skuAttrUnits, upcValues: upc });
  const images = imagesOf(plan, product);
  const skuProblems = skuAttrsOn ? skuAttrs.filter(attrProblem) : [];
  const problems = [
    ...(vcCategory(product, edits, settings) ? [] : [NO_CATEGORY]),
    ...fields.filter((f) => f.state === 'missing' || f.state === 'error').map((f) => f.label),
    ...props.filter(attrProblem).map((a) => a.title),
    ...skuProblems.map((a) => a.title),
    ...images.problems,
  ];
  const blockers = [...(target.error ? [target.error] : []), ...plan.blockers];
  const checks = [...fields, ...props, ...skuAttrs].filter((x) => ['default', 'warn', 'guess'].includes(x.state)).length;
  return {
    fields,
    props,
    skuAttrs,
    skuAttrsOn,
    images,
    blockers,
    warnings: plan.warnings,
    problems: [...new Set(problems)],
    checks,
    ready: !blockers.length && !problems.length,
  };
}

// 编辑里的 ERP 三个键互相关联（两个相同时存成 erpCode），合并时当成一项
const ERP_STORE_KEYS = ['erpCode', 'buyerErp', 'salerErp'];
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** 一层对象的三方合并：弹窗改过的键（draft 和 base 不同）用 draft 的，其余保留 current 的 */
function mergeLevel(base, draft, current, groups = []) {
  const grouped = new Set(groups.flat());
  const all = [...Object.keys(base ?? {}), ...Object.keys(draft ?? {}), ...Object.keys(current ?? {})];
  const keys = [...new Set(all)].filter((k) => !grouped.has(k));
  const pick = (ks) => (ks.some((k) => !same(base?.[k], draft?.[k])) ? draft : current);
  const out = {};
  for (const k of keys) {
    const v = pick([k])?.[k];
    if (v !== undefined) out[k] = v;
  }
  for (const g of groups) {
    const src = pick(g);
    for (const k of g) if (src?.[k] !== undefined) out[k] = src[k];
  }
  return out;
}

/**
 * 保存弹窗的修改时，以存储里最新的编辑内容为准，只覆盖弹窗里改过的项（vc、属性覆盖逐项比较），
 * 弹窗打开期间在别处改的内容不会被弹窗打开时的旧数据冲掉。返回新对象
 * @param {object} base 弹窗打开时的编辑内容
 * @param {object} draft 弹窗里改完的编辑内容
 * @param {object} current 存储里最新的编辑内容
 */
export function rebaseEdits(base = {}, draft = {}, current = {}) {
  const top = mergeLevel(base, draft, current, [['cateList', 'cateName']]);
  const nested = (key, groups) => {
    if (same(base[key], draft[key])) return current[key];
    return nonEmpty(mergeLevel(base[key], draft[key], current[key], groups));
  };
  return withKey(withKey(top, 'vc', nested('vc', [ERP_STORE_KEYS])), 'attrOverrides', nested('attrOverrides'));
}
