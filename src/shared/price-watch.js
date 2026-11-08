// 已发布商品的价格监控（纯函数）：京东今日价 vs 店铺售价（VC 京东价）
import { isArchived } from './brand-folders.js';

/** “已发布”页里列出所有价格倒挂商品的虚拟文件夹 */
export const ALERT_FOLDER_KEY = '__price_alert__';

const round2 = (v) => Math.round((v + Number.EPSILON) * 100) / 100;
const positive = (v) => (Number(v) > 0 ? Number(v) : null);

/**
 * 店铺售价：发布（保存草稿）时记下的 VC 京东价优先，没有记录时用「编辑 → VC 自营」里填的京东价
 * @param {object} item
 * @returns {number|null}
 */
export function salePriceOf(item) {
  return positive(item?.salePrice) ?? positive(item?.edits?.vc?.jdPrice);
}

/**
 * 京东今日价与店铺售价对比
 * inverted：京东今日价高于售价（卖出即亏本）；alert：倒挂，或利润低于设置的预警线
 * @param {object} item
 * @param {{priceWatch?: {alertMargin?: number}}} settings
 * @returns {{sale: number|null, jd: number|null, profit: number|null, inverted: boolean, alert: boolean}}
 */
export function priceStatus(item, settings) {
  const sale = salePriceOf(item);
  const jd = item?.priceCheck?.price > 0 ? item.priceCheck.price : null;
  const profit = sale > 0 && jd ? round2(sale - jd) : null;
  const margin = Math.max(0, Number(settings.priceWatch?.alertMargin) || 0);
  const inverted = profit != null && profit < 0;
  return { sale, jd, profit, inverted, alert: inverted || (profit != null && profit < margin) };
}

/**
 * 已发布商品里需要提醒的（倒挂/利润不足），亏得最多的在前
 * @param {object[]} items
 * @param {object} settings
 */
export function alertItems(items, settings) {
  return items
    .filter(isArchived)
    .map((item) => ({ item, st: priceStatus(item, settings) }))
    .filter(({ st }) => st.alert)
    .sort((a, b) => a.st.profit - b.st.profit)
    .map(({ item }) => item);
}

export const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();

/** 今天（本地日期）是否已经成功检查过京东价；最近一次检查失败的算没检查，下次会重试 */
export function checkedToday(item, now = Date.now()) {
  const check = item?.priceCheck;
  return Boolean(check?.checkedAt) && !check.error && sameDay(check.checkedAt, now);
}

/**
 * 一次价格检查的结果写回条目。失败时保留上次成功的价格（倒挂提醒不会因为一次打不开页面就消失），
 * 只记下失败原因和时间
 * @param {{status: string, price?: number, label?: string, message?: string}} res
 * @param {number} [now]
 * @param {object} [prev] 条目原来的 priceCheck
 */
export function priceCheckPatch(res, now = Date.now(), prev = null) {
  if (res.status === 'ok') return { priceCheck: { price: res.price, label: res.label || '', checkedAt: now } };
  const last = prev?.price > 0 ? { price: prev.price, label: prev.label || '', checkedAt: prev.checkedAt } : { price: null, label: '', checkedAt: null };
  return { priceCheck: { ...last, error: res.message || '获取失败', errorAt: now } };
}

/** 检查时间的简短写法：10-19 09:30 */
export function formatCheckTime(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
