// VC 发布页“基本信息 / 物流售后”字段的写入值（纯函数）。
// 2026-11-08 在 vcProductPublish 上实测：页面输入框产生的值全是字符串（"4.33"、"408"），
// 插件用 fApi.setValue 写数字时，保存接口被网关拒收（毛重写数字 4.33 → “无效的字符串，请核对后再试 [456]”，
// 同一个值写字符串 "4.33" 保存成功）。所以每个字段都按页面自己的格式转成字符串再写，格式不对的在打开页面前就拦下。
// 规则抄自页面校验：价格两位小数、采购价四位小数、长宽高 1~4000/3040/3000 的正整数、毛重 0.01~60000 且最多 3 位小数

/**
 * @typedef {{field: string, label: string, value: string, critical: boolean}} VcFormEntry
 * field：fApi 字段名；value：要写的字符串；critical：没写进去就不能保存
 */

const MAX_DECIMALS = 6;

/** 数字 → 最多 decimals 位小数的字符串（四舍五入，不补零、不用科学计数法）；不是有限数时为 '' */
export function decimalText(raw, decimals) {
  const n = Number(raw);
  if (raw == null || raw === '' || !Number.isFinite(n)) return '';
  const d = Math.min(decimals, MAX_DECIMALS);
  // 按十进制四舍五入：toFixed 按二进制，1.005、50.12345 会被舍掉
  const rounded = Number(`${Math.round(Number(`${n}e${d}`))}e-${d}`);
  const fixed = (Number.isFinite(rounded) ? rounded : n).toFixed(d);
  return d > 0 ? fixed.replace(/\.?0+$/, '') : fixed;
}

/** 正数字段：小数位数、范围 */
const NUMBER_RULES = [
  { key: 'marketPrice', from: 'prices', label: '市场价', decimals: 2, min: 0.01, max: 9999999, critical: true },
  { key: 'jdPrice', from: 'prices', label: '京东价', decimals: 2, min: 0.01, max: 9999999, critical: true },
  { key: 'costPrice', from: 'prices', label: '采购价', decimals: 4, min: 0.0001, max: 9999999, critical: true },
  { key: 'length', from: 'logistics', label: '长', unit: 'mm', decimals: 0, min: 1, max: 4000, critical: true },
  { key: 'wide', from: 'logistics', label: '宽', unit: 'mm', decimals: 0, min: 1, max: 3040, critical: true },
  { key: 'height', from: 'logistics', label: '高', unit: 'mm', decimals: 0, min: 1, max: 3000, critical: true },
  { key: 'weight', from: 'logistics', label: '毛重', unit: 'kg', decimals: 3, min: 0.01, max: 60000, critical: true },
  { key: 'sldays', field: 'features.sldays', from: 'logistics', label: '保质期', unit: '天', decimals: 0, min: 1, max: 99999, critical: false },
  { key: 'packSpecification', from: 'logistics', label: '包装规格', decimals: 0, min: 1, max: 100000, critical: false },
];

/** 文本 / 下拉字段（下拉在页面里按选项文字换成选项值） */
const TEXT_RULES = [
  { key: 'model', field: 'features.model', from: 'root', label: '型号', critical: true },
  { key: 'unit', field: 'features.unit', from: 'logistics', label: '销售单位', critical: false },
  { key: 'packType', field: 'features.packType', from: 'logistics', label: '商品包装', critical: false },
  { key: 'warranty', from: 'logistics', label: '质保期', critical: false },
  { key: 'packListing', from: 'logistics', label: '包装清单', critical: false },
];

/** 必填、缺了不能保存的数字字段（其余缺了就不写，沿用页面默认） */
const REQUIRED_NUMBERS = new Set(['marketPrice', 'jdPrice', 'costPrice', 'length', 'wide', 'height', 'weight']);

const sourceOf = (plan, from) => (from === 'root' ? plan : plan?.[from]) ?? {};
const rangeText = (r) => `${decimalText(r.min, r.decimals)}~${r.max}${r.unit ?? ''}`;

function numberEntry(plan, rule) {
  const raw = sourceOf(plan, rule.from)[rule.key];
  const field = rule.field ?? rule.key;
  if (raw == null || raw === '') {
    return REQUIRED_NUMBERS.has(rule.key) ? { error: `缺少${rule.label}` } : {};
  }
  const value = decimalText(raw, rule.decimals);
  const n = Number(value);
  if (!value || !(n >= rule.min && n <= rule.max)) {
    const why = `${rule.label}“${raw}”超出页面允许的范围（${rangeText(rule)}${rule.decimals ? `，最多 ${rule.decimals} 位小数` : '，整数'}）`;
    // 选填字段不拦发布：不写，沿用页面默认
    return rule.critical ? { error: why } : { warning: `${why}，已跳过` };
  }
  return { entry: { field, label: rule.label, value, critical: rule.critical } };
}

function textEntry(plan, rule) {
  const value = String(sourceOf(plan, rule.from)[rule.key] ?? '').trim();
  if (!value) return {};
  return { entry: { field: rule.field ?? rule.key, label: rule.label, value, critical: rule.critical } };
}

/**
 * 计划里的型号、价格、物流售后 → 按页面格式写入的字符串
 * @param {{model?: string, prices?: object, logistics?: object}} plan
 * @returns {{entries: VcFormEntry[], errors: string[], warnings: string[]}}
 *   errors：必填字段格式/范围不对（写进去页面也会拦）；warnings：选填字段不对、已跳过
 */
export function vcFormEntries(plan) {
  const results = [
    ...TEXT_RULES.slice(0, 1).map((r) => textEntry(plan, r)),
    ...NUMBER_RULES.map((r) => numberEntry(plan, r)),
    ...TEXT_RULES.slice(1).map((r) => textEntry(plan, r)),
  ];
  return {
    entries: results.map((r) => r.entry).filter(Boolean),
    errors: results.map((r) => r.error).filter(Boolean),
    warnings: results.map((r) => r.warning).filter(Boolean),
  };
}

/** 毛重（kg）按页面规则保留最多 3 位小数，不足 0.01 的按 0.01；无效值为 null */
export function vcWeightKg(kg) {
  const n = Number(kg);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.max(0.01, Number(decimalText(n, 3)));
}
