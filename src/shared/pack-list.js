// 京东的商品参数、包装清单和当前 SKU 的销售规格是三种独立来源。
import { toHalfWidth } from './text.js';
import { UNIT_GROUPS } from './attr-numbers.js';

const MEASURE = /(\d+(?:\.\d+)?)\s*(毫升|升|ml|l|毫克|千克|公斤|斤|克|mg|kg|g)(?=$|[^a-z]|x\s*\d)/gi;
const PACK_UNITS = '瓶桶罐袋盒包箱把件';
const PACK_COUNT = new RegExp(`^([1-9]\\d*)\\s*([${PACK_UNITS}])?装?$`);
const LIST_COUNT = new RegExp(`(?:[*×]|(?<![a-z])x)\\s*([1-9]\\d*)\\s*([${PACK_UNITS}])?装?$`, 'i');
const COPIES = new RegExp(`^\\s*(?:/\\s*([${PACK_UNITS}]))?\\s*[*×x]\\s*([1-9]\\d*)\\s*([${PACK_UNITS}])?(?:\\s*[*×x]\\s*1(?![\\d.]))?`, 'i');
const UNSAFE = /毛重|含包装重|[+赠送;、,\n]|\d\s*[-~～至到]\s*\d/;
const MORE_COUNTS = new RegExp(`[*×]|x\\s*\\d|\\d\\s*[${PACK_UNITS}]`, 'i');

function measure(match) {
  const unit = match[2].toLowerCase();
  const group = UNIT_GROUPS.find((g) => unit in g);
  return { n: Number((Number(match[1]) * group[unit]).toFixed(6)), unit: 'ml' in group ? 'mL' : 'g' };
}

/** undefined 表示没有计量信息，null 表示存在歧义。含量和件数可以各自独立出现。 */
function readSize(value, corroboratingList) {
  const text = toHalfWidth(value).trim();
  const matches = [...text.matchAll(MEASURE)];
  const last = matches.at(-1);
  // 系列名称本身有时带加号。只有清单独立给出了含量时，才允许所选规格在首个含量之前这样命名。
  const checked = corroboratingList?.n && last
    ? text.slice(0, matches[0].index).replaceAll('+', '') + text.slice(matches[0].index)
    : text;
  if (UNSAFE.test(checked)) return null;
  if (!last) {
    const bare = text.match(PACK_COUNT);
    const count = bare?.[2] ? bare : text.match(LIST_COUNT);
    if (count && MORE_COUNTS.test(text.slice(0, count.index))) return null;
    return count ? { count: Number(count[1]), container: count[2] || '' } : undefined;
  }
  const size = measure(last);
  if (!size.n || !Number.isFinite(size.n) || matches.some((m) => !sameSize(measure(m), size))) return null;

  // 名称里可以重复标注含量。件数紧跟最后一个含量，后面可以有用途等描述。
  const prefix = text.slice(0, last.index);
  let suffix = text.slice(last.index + last[0].length).replace(/^\s*\([^\d()*×+]*\)/, '');
  const copies = suffix.match(COPIES);
  if (copies) suffix = suffix.slice(copies[0].length);
  if (MORE_COUNTS.test(prefix) || MORE_COUNTS.test(suffix) || /^\s*[.\d/]/.test(suffix)) return null;
  return { ...size, count: copies ? Number(copies[2]) : null, container: copies?.[3] || copies?.[1] || '' };
}

const sameSize = (a, b) => a.n === b.n && a.unit === b.unit;

function currentAttributes(product) {
  const variant = Array.isArray(product.variants) && product.variants.find((v) => v?.skuId && String(v.skuId) === String(product.skuId));
  const attrs = Object.entries(variant?.values ?? {}).map(([name, value]) => ({ name, value }));
  return [...attrs, ...(Array.isArray(product.vc?.saleAttrs) ? product.vc.saleAttrs : [])];
}

/** 页面的明确属性优先。只用属于本 SKU 的清单和规格补缺项，永远不从同款的其他选项取值。 */
export function withPackListParams(product) {
  if (!product || (product.params != null && !Array.isArray(product.params))) return product;
  const params = product.params ?? [];
  const param = (name) => params.find((p) => p?.name === name)?.value;
  if (param('总净含量') && param('包装规格')) return product;

  const current = currentAttributes(product);
  const extra = [];
  for (const name of ['总净含量', '包装规格']) {
    const values = new Set(current.filter((p) => p?.name === name && p.value).map((p) => p.value));
    if (!param(name) && values.size === 1) extra.push({ name, value: [...values][0] });
  }
  const net = param('总净含量') || extra.find((p) => p.name === '总净含量')?.value;
  const pack = param('包装规格') || extra.find((p) => p.name === '包装规格')?.value;
  const result = () => extra.length ? { ...product, params: [...params, ...extra] } : product;
  if (net && pack) return result();

  const list = readSize(product.packList || param('包装清单'));
  const specTexts = [...params, ...current].filter((p) => /^(规格|产品规格|商品规格)$/.test(p?.name)).map((p) => p.value);
  const specs = [...new Set(specTexts)].map((value) => readSize(value, list));
  const perItem = readSize(param('单件净含量') || param('单包净含量') || param('单瓶净含量'));
  const candidates = [list, ...specs, perItem];
  if (candidates.includes(null)) return result();
  const evidence = candidates.filter(Boolean);
  const sizes = evidence.filter((s) => s.n != null);
  const size = sizes.find((s) => s.count != null) ?? (perItem?.n ? perItem : sizes[0]);
  const counts = new Set(evidence.map((s) => s.count).filter((n) => n != null));
  const stated = pack && toHalfWidth(pack).trim().match(PACK_COUNT);
  if (pack && !stated) return result();
  const copies = [...counts][0];
  if (counts.size > 1 || (copies != null && stated && copies !== Number(stated[1]))) return result();

  // 仅出现容量且无乘数时，清单与所选规格要相互印证，或包装规格明确写着单件。
  // 有多件但未注明是每件还是合计时，不能乘，也不能当总量。
  const count = copies ?? (stated ? Number(stated[1]) : null);
  const measuredPerItem = perItem?.n || sizes.some((s) => s.count != null);
  const total = size && { n: Number((size.n * (count ?? 1)).toFixed(6)), unit: size.unit };
  if (sizes.some((s) => !sameSize(s, size) && (s === perItem || s.count != null || !sameSize(s, total)))) return result();
  const corroborated = count == null && list?.n && specs.some((s) => s?.n);
  if (!net && size && (count === 1 || (count && measuredPerItem) || corroborated)) {
    extra.push({ name: '总净含量', value: total.n + total.unit });
  }
  if (!pack && copies) {
    const containers = new Set(evidence.map((s) => s.container).filter(Boolean));
    const form = String(param('包装形式') ?? '').match(/^([瓶桶罐袋盒包箱])装$/);
    if (form) containers.add(form[1]);
    if (containers.size <= 1) extra.push({ name: '包装规格', value: copies + ([...containers][0] || '件') });
  }
  return result();
}
