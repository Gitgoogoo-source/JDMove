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
  if (/multiInputUnit/i.test(type)) return 'numbers';
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
    ...(p.segments ? { segments: p.segments } : {}),
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

/** 模板里的 SKU属性（发布页 SKU属性抽屉的字段），结构同 vcTemplateAttrs；parts：多段数字的段数（纸张尺寸 长×宽 = 2） */
export function vcTemplateSkuAttrs(template) {
  return (template?.skuProps ?? []).map((p) => ({
    field: String(p.field),
    title: p.title ?? '',
    type: p.type,
    kind: attrKind(p),
    required: !!p.required,
    suffix: p.suffix ?? '',
    maxLength: p.maxLength ?? p.max ?? 0,
    options: p.options ?? [],
    ...(p.segments ? { segments: p.segments } : {}),
  }));
}

/**
 * 已读进内存的全部模板：templates/vc/index.json 的条目 + 每份模板（按三级类目ID）
 * @typedef {{entries: Array<{categoryId: string, leafIds: string[], file: string, path: string}>, byId: Map<string, object>}} VcTemplateCatalog
 */

/**
 * 在模板目录里按类目ID路径找模板（从末级往上找）
 * @param {VcTemplateCatalog|null|undefined} catalog
 * @param {Array<string|number>|string|number} categoryIds
 * @returns {object|null}
 */
export function findCatalogTemplate(catalog, categoryIds) {
  const entry = findVcTemplateEntry({ templates: catalog?.entries ?? [] }, categoryIds);
  return entry ? catalog.byId.get(entry.categoryId) ?? null : null;
}

/** 模板可以发布的末级类目：末级三级类目是它自己；不是末级的（抽纸、卷纸）是录制时读到的四级类目 */
export function vcTemplateLeaves(template) {
  if (!template) return [];
  if (template.isLeaf || !template.leafChildren?.length) {
    return [{ id: String(template.publishCategoryId || template.categoryId), name: template.publishCategoryName || template.categoryName }];
  }
  return template.leafChildren.map((c) => ({ id: String(c.id), name: c.name }));
}

const pathNames = (template) => (template?.path ?? []).map((p) => p.name);

/** 模板的显示名：家庭清洁/纸品 > 清洁纸品 > 抽纸 */
export const vcTemplateLabel = (template) => pathNames(template).join(' > ') || template?.categoryName || '';

/**
 * 选了某个模板（和它的末级类目）后，编辑里要存的类目ID路径和名称：发布页按这个类目打开
 * @param {object} template
 * @param {string} [leafId] 不是末级的三级类目要选四级类目，默认录制模板用的那个
 * @returns {{cateList: string[], cateName: string}}
 */
export function vcTemplateCategory(template, leafId) {
  const ids = (template?.path ?? []).map((p) => String(p.id));
  if (template?.isLeaf) return { cateList: ids, cateName: pathNames(template).join(' > ') };
  const leaves = vcTemplateLeaves(template);
  const leaf = leaves.find((l) => l.id === String(leafId)) ?? leaves.find((l) => l.id === String(template?.publishCategoryId)) ?? leaves[0];
  return { cateList: [...ids, leaf.id], cateName: [...pathNames(template), leaf.name].join(' > ') };
}
