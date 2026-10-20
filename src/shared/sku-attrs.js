// SKU属性抽屉（建议零售价、最小可售单位UPC 等）的填写值与结果说明（纯函数）
import { normalizeName, toHalfWidth } from './text.js';

export const UPC_LABEL = '最小可售单位UPC';
const UPC_LABELS = [UPC_LABEL, '商品条形码', 'UPC'];
const PRICE_LABELS = ['建议零售价', '市场价'];
const UPC_RE = /^\d{8,14}$/; // EAN-8 / UPC-A / EAN-13 / ITF-14

/**
 * 商品条形码：去掉空格、全角转半角，只接受 8~14 位数字；无效时返回空串
 * @param {unknown} input
 * @returns {string}
 */
export function normalizeUpc(input) {
  const s = toHalfWidth(input).replace(/\s+/g, '');
  return UPC_RE.test(s) ? s : '';
}

const UPC_LIST_SEP = /[;；,，|、]/;

/**
 * 采集到的商品条形码。京东主数据 wareInfoReadMap.upc_code 有三种写法：
 * - 真条形码：'6914973039001'
 * - 多值：'100050587042;6914973600058'（SKU 编号 + 条形码，分号分隔）
 * - 只有 SKU 编号：'100229520979'（商品没有登记条形码）
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
 * 按标签名给出 SKU属性抽屉的填写值。优先级：属性默认值 < 采集参数 < 源价格 < 属性覆盖 < 编辑里的 UPC
 * @param {{params?: {name: string, value: string}[], defaults?: Record<string, string>, overrides?: Record<string, string>,
 *   sourcePrice?: number, upc?: string}} input
 * @returns {Record<string, string>}
 */
export function skuAttrValueMap({ params = [], defaults = {}, overrides = {}, sourcePrice, upc } = {}) {
  const fromParams = Object.fromEntries(params.map((p) => [p.name, p.value]));
  const price = sourcePrice > 0 ? fill(PRICE_LABELS, String(sourcePrice)) : {};
  const overrideUpc = UPC_LABELS.map((l) => normalizeUpc(overrides[l])).find(Boolean);
  const code = normalizeUpc(upc) || overrideUpc;
  return { ...defaults, ...fromParams, ...price, ...overrides, ...(code ? fill(UPC_LABELS, code) : {}) };
}

/** @param {Record<string, string>} map */
export const hasUpc = (map) => Boolean(normalizeUpc(map?.[UPC_LABEL]));

const rowList = (rows) => `第 ${rows.map((r) => r + 1).join('、')} 行`;

function rowMessage(r) {
  if (r.error) return r.error;
  if (!r.confirmed) {
    const why = r.missing?.length ? `（必填项未填：${r.missing.join('、')}）` : '';
    const lost = r.filled?.length ? `，本行已填的 ${r.filled.join('、')} 已被京麦丢弃` : '';
    return `SKU属性面板未能保存${why}${lost}，请在京麦编辑页手动补全`;
  }
  return r.missing?.length ? `SKU属性未填：${r.missing.join('、')}` : '';
}

/**
 * 把逐行的抽屉填写结果合并成日志；内容相同的行合并成一条
 * @param {{row: number, confirmed: boolean, filled?: string[], missing?: string[], error?: string}[] | undefined} results
 * @returns {string[]}
 */
export function describeSkuAttrResults(results) {
  const groups = new Map();
  for (const r of results ?? []) {
    const msg = rowMessage(r);
    if (msg) groups.set(msg, [...(groups.get(msg) ?? []), r.row]);
  }
  return [...groups].map(([msg, rows]) => `SKU ${rowList(rows)}：${msg}`);
}

const isFilled = (v) => v != null && String(v).trim() !== '';

/**
 * 表单数据里每个启用行仍为空的 SKU属性必填项
 * @param {{required?: {field: string, label: string}[], skuProps?: (Record<string, unknown>|null)[]}} state 页面 readSkuAttrState 的结果
 * @param {boolean[]} enabled 计划里每行是否启用（与 skuProps 同序）
 * @returns {{row: number, missing: string[]}[]}
 */
export function missingSkuAttrs(state, enabled = []) {
  const required = state?.required ?? [];
  if (!required.length) return [];
  return (state?.skuProps ?? []).flatMap((props, row) => {
    if (enabled[row] === false) return [];
    const missing = required.filter((f) => !isFilled(props?.[f.field])).map((f) => f.label);
    return missing.length ? [{ row, missing }] : [];
  });
}

/** 与页面上按标签取值的规则一致：先精确匹配，再互相包含 */
function plannedValue(label, valueMap) {
  const want = normalizeName(label);
  const keys = Object.keys(valueMap ?? {});
  const key =
    keys.find((k) => normalizeName(k) === want) ??
    keys.find((k) => normalizeName(k).length >= 2 && (want.includes(normalizeName(k)) || normalizeName(k).includes(want)));
  return key == null ? null : valueMap[key];
}

/**
 * 重填后必填项仍为空时的停止原因：计划里本来就没有值的需要用户补（need_action），有值却没生效的算失败
 * @param {{row: number, missing: string[]}[]} missingRows
 * @param {Record<string, string>} valueMap
 * @returns {{status: 'need_action'|'failed', message: string}}
 */
export function skuAttrStop(missingRows, valueMap) {
  const labels = [...new Set(missingRows.flatMap((r) => r.missing))];
  const noValue = labels.filter((l) => !isFilled(plannedValue(l, valueMap)));
  if (noValue.length) {
    return {
      status: 'need_action',
      message: `SKU属性必填项没有可填的值：${noValue.join('、')}，已停止保存；请在「编辑」中填写（UPC 填在「UPC」，其它填在「属性覆盖」）`,
    };
  }
  return {
    status: 'failed',
    message: `SKU属性必填项填写后没有生效（${formatMissingRows(missingRows)}），已停止保存，请在工作窗口中检查`,
  };
}

/** @param {{row: number, missing: string[]}[]} missingRows */
export function formatMissingRows(missingRows) {
  const groups = new Map();
  for (const r of missingRows) {
    const key = r.missing.join('、');
    groups.set(key, [...(groups.get(key) ?? []), r.row]);
  }
  return [...groups].map(([fields, rows]) => `${rowList(rows)} ${fields}`).join('；');
}
