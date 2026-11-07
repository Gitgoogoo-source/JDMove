// VC 采购员 / 销售员 ERP（纯函数）。
// 编辑里的存法：两个相同时只存 erpCode（老数据就是这样）；不同时分别存 buyerErp / salerErp。
// 发布时每个字段按 单独的 > 共用的 erpCode > 设置里的默认 ERP 取值，都没有时沿用页面默认值
import { ERP_RE } from './settings.js';

export const ERP_LABELS = { buyer: '采购员ERP', saler: '销售员ERP' };
export const ERP_FORMAT_HINT = '只能是字母、数字、点、下划线、横线（如 xudezhi.6），不能填姓名';
const ERP_KEYS = ['erpCode', 'buyerErp', 'salerErp'];

const clean = (v) => String(v ?? '').trim();

export const isErpCode = (v) => ERP_RE.test(clean(v));

/**
 * 编辑里的 ERP（不含设置默认值）
 * @param {{erpCode?: string, buyerErp?: string, salerErp?: string}|undefined} vc
 * @returns {{buyer: string, saler: string}}
 */
export function ownErp(vc) {
  const shared = clean(vc?.erpCode);
  return { buyer: clean(vc?.buyerErp) || shared, saler: clean(vc?.salerErp) || shared };
}

/**
 * 发布时用的 ERP：编辑里的优先，没有时用设置里的默认 ERP
 * @returns {{buyer: string, saler: string}}
 */
export function vcErpCodes(vc, fallback = '') {
  const own = ownErp(vc);
  const def = clean(fallback);
  return { buyer: own.buyer || def, saler: own.saler || def };
}

/**
 * 把 ERP 写回编辑里的 vc 对象（返回新对象）：两个相同 → erpCode；不同 → buyerErp / salerErp；空的不存
 * @param {object|undefined} vc
 * @param {{buyer?: string, saler?: string}} erp
 */
export function withErp(vc, { buyer, saler }) {
  const rest = Object.fromEntries(Object.entries(vc ?? {}).filter(([k]) => !ERP_KEYS.includes(k)));
  const b = clean(buyer);
  const s = clean(saler);
  if (b && b === s) return { ...rest, erpCode: b };
  return { ...rest, ...(b ? { buyerErp: b } : {}), ...(s ? { salerErp: s } : {}) };
}
