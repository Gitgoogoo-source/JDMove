// 源商品参数 -> 目标类目属性 的映射（纯函数）
import { normalizeName, similarity, splitValues, toHalfWidth } from './text.js';

// 同义词组：组内任意名称互相视为同一属性
const SYNONYM_GROUPS = [
  ['产地', '原产地', '生产地', '产地国家', '国家地区', '原产国'],
  ['净含量', '净重', '重量', '商品净重', '容量', '净含量g'],
  ['保质期', '保鲜期', '保质期限'],
  ['包装', '包装形式', '包装方式', '包装类型'],
  ['规格', '包装规格', '产品规格', '商品规格'],
  ['口味', '风味'],
  ['毛重', '商品毛重'],
  ['颜色', '主体颜色', '颜色分类'],
  ['材质', '面料', '主材质', '材料'],
  ['成份', '成分', '配料', '配料表', '主要成分'],
  ['型号', '产品型号', '货号'],
  ['生产许可证号', '生产许可证编号', '食品生产许可证编号', 'sc编号'],
  ['产品执行标准', '产品标准号', '执行标准'],
  ['储存条件', '贮存条件', '储藏方法', '存储方式'],
  ['适用人群', '适用对象'],
  ['国产进口', '国产/进口', '进口/国产', '产地类型'],
].map((g) => g.map(normalizeName));

const groupOf = (key) => SYNONYM_GROUPS.find((g) => g.includes(key)) ?? null;

const UNIT_GROUPS = [
  { 天: 1, 日: 1, 个月: 30, 月: 30, 年: 365 },
  { mg: 0.001, 毫克: 0.001, g: 1, 克: 1, kg: 1000, 千克: 1000, 公斤: 1000, 斤: 500 },
  { ml: 1, 毫升: 1, l: 1000, 升: 1000 },
  { mm: 1, 毫米: 1, cm: 10, 厘米: 10, m: 1000, 米: 1000 },
];

const toNumberString = (n) => String(Math.round(n * 1000) / 1000);

/**
 * 把“12个月”“0.252kg”等转换为目标后缀单位下的数值字符串
 * @param {string} raw
 * @param {string} suffix
 */
export function convertInputValue(raw, suffix) {
  const value = toHalfWidth(raw ?? '').trim();
  const unit = String(suffix ?? '').trim().toLowerCase();
  if (!unit) return value;
  const group = UNIT_GROUPS.find((g) => unit in g);
  const m = value.match(/(\d+(?:\.\d+)?)\s*(个月|[a-zA-Z]+|[一-龥]{1,2})?/);
  if (!m) return '';
  const num = Number(m[1]);
  const srcUnit = (m[2] ?? '').toLowerCase();
  if (group && srcUnit in group) return toNumberString((num * group[srcUnit]) / group[unit]);
  return toNumberString(num);
}

/**
 * 在选项中寻找与 value 最匹配的一项
 * @param {{label: string, value: string}[]} options
 * @param {string} value
 */
export function matchOption(options, value) {
  const list = (options ?? []).filter((o) => o && o.label);
  const v = normalizeName(value);
  if (!list.length || !v) return null;
  const exact = list.find((o) => normalizeName(o.label) === v);
  if (exact) return exact;
  const contained = list
    .filter((o) => {
      const l = normalizeName(o.label);
      return l && (v.includes(l) || (v.length >= 2 && l.includes(v)));
    })
    .sort((a, b) => normalizeName(b.label).length - normalizeName(a.label).length);
  if (contained.length) return contained[0];
  for (const piece of splitValues(value)) {
    const hit = list.find((o) => normalizeName(o.label) === normalizeName(piece));
    if (hit) return hit;
  }
  let best = null;
  let bestScore = 0.5;
  for (const o of list) {
    const s = similarity(o.label, value);
    if (s >= bestScore) {
      best = o;
      bestScore = s;
    }
  }
  return best;
}

function sourcePairs(product) {
  const pairs = (product?.params ?? []).map((p) => ({ name: p.name, value: p.value }));
  if (product?.brand?.name) pairs.push({ name: '品牌', value: product.brand.name });
  return pairs;
}

/**
 * 为目标属性名寻找源参数值
 * @returns {{value: string, from: string} | null}
 */
export function findSourceValue(title, product) {
  const key = normalizeName(title);
  const group = groupOf(key);
  let best = null;
  let bestScore = 0;
  for (const p of sourcePairs(product)) {
    const name = normalizeName(p.name);
    let score = 0;
    if (name === key) score = 3;
    else if (group && group.includes(name)) score = 2;
    else if (key.length >= 2 && name.length >= 2 && (name.includes(key) || key.includes(name))) score = 1;
    if (score > bestScore) {
      best = { value: p.value, from: p.name };
      bestScore = score;
    }
  }
  return best;
}

const QUANTITY_RE = /(\d+(?:\.\d+)?)\s*(kg|千克|公斤|mg|毫克|g|克|ml|毫升|l|升)(?![a-z])/i;
const QUANTITY_KEYS = new Set(['净含量', '规格', '重量', '净重', '容量'].map(normalizeName));

// 从规格值或标题里找“480g / 1.5L”这样的量词
function deriveQuantity(product) {
  const texts = [...(product?.saleDims ?? []).flatMap((d) => d.values ?? []), product?.title ?? ''];
  for (const t of texts) {
    const m = String(t).match(QUANTITY_RE);
    if (m) return { value: `${m[1]}${m[2]}`, from: `规格/标题(${t})` };
  }
  return null;
}

function deriveValue(title, product) {
  if (QUANTITY_KEYS.has(normalizeName(title))) return deriveQuantity(product);
  if (normalizeName(title) !== '国产进口') return null;
  const origin = findSourceValue('产地', product);
  if (!origin) return null;
  const domestic = /中国|大陆|内地|[省市县]/.test(origin.value) && !/香港|澳门|台湾/.test(origin.value);
  return { value: domestic ? '国产' : '进口', from: `产地(${origin.value})` };
}

function convertForAttr(attr, raw) {
  if (attr.kind === 'select') {
    const hit = matchOption(attr.options, raw);
    return hit ? hit.value : null;
  }
  if (attr.kind === 'multi') {
    const hits = splitValues(raw)
      .map((piece) => matchOption(attr.options, piece))
      .filter(Boolean)
      .map((o) => o.value);
    const unique = [...new Set(hits)];
    return unique.length ? unique : null;
  }
  const text = convertInputValue(raw, attr.suffix);
  if (!text) return null;
  return attr.maxLength > 0 ? text.slice(0, attr.maxLength) : text;
}

/**
 * 生成商品属性填写计划
 * @param {Array<{field: string, title: string, kind: 'select'|'multi'|'input', required?: boolean, suffix?: string, maxLength?: number, options: Array<{label: string, value: string}>}>} attrs
 * @param {object} product 归一化后的商品
 * @param {{defaults?: Record<string, string>}} opts
 */
export function buildPropPlan(attrs, product, opts = {}) {
  const defaults = Object.fromEntries(
    Object.entries(opts.defaults ?? {}).map(([k, v]) => [normalizeName(k), v]),
  );
  const values = {};
  const report = [];
  for (const attr of attrs ?? []) {
    const found = findSourceValue(attr.title, product);
    const derived = found ? null : deriveValue(attr.title, product);
    const source = found ?? derived;
    let status = 'missing';
    let converted = source ? convertForAttr(attr, source.value) : null;
    if (converted != null) status = found ? 'matched' : 'derived';
    else if (source) status = 'unmatched';
    const fallback = defaults[normalizeName(attr.title)];
    if (converted == null && fallback != null && fallback !== '') {
      converted = convertForAttr(attr, fallback);
      if (converted != null) status = 'default';
    }
    if (converted != null) values[attr.field] = converted;
    report.push({ field: attr.field, title: attr.title, status, source: source?.from ?? null, raw: source?.value ?? null, value: converted });
  }
  const missingRequired = report
    .filter((r, i) => attrs[i].required && r.value == null)
    .map((r) => r.title);
  return { values, report, missingRequired };
}
