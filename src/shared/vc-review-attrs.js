// 发布前检查里的属性（纯函数）：上架模板的商品属性、SKU属性，每一项发布时会填什么、从哪来、缺不缺。
// 商品属性用发布流程同一套匹配（buildPropPlan 的结果）；SKU属性在发布页的抽屉里按标签名取值，
// 这里照抄抽屉脚本（src/inject/backend-vc-drawer.js 的 plannedValue / pickText / 各控件取数）的规则，结果和发布时一致
import { BUILTIN_ATTR_DEFAULTS } from './vc-plan.js';
import { parseAttrDefaults } from './settings.js';
import { formatNumberParts, numberSegments } from './attr-numbers.js';

/** 属性在编辑里的存法：attrOverrides[属性名]；弹窗里的键是 attr:属性名 */
export const ATTR_KEY_PREFIX = 'attr:';
export const attrKey = (title) => `${ATTR_KEY_PREFIX}${title}`;

// 和发布页脚本的 norm（backend-core.js）相同：去掉空白和常见标点，英文小写
const norm = (s) => String(s ?? '').toLowerCase().replace(/[\s:：,，()（）[\]【】*＊/、\-_.]/g, '');
const NUMBER_RE = /\d+(?:\.\d+)?/g;
const numbersOf = (v) => String(v ?? '').match(NUMBER_RE) ?? [];

/** 抽屉按标签名找值：完全相同优先，否则互相包含（至少 2 个字）；返回命中的键 */
export function plannedKey(label, values) {
  const want = norm(label);
  const keys = Object.keys(values ?? {});
  return keys.find((k) => norm(k) === want) ?? keys.find((k) => norm(k).length >= 2 && (want.includes(norm(k)) || norm(k).includes(want))) ?? null;
}

/** 下拉选项：文字相同优先，否则互相包含 */
export function pickOption(labels, value) {
  const want = norm(value);
  if (!want) return null;
  return labels.find((l) => norm(l) === want) ?? labels.find((l) => norm(l) && (norm(l).includes(want) || want.includes(norm(l)))) ?? null;
}

const optionLabels = (attr) => (attr.options ?? []).map((o) => String(o.label ?? '')).filter(Boolean);

/** 多段数字（纸张尺寸 长×宽）需要几个数 */
const partsOf = (attr) => Math.max(1, (attr.options ?? []).filter((o) => o.label).length);
const isMultiNumber = (attr) => /MultiInputUnit/i.test(String(attr.type ?? ''));

const ok = (value, from) => ({ value, from, state: 'ok' });
// 有值但填不上：必填的、或者是自己填的算错；选填的采集值对不上选项时发布会跳过，只提醒
const badState = (attr, own) => (attr.required || own ? 'error' : 'warn');
const missing = (attr, note = '') => ({ value: '', from: '', state: attr.required ? 'missing' : 'empty', note });

/** SKU属性：抽屉里每种控件怎么取值（下拉要能对上选项、带单位的输入框只填数字、长×宽要有两个数） */
function skuValue(attr, raw, units) {
  if (isMultiNumber(attr)) {
    const nums = numbersOf(raw);
    if (nums.length >= partsOf(attr)) return { value: nums.slice(0, partsOf(attr)).join(' × ') + (attr.suffix || '') };
    if (raw == null && attr.suffix && units[attr.suffix] != null) return { value: `${units[attr.suffix]}${attr.suffix}`, fromSpec: true };
    return raw == null ? null : { bad: `“${raw}”里要有 ${partsOf(attr)} 个数字` };
  }
  if (attr.kind === 'select' || attr.kind === 'multi') {
    if (raw == null) return null;
    const hit = pickOption(optionLabels(attr), raw);
    return hit ? { value: hit } : { bad: `“${raw}”不在可选项里` };
  }
  if (attr.suffix) {
    const from = raw ?? units[attr.suffix];
    const num = numbersOf(from)[0];
    if (num) return { value: `${num}${attr.suffix}`, fromSpec: raw == null };
    return from == null ? null : { bad: `“${from}”里没有数字` };
  }
  return raw == null || raw === '' ? null : { value: String(raw) };
}

/**
 * SKU属性取值来源，优先级同 skuAttrValueMap：属性覆盖 > 采集参数 > 属性默认值
 * @param {{params?: {name: string, value: string}[]}} product
 * @param {object} edits
 * @param {object} settings
 */
export function skuValueSources(product, edits, settings) {
  return {
    overrides: edits?.attrOverrides ?? {},
    params: Object.fromEntries((product?.params ?? []).map((p) => [p.name, p.value])),
    defaults: { ...BUILTIN_ATTR_DEFAULTS, ...parseAttrDefaults(settings?.attrDefaultsText) },
  };
}

function sourceLabel(key, sources) {
  if (key in sources.overrides) return '手动填写';
  if (key in sources.params) return `采集参数“${key}”`;
  return '属性默认值';
}

/**
 * @typedef {{key: string, id: string, title: string, required: boolean, kind: string, options: string[], suffix: string,
 *   own: string, value: string, from: string, state: 'ok'|'guess'|'missing'|'empty'|'error', note: string}} ReviewAttr
 *   key：applyReviewValue 用的键（attr:属性名）；id：同一模板里唯一（标题可能重名）；value：发布时会填的值；
 *   state：ok 能填上 / guess 按推断填（请核对）/ missing 必填但没有值 / empty 选填没有值 /
 *   error 必填（或自己填的）有值但填不上 / warn 选填的采集值填不上（发布时跳过）
 */

/**
 * SKU属性：发布页 SKU属性抽屉会填什么
 * @param {object[]} attrs vcTemplateSkuAttrs(template)
 * @param {{sources: ReturnType<typeof skuValueSources>, units: Record<string, string>, upcValues?: Record<string, string>}} ctx
 *   units：规格里按单位拆出的数量（plan.skuAttrUnits）；upcValues：UPC 相关标签的值
 * @returns {ReviewAttr[]}
 */
export function reviewSkuAttrs(attrs, { sources, units = {}, upcValues = {} }) {
  const merged = { ...sources.defaults, ...sources.params, ...sources.overrides, ...upcValues };
  return attrs.map((attr) => {
    const key = plannedKey(attr.title, merged);
    const raw = key == null ? null : merged[key];
    const got = skuValue(attr, raw, units);
    const base = { key: attrKey(attr.title), id: `sku:${attr.field}`, title: attr.title, required: attr.required, kind: attr.kind, options: optionLabels(attr), suffix: attr.suffix, own: String(sources.overrides[attr.title] ?? '') };
    if (!got) return { ...base, ...missing(attr, attr.required ? '源商品没有这个参数' : '') };
    if (got.bad) return { ...base, value: '', from: key ? sourceLabel(key, sources) : '', state: badState(attr, base.own), note: `${got.bad}，发布时填不上` };
    return { ...base, ...ok(got.value, got.fromSpec ? '规格' : sourceLabel(key, sources)), note: '' };
  });
}

const STATUS_FROM = {
  matched: (r) => `采集参数“${r.source}”`,
  derived: (r) => `推断（${r.source}）`,
  default: () => '属性默认值',
  guessed: (r) => `推断（${r.source}）`,
};

function propDisplay(attr, value) {
  if (attr.kind === 'numbers') return formatNumberParts(value);
  const labels = new Map((attr.options ?? []).map((o) => [String(o.value), o.label]));
  const list = Array.isArray(value) ? value : [value];
  return list.map((v) => labels.get(String(v)) ?? String(v)).join('、');
}

/**
 * 商品属性：发布页“商品属性”会填什么（buildPropPlan 的结果，和打开页面前的检查是同一份）
 * @param {object[]} attrs vcTemplateAttrs(template)
 * @param {object[]} report buildPropPlan(attrs, ...).report，和 attrs 一一对应
 * @param {Record<string, string>} overrides 编辑里的属性覆盖
 * @returns {ReviewAttr[]}
 */
export function reviewPropAttrs(attrs, report, overrides = {}) {
  return attrs.map((attr, i) => {
    const r = report[i] ?? {};
    const own = String(overrides[attr.title] ?? '');
    const base = { key: attrKey(attr.title), id: `prop:${attr.field}`, title: attr.title, required: attr.required, kind: attr.kind, options: optionLabels(attr), suffix: attr.suffix, own };
    if (r.value != null) {
      const from = own ? '手动填写' : STATUS_FROM[r.status]?.(r) ?? '';
      return { ...base, value: propDisplay(attr, r.value), from, state: r.status === 'guessed' && !own ? 'guess' : 'ok', note: '' };
    }
    if (attr.kind === 'numbers' && r.status === 'unmatched') {
      const need = numberSegments(attr).map((x) => x.name).filter(Boolean).join('×');
      return { ...base, value: '', from: own ? '手动填写' : r.source ? `采集参数“${r.source}”` : '', state: badState(attr, own), note: `“${r.raw}”里要有 ${need || '对应'} 的数字，如 195×133` };
    }
    if (r.status === 'unmatched') return { ...base, value: '', from: r.source ? `采集参数“${r.source}”` : '', state: badState(attr, own), note: `“${r.raw}”不在可选项里，请选择` };
    return { ...base, ...missing(attr, attr.required ? '源商品没有这个参数' : '') };
  });
}

/** 属性要不要算进“缺项”：必填填不上，或者自己填的对不上选项 */
export const attrProblem = (a) => a.state === 'missing' || a.state === 'error';
