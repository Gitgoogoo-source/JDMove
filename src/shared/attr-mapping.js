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
  // 值里包含选项（“产地：比利时”）取最长的选项；选项包含值（“新日期” -> “新日期：…”）优先以值开头的选项
  const rank = (l) => (v.includes(l) ? 0 : l.startsWith(v) ? 1 : 2);
  const contained = list
    .filter((o) => {
      const l = normalizeName(o.label);
      return l && (v.includes(l) || (v.length >= 2 && l.includes(v)));
    })
    .sort((a, b) => {
      const la = normalizeName(a.label);
      const lb = normalizeName(b.label);
      return rank(la) - rank(lb) || (rank(la) === 0 ? lb.length - la.length : la.length - lb.length);
    });
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

// 包装/销售单位：源值或标题里的容器词（桶装、6袋装、礼盒…）按相近程度依次尝试目标选项
const CONTAINER_PREFS = {
  礼盒: ['礼盒', '盒'],
  桶: ['桶', '罐', '瓶'],
  罐: ['罐', '桶', '瓶'],
  听: ['听', '罐', '瓶'],
  碗: ['碗', '罐', '盒'],
  瓶: ['瓶', '罐'],
  盒: ['盒', '礼盒'],
  袋: ['袋', '包'],
  包: ['包', '袋'],
  箱: ['箱', '件'],
  条: ['条'],
  块: ['块'],
  板: ['板'],
  支: ['支'],
  组: ['组'],
};
// 长词在前，“礼盒装”认作礼盒而不是盒
const CONTAINER_WORDS = Object.keys(CONTAINER_PREFS).sort((a, b) => b.length - a.length).join('|');
const PACKED_RE = new RegExp(`(${CONTAINER_WORDS})装`);
const COUNTED_RE = new RegExp(`\\d+\\s*(${CONTAINER_WORDS})`);
const ANY_CONTAINER_RE = new RegExp(`(${CONTAINER_WORDS})`);
// “礼盒”本身就是包装形式，标题里不带“装”字也算（“童趣礼盒330g”）
const GIFT_BOX_RE = /(礼盒)/;
const CONTAINER_ATTRS = new Set(['包装', '包装形式', '包装方式', '包装类型', '销售单位'].map(normalizeName));
const OTHER_LABELS = new Set(['其它', '其他']);
const IMPORT_HINT_RE = /进口|原装/;

/** 找出文本里的容器词；标题只认“X装 / 礼盒 / 数字+X”，包装字段本身可以宽松匹配 */
function containerIn(text, loose = false) {
  const s = String(text ?? '');
  const m =
    s.match(PACKED_RE) || s.match(GIFT_BOX_RE) || s.match(COUNTED_RE) || (loose ? s.match(ANY_CONTAINER_RE) : null);
  return m ? m[1] : null;
}

function containerOption(options, container) {
  for (const c of CONTAINER_PREFS[container] ?? []) {
    const hit = options.find((o) => [c, `${c}装`].includes(normalizeName(o.label)));
    if (hit) return hit;
  }
  return null;
}

const otherOption = (options) => options.find((o) => OTHER_LABELS.has(normalizeName(o.label))) ?? null;

// 包装、销售单位共用：先看源参数里的包装形式，再看标题、规格值
function guessContainer(product) {
  const pkg = findSourceValue('包装', product);
  const texts = [
    pkg && { text: pkg.value, loose: true, from: `${pkg.from}(${pkg.value})` },
    { text: product?.title, loose: false, from: '标题' },
    ...(product?.saleDims ?? []).flatMap((d) => d.values ?? []).map((v) => ({ text: v, loose: false, from: `规格(${v})` })),
  ].filter(Boolean);
  for (const { text, loose, from } of texts) {
    const c = containerIn(text, loose);
    if (c) return { value: c, from };
  }
  return null;
}

/** 源页面没有产地时：标题/参数里出现选项中的国家就用它；有“进口”字样但看不出国家则不填；否则按国产处理 */
function guessOrigin(attr, product) {
  if (!product?.title) return null;
  const text = [product.title, product.brand?.name, ...(product.params ?? []).map((p) => p.value)].join(' ');
  const country = (attr.options ?? []).find((o) => o.label.length >= 2 && !OTHER_LABELS.has(o.label) && text.includes(o.label));
  if (country) return { value: country.label, from: `标题/参数(${country.label})` };
  if (IMPORT_HINT_RE.test(text)) return null;
  return { value: '中国大陆', from: '源页面无产地，按国产处理' };
}

// 兜底推断：只在源数据和用户默认值都没有时使用
function guessValue(attr, product) {
  const key = normalizeName(attr.title);
  if (CONTAINER_ATTRS.has(key)) return guessContainer(product);
  if (groupOf(key)?.includes(normalizeName('产地'))) return guessOrigin(attr, product);
  return null;
}

function convertSelect(attr, raw, lenient) {
  const options = attr.options ?? [];
  const hit =
    matchOption(options, raw) ??
    (CONTAINER_ATTRS.has(normalizeName(attr.title)) ? containerOption(options, containerIn(raw, true)) : null) ??
    (lenient ? otherOption(options) : null);
  return hit ? hit.value : null;
}

/**
 * @param {{lenient?: boolean}} [opts] lenient：源数据里确有该属性但选项对不上时，退到“其它”
 */
function convertForAttr(attr, raw, { lenient = false } = {}) {
  if (attr.kind === 'select') return convertSelect(attr, raw, lenient);
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

function optionLabel(attr, value) {
  if (attr.kind !== 'select') return null;
  return (attr.options ?? []).find((o) => o.value === value)?.label ?? null;
}

// 取值顺序：源参数 > 可靠推断（净含量、国产/进口）> 用户默认值 > 兜底推断（包装、销售单位、产地）
function planAttr(attr, product, fallback) {
  const found = findSourceValue(attr.title, product);
  const derived = found ? null : deriveValue(attr.title, product);
  const guessed = found ? null : guessValue(attr, product);
  const steps = [
    found && { ...found, status: 'matched', lenient: true },
    derived && { ...derived, status: 'derived' },
    fallback != null && fallback !== '' && { value: fallback, from: '属性默认值', status: 'default' },
    guessed && { ...guessed, status: 'guessed' },
  ].filter(Boolean);
  for (const step of steps) {
    const value = convertForAttr(attr, step.value, step);
    if (value != null) return { status: step.status, source: step.from, raw: step.value, value, label: optionLabel(attr, value) };
  }
  const source = found ?? derived;
  return { status: source ? 'unmatched' : 'missing', source: source?.from ?? null, raw: source?.value ?? null, value: null };
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
    const entry = planAttr(attr, product, defaults[normalizeName(attr.title)]);
    if (entry.value != null) values[attr.field] = entry.value;
    report.push({ field: attr.field, title: attr.title, ...entry });
  }
  const missingRequired = report
    .filter((r, i) => attrs[i].required && r.value == null)
    .map((r) => r.title);
  return { values, report, missingRequired };
}
