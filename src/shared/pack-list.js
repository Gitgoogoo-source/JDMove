// 京东的商品参数、包装清单和当前 SKU 的销售规格是三种独立来源。
import { toHalfWidth } from './text.js';
import { UNIT_GROUPS } from './attr-numbers.js';

const MEASURE = /(\d+(?:\.\d+)?)\s*(毫升|升|ml|l|毫克|千克|公斤|斤|克|mg|kg|g)(?=$|[^a-z]|x\s*\d)/gi;
const PACK_UNITS = '瓶桶罐袋盒包箱把支块板套挂个件';
const PACK_COUNT = new RegExp(`^([1-9]\\d*)\\s*([${PACK_UNITS}])?装?$`);
const LIST_COUNT = new RegExp(`(?:[*×]|(?<![a-z])x)\\s*([1-9]\\d*)\\s*([${PACK_UNITS}])?装?$`, 'i');
const COPIES = new RegExp(`^\\s*(?:/\\s*([${PACK_UNITS}]))?\\s*[*×x]\\s*([1-9]\\d*)\\s*([${PACK_UNITS}])?(?:\\s*[*×x]\\s*1(?![\\d.]))?`, 'i');
const ADJACENT_COUNT = new RegExp(`^\\s*([1-9]\\d*)\\s*([${PACK_UNITS}])`);
const PACK_FORM = new RegExp(`^([${PACK_UNITS}])装?$`);
const COUNTED_CONTAINER = new RegExp(`(?<![\\d.])([1-9]\\d*)\\s*([${PACK_UNITS}])`, 'g');
const UNSAFE = /毛重|含包装重|[+赠送;、,\n]|\d\s*[-~～至到]\s*\d/;
const MORE_COUNTS = new RegExp(`[*×]|x\\s*\\d|\\d\\s*[${PACK_UNITS}]`, 'i');
const concreteUnit = (unit) => unit && unit !== '件';
const SOAP_NAME = /洗衣皂|肥皂|马赛皂|植物皂/;
const BLOCKS = /(?<![\d.])([1-9]\d*)\s*块(?:装)?$/;
const MULTI_PACK = /组合|套装|混合装|多件装|[双两三四五六七八九十][瓶桶罐袋盒包箱]/;
const PACK_FORM_NAMES = ['包装形式', '包装类型', '包装方式', '包装'];

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
  let checked = corroboratingList?.n && last
    ? text.slice(0, matches[0].index).replaceAll('+', '') + text.slice(matches[0].index)
    : text;
  if (corroboratingList?.count && text.includes('+')) {
    // 清单已列明数量。“【280g×2】石榴+椰香”里加号后的名称不是另一项计量。
    if (matches.length === 1 && /[】\]]/.test(text.slice(last.index + last[0].length))) checked = checked.replaceAll('+', '');
    if (corroboratingList.multiLine && !last && !UNSAFE.test(text.replaceAll('+', '')) && ![...text.matchAll(COUNTED_CONTAINER)].length) return undefined;
  }
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
  const adjacent = copies ? null : suffix.match(ADJACENT_COUNT);
  if (copies || adjacent) suffix = suffix.slice((copies || adjacent)[0].length);
  if (MORE_COUNTS.test(prefix) || MORE_COUNTS.test(suffix) || /^\s*[.\d/]/.test(suffix)) return null;
  const count = copies?.[2] ?? adjacent?.[1];
  return { ...size, count: count == null ? null : Number(count), container: copies?.[3] || copies?.[1] || adjacent?.[2] || '' };
}

const sameSize = (a, b) => a.n === b.n && a.unit === b.unit;

// 同规格组合可以逐行列出，也可以用加号连接。加号分隔的每项没有乘数时各为一件。
function readPackList(value) {
  const text = toHalfWidth(value);
  const joined = text.includes('+');
  const lines = text.trim().split(joined ? /\s*\+\s*/ : /[\r\n]+/).map((line) => line.trim());
  if (joined && lines.some((line) => !/[\u4e00-\u9fff]/.test(line))) return null;
  if (lines.length <= 1) return readSize(lines[0]);
  const sizes = lines.map((line) => readSize(line));
  const first = sizes[0];
  const units = new Set(sizes.map((size) => size?.container).filter(concreteUnit));
  if (units.size > 1 || sizes.some((size) => !size?.n || (!joined && !size.count) || !sameSize(size, first))) return null;
  return { ...first, count: sizes.reduce((total, size) => total + (size.count ?? 1), 0), container: [...units][0] || '', multiLine: true };
}

function currentAttributes(product) {
  const variant = Array.isArray(product.variants) && product.variants.find((v) => v?.skuId && String(v.skuId) === String(product.skuId));
  const attrs = Object.entries(variant?.values ?? {}).map(([name, value]) => ({ name, value }));
  return [...attrs, ...(Array.isArray(product.vc?.saleAttrs) ? product.vc.saleAttrs : [])];
}

// 普通洗衣皂的“销售规格”要求肥皂块数。混装中的洗衣液、衣领净等不计入块数。
function soapBlocks(text) {
  const parts = toHalfWidth(text).split(/[+\r\n]/).filter((part) => SOAP_NAME.test(part));
  if (parts.length !== 1) return null;
  const part = parts[0].trim();
  const piece = readSize(part);
  if (piece === undefined && !UNSAFE.test(part)) return Number(part.match(BLOCKS)?.[1]) || null;
  return piece?.count && (!piece.unit || piece.unit === 'g') && (!concreteUnit(piece.container) || piece.container === '块')
    ? piece.count : null;
}

/** 页面的明确属性优先。只用属于本 SKU 的清单和规格补缺项，永远不从同款的其他选项取值。 */
export function withPackListParams(product) {
  if (!product || (product.params != null && !Array.isArray(product.params))) return product;
  const params = product.params ?? [];
  const param = (name) => params.find((p) => p?.name === name)?.value;
  const leafId = product.vc?.cateIds?.at(-1);
  const needsPerItem = ['磨砂膏', '洗洁精'].includes(product.leafCategory) || ['34485', '15930'].includes(leafId);
  const soap = product.leafCategory === '普通洗衣皂' || leafId === '15926';

  const current = currentAttributes(product);
  const extra = [];
  for (const name of ['总净含量', '包装规格', '单件净含量']) {
    const values = new Set(current.filter((p) => p?.name === name && p.value).map((p) => p.value));
    if (!param(name) && values.size === 1) extra.push({ name, value: [...values][0] });
  }
  const attribute = (name) => param(name) || extra.find((p) => p.name === name)?.value;
  const net = attribute('总净含量');
  const pack = attribute('包装规格');
  const single = attribute('单件净含量');
  const stated = pack && toHalfWidth(pack).trim().match(PACK_COUNT);
  const packList = product.packList || param('包装清单');
  const specTexts = [...params, ...current].filter((p) => /规格$/.test(p?.name) && p.name !== '包装规格'
    && !(soap && p.name === '销售规格' && /^[1-9]\d*块$/.test(p.value))).map((p) => p.value);
  if (soap && !param('销售规格')) {
    const counts = new Set([packList, ...specTexts, product.title].map(soapBlocks).filter(Boolean));
    if (counts.size === 1) extra.push({ name: '销售规格', value: `${[...counts][0]}块` });
  }
  const result = () => extra.length
    ? { ...product, params: [...params.filter((p) => !extra.some(({ name }) => p?.name === name)), ...extra] }
    : product;
  if (net && pack && (!stated || concreteUnit(stated[2])) && (!needsPerItem || single)) return result();

  const fromTitle = soap && !packList ? readSize(product.title) : null;
  const list = fromTitle?.n && fromTitle.count && specTexts.some((value) => soapBlocks(value) === fromTitle.count)
    ? fromTitle : readPackList(packList);
  const specs = [...new Set(specTexts)].map((value) => {
    const size = readSize(value, list);
    return size === null && list?.multiLine && toHalfWidth(value).includes('+') ? readPackList(value) : size;
  });
  const perItem = readSize(single || param('单包净含量') || param('单瓶净含量') || param('单罐净含量') || param('单支净含量'));
  const candidates = [list, ...specs, perItem];
  if (candidates.includes(null)) return result();
  const evidence = candidates.filter(Boolean);
  const sizes = evidence.filter((s) => s.n != null);
  const size = sizes.find((s) => s.count != null) ?? (perItem?.n ? perItem : sizes[0]);
  const counts = new Set(evidence.map((s) => s.count).filter((n) => n != null));
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
  if (needsPerItem && !single && size && (count === 1 || measuredPerItem)) {
    extra.push({ name: '单件净含量', value: size.n + size.unit });
  }
  const forms = PACK_FORM_NAMES.map((name) => toHalfWidth(param(name)).trim().match(PACK_FORM)?.[1]).filter(concreteUnit);
  // 清单与所选规格都标一份相同含量，且参数明确了包装形式。
  const singlePack = corroborated && forms.length && ![packList, ...specTexts].some((value) => MULTI_PACK.test(value));
  const packCount = count ?? (singlePack ? 1 : null);
  if ((!pack || !concreteUnit(stated?.[2])) && packCount) {
    const containers = new Set(evidence.map((s) => s.container).filter(concreteUnit));
    for (const form of forms) containers.add(form);
    // 标题中的容器仅在与清单件数一致时采用。
    const title = toHalfWidth(product.title);
    const titleCheck = list?.multiLine ? title.replaceAll('+', '') : title;
    if (count && !UNSAFE.test(titleCheck)) {
      const labelled = [...title.matchAll(COUNTED_CONTAINER)];
      if (labelled.length === 1 && Number(labelled[0][1]) === count && concreteUnit(labelled[0][2])) containers.add(labelled[0][2]);
    }
    const container = containers.size === 1 ? [...containers][0] : '';
    if (container || (!pack && containers.size === 0)) {
      const next = { name: '包装规格', value: packCount + (container || '件') };
      const at = extra.findIndex((p) => p.name === next.name);
      if (at < 0) extra.push(next);
      else extra[at] = next;
    }
  }
  return result();
}
