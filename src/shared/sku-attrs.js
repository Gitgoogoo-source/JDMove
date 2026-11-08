// 商品条形码校验与 SKU属性抽屉（最小可售单位UPC 等）的填写值（纯函数）
import { toHalfWidth } from './text.js';

export const UPC_LABEL = '最小可售单位UPC';
const UPC_LABELS = [UPC_LABEL, '商品条形码', 'UPC'];
const UPC_RE = /^\d{8,14}$/; // EAN-8 / UPC-A / EAN-13 / ITF-14
// 京东主数据里没有登记条形码的商品会写 '0000000000000' 这类占位值，校验位也能算对，要单独排除
const SAME_DIGITS_RE = /^(\d)\1+$/;

/** GTIN 校验位：从右往左（不含校验位）奇数位乘 3、偶数位乘 1，补齐到 10 的倍数 */
function gtinCheckDigitOk(code) {
  const digits = [...code].map(Number);
  const check = digits.pop();
  const sum = digits.reverse().reduce((acc, d, i) => acc + d * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === check;
}

/**
 * 商品条形码：去掉空格、全角转半角，只接受 8~14 位数字、校验位正确、不是全同数字的占位值；无效时返回空串
 * @param {unknown} input
 * @returns {string}
 */
export function normalizeUpc(input) {
  const s = toHalfWidth(input).replace(/\s+/g, '');
  return UPC_RE.test(s) && !SAME_DIGITS_RE.test(s) && gtinCheckDigitOk(s) ? s : '';
}

const UPC_LIST_SEP = /[;；,，|、]/;

/**
 * 采集到的商品条形码。京东主数据 wareInfoReadMap.upc_code 有这几种写法：
 * - 真条形码：'6914973039001'
 * - 多值：'100050587042;6914973600058'（SKU 编号 + 条形码，分号分隔）
 * - 只有 SKU 编号：'100229520979'（商品没有登记条形码）
 * - 占位值：'0000000000000;100027810038'（没有登记条形码，normalizeUpc 会排除全零）
 * SKU 编号是 12 位数字能通过格式校验，但不是条形码，填进“最小可售单位UPC”会被京麦拒收；
 * 所以按分隔符拆开，跳过等于本商品或同款任一规格 SKU 编号的值，取第一个有效条形码
 * @param {{upc?: unknown, skuId?: unknown, variants?: {skuId?: unknown}[]} | undefined} product
 * @returns {string}
 */
export function productUpc(product) {
  const skuIds = [product?.skuId, ...(product?.variants ?? []).map((v) => v?.skuId)].map((id) => String(id ?? '').trim());
  const codes = toHalfWidth(product?.upc).split(UPC_LIST_SEP).map(normalizeUpc);
  return codes.find((code) => code && !skuIds.includes(code)) ?? '';
}

const fill = (labels, value) => Object.fromEntries(labels.map((l) => [l, value]));

/**
 * SKU 的商品条形码：upc（编辑里的 / 采集到的）> 属性覆盖里的 UPC；都没有时返回空串
 * @param {{upc?: unknown, overrides?: Record<string, string>}} input
 * @returns {string}
 */
export function resolveUpc({ upc, overrides = {} } = {}) {
  const overrideUpc = UPC_LABELS.map((l) => normalizeUpc(overrides[l])).find(Boolean);
  return normalizeUpc(upc) || overrideUpc || '';
}

/**
 * 按标签名给出 SKU属性抽屉的填写值。优先级：属性默认值 < 采集参数 < 属性覆盖 < UPC（resolveUpc）
 * @param {{params?: {name: string, value: string}[], defaults?: Record<string, string>, overrides?: Record<string, string>, upc?: string}} input
 * @returns {Record<string, string>}
 */
export function skuAttrValueMap({ params = [], defaults = {}, overrides = {}, upc } = {}) {
  const fromParams = Object.fromEntries(params.map((p) => [p.name, p.value]));
  const code = resolveUpc({ upc, overrides });
  return { ...defaults, ...fromParams, ...overrides, ...(code ? fill(UPC_LABELS, code) : {}) };
}
