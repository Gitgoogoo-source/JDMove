// 两种同名 SKU 控件可同时出现：精确数量（带单位），以及按总净含量划分的区间。
import { plannedKey } from './sku-attrs.js';
import { rangeOption } from './attr-mapping.js';
import { UNIT_GROUPS } from './attr-numbers.js';
import { toHalfWidth } from './text.js';

// 同一模板的数值和区间共用一列时，表里保留能反推出区间的精确含量。
export const isExactTotal = (attr) => attr.title === '总净含量' && attr.kind === 'numbers';

/** undefined 沿用普通控件规则，空串表示有此控件但该值不能填写。 */
export function skuQuantityValue(attr, raw) {
  if (raw == null || !['总净含量', '单件净含量', '包装规格', '保质期'].includes(attr.title)) return undefined;
  const text = toHalfWidth(raw).trim();
  const m = /^(\d+(?:\.\d+)?)\s*([a-z\u4e00-\u9fff]*)$/i.exec(text);
  if (attr.kind === 'select' && attr.title === '总净含量') {
    const exact = attr.options.find((o) => o.label === text);
    if (exact) return exact.label;
    if (!m?.[2]) return '';
    const range = rangeOption(attr.options, text);
    return range === undefined ? undefined : range?.label ?? '';
  }
  const units = attr.segments?.[0]?.units;
  if (attr.kind !== 'numbers' || attr.segments?.length !== 1 || !units?.length) return undefined;
  if (!m || Number(m[1]) <= 0) return '';
  // 手动填写纯数字时沿用模板的首选单位；带单位的值必须相符或可换算。
  const from = m[2].toLowerCase();
  const exact = units.find((u) => u.toLowerCase() === from);
  if (!from || exact) return m[1] + (exact || units[0]);
  const group = UNIT_GROUPS.find((g) => from in g);
  const to = group && units.find((u) => u.toLowerCase() in group);
  return to ? Number(((Number(m[1]) * group[from]) / group[to.toLowerCase()]).toFixed(6)) + to : '';
}

/** 按控件类型分开，同一标题的区间下拉不会覆盖精确数值。 */
export function skuQuantityFields(attrs, values) {
  const fields = { select: {}, numbers: {} };
  for (const attr of attrs) {
    const key = plannedKey(attr.title, values);
    const value = key == null ? undefined : skuQuantityValue(attr, values[key]);
    if (value !== undefined) fields[attr.kind][attr.title] = value;
  }
  return fields;
}
