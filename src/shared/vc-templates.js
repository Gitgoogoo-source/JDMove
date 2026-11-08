// VC 上架模板（templates/vc/）：每个三级类目一份发布页结构（基本信息字段及取值范围、商品属性、规格、SKU属性），
// 由 src/inject/backend-vc-template.js 在发布页上读出。三级类目不是末级时（抽纸、卷纸），模板按其中一个四级类目录制，
// 同一个三级类目下的四级类目共用，所以按类目ID查找时三级、四级ID都能找到。
export const VC_TEMPLATE_DIR = 'templates/vc';

/**
 * 在模板索引里找类目对应的模板条目
 * @param {{templates: Array<{categoryId: string, leafIds: string[], file: string}>}} index templates/vc/index.json
 * @param {Array<string|number>|string|number} categoryIds 类目ID，或类目ID路径（从末级往上找，先命中的为准）
 * @returns {object|null}
 */
export function findVcTemplateEntry(index, categoryIds) {
  const ids = (Array.isArray(categoryIds) ? categoryIds : [categoryIds]).map(String).filter(Boolean).reverse();
  const list = index?.templates ?? [];
  for (const id of ids) {
    const hit = list.find((t) => t.categoryId === id || t.leafIds.includes(id));
    if (hit) return hit;
  }
  return null;
}

/**
 * 模板里某个基本信息字段的取值范围（如包装长宽高、毛重的上限按类目不同）
 * @returns {{min?: number, max?: number, required?: boolean}|null}
 */
export function vcTemplateFieldLimits(template, field) {
  const f = template?.baseFields?.find((x) => x.field === field);
  if (!f) return null;
  return { min: f.min, max: f.max, required: !!f.required };
}

// 发布页字段名 → vcFormEntries 的规则 key（带上下限、按类目不同的数字字段）
const LIMIT_FIELDS = { length: 'length', wide: 'wide', height: 'height', weight: 'weight' };

/**
 * 模板里按类目的长宽高、毛重上下限，交给 vcFormEntries 覆盖默认规则
 * @returns {Record<string, {min?: number, max?: number}>}
 */
export function vcTemplateLimits(template) {
  const out = {};
  for (const [field, key] of Object.entries(LIMIT_FIELDS)) {
    const f = template?.baseFields?.find((x) => x.field === field);
    if (f && (f.min != null || f.max != null)) out[key] = { ...(f.min != null ? { min: f.min } : {}), ...(f.max != null ? { max: f.max } : {}) };
  }
  return out;
}

// 和发布页上读表单结构时（backend-core.js getFormSchema / attrKind）同一套判断，打开页面前后的属性匹配结果一致
function attrKind(attr) {
  const type = String(attr.type || '');
  if (/checkbox|multi/i.test(type)) return 'multi';
  if (/select|radio/i.test(type) || (attr.options ?? []).length) return 'select';
  return 'input';
}

/** 模板里的商品属性 → buildPropPlan 要的属性结构（同 getFormSchema 返回的 attrs） */
export function vcTemplateAttrs(template) {
  return (template?.productProps ?? []).map((p) => ({
    field: String(p.field),
    title: p.title ?? '',
    type: p.type,
    kind: attrKind(p),
    required: !!p.required,
    suffix: p.suffix ?? '',
    maxLength: p.maxLength ?? p.max ?? 0,
    options: p.options ?? [],
  }));
}

/** 模板里的必填项标题：商品属性、SKU属性、规格（规格的组合字段展开成各部分） */
export function vcTemplateRequired(template) {
  const titles = (list) => (list ?? []).filter((x) => x.required).map((x) => x.title);
  const spec = (template?.saleSpec ?? []).flatMap((d) =>
    (d.fields ?? []).filter((f) => f.required).flatMap((f) => (f.parts?.length ? titles(f.parts).filter((t) => t !== '*') : [f.title])),
  );
  return {
    productProps: titles(template?.productProps),
    skuProps: [...new Set(titles(template?.skuProps))],
    spec: [...new Set(spec)],
  };
}
