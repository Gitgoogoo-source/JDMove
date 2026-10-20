// 已发布商品的价格监控与改价（纯函数）：京东今日价 vs 店铺售价、改价结果、店铺商品编辑页地址
import { computePrice } from './pricing.js';
import { isArchived } from './brand-folders.js';

/** “已发布”页里列出所有价格倒挂商品的虚拟文件夹 */
export const ALERT_FOLDER_KEY = '__price_alert__';
export const WARE_ID_TOKEN = '{wareId}';

const WARE_ID_RE = /^\d{4,20}$/;
// 编辑页地址里可能放商品编号的参数（含 hash 路由里的参数）
const ID_PARAM_RE = /([?&#](?:wareId|skuId|spuId|productId|itemId|id)=)(\d{6,20})(?=[&#]|$)/gi;
// 或者在路径里：/edit/10088812345、/10088812345.html
const ID_PATH_RE = /(\/)(\d{6,20})(?=(?:\.html?)?(?:[/?#]|$))/g;
const SAMPLE_ID = '10000000';
// 编辑页上的原价与记录的售价相差在 1%（至少 1 分）以内算同一个商品
const PRICE_MATCH_RATIO = 0.01;

const round2 = (v) => Math.round((v + Number.EPSILON) * 100) / 100;

function isJdHttps(url) {
  try {
    const u = new URL(url);
    const jdHost = u.hostname === 'jd.com' || u.hostname.endsWith('.jd.com');
    return u.protocol === 'https:' && jdHost && !u.username && !u.password;
  } catch {
    return false;
  }
}

/**
 * 地址里商品编号的位置：只有一个编号参数时用它，没有参数时用路径里唯一的长数字。
 * 有多个编号（如同时带 wareId 和 skuId）时分不清页面按哪个打开商品，宁可不认：
 * 否则没换掉的那个编号会让每个商品都打开示例商品的编辑页
 */
function locateId(rest) {
  const params = [...rest.matchAll(ID_PARAM_RE)];
  if (params.length === 1) return { at: params[0].index + params[0][1].length, id: params[0][2] };
  if (params.length > 1) return null;
  const paths = [...rest.matchAll(ID_PATH_RE)];
  return paths.length === 1 ? { at: paths[0].index + 1, id: paths[0][2] } : null;
}

/**
 * 店铺当前售价：发布/改价时记下的价格优先；早先发布的商品没有记录，按编辑价或改价规则推算
 * @param {object} item
 * @param {object} priceRule settings.price
 * @returns {number|null}
 */
export function salePriceOf(item, priceRule) {
  if (item?.salePrice > 0) return item.salePrice;
  if (Number(item?.edits?.price) > 0) return Number(item.edits.price);
  return computePrice(item?.product?.price, priceRule);
}

/**
 * 京东今日价与店铺售价对比
 * inverted：京东今日价高于售价（卖出即亏本）；alert：倒挂，或利润低于设置的预警线
 * @param {object} item
 * @param {{price: object, priceWatch?: {alertMargin?: number}}} settings
 * @returns {{sale: number|null, jd: number|null, profit: number|null, inverted: boolean, alert: boolean}}
 */
export function priceStatus(item, settings) {
  const sale = salePriceOf(item, settings.price);
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
 * 按京东今日价改价：今日价 + 加价，保留到分；没有今日价时返回 null
 * @param {object} item
 * @param {number} [add]
 * @returns {number|null}
 */
export function priceFromJd(item, add = 0) {
  const jd = item?.priceCheck?.price;
  if (!(jd > 0)) return null;
  return Math.max(0.01, round2(jd + (Number(add) || 0)));
}

/**
 * 由商品编辑页地址得到地址模板：把其中的商品编号换成 {wareId}；也可以直接填写带 {wareId} 的模板。
 * 只接受京东域名下的 https 地址；地址里有多个分不清的编号时返回 null
 * @param {string} input
 * @returns {{template: string, sampleId: string}|null}
 */
export function deriveEditUrlTemplate(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return null;
  if (raw.includes(WARE_ID_TOKEN)) {
    // 模板里还留着别的固定编号（如 skuId=100012345678）时，每个商品都会带上它，不接受
    const fixedIds = [...raw.matchAll(ID_PARAM_RE)].length;
    return !fixedIds && isJdHttps(raw.replaceAll(WARE_ID_TOKEN, SAMPLE_ID)) ? { template: raw, sampleId: '' } : null;
  }
  if (!isJdHttps(raw)) return null;
  const u = new URL(raw);
  const rest = u.pathname + u.search + u.hash;
  const hit = locateId(rest);
  if (!hit) return null;
  const template = u.origin + rest.slice(0, hit.at) + WARE_ID_TOKEN + rest.slice(hit.at + hit.id.length);
  return isJdHttps(template.replaceAll(WARE_ID_TOKEN, SAMPLE_ID)) ? { template, sampleId: hit.id } : null;
}

/** 店铺商品编号：只保留纯数字编号，其他输入视为未填写 */
export function normalizeWareId(input) {
  const s = String(input ?? '').trim();
  return WARE_ID_RE.test(s) ? s : '';
}

/**
 * @param {string} template
 * @param {string} wareId
 * @returns {string}
 */
export function buildEditUrl(template, wareId) {
  const t = deriveEditUrlTemplate(template);
  if (!t) throw new Error('还没有设置“商品编辑页地址”，请在批量改价窗口或设置中填写');
  const id = normalizeWareId(wareId);
  if (!id) throw new Error(`店铺商品编号无效：${wareId ?? ''}`);
  return t.template.replaceAll(WARE_ID_TOKEN, id);
}

/**
 * 发布成功后店铺里的商品编号：提交接口返回的编号 > 跳转后地址里的 wareId > 提示文字里的“商品编号”。
 * 接口里抓到多个不同编号时无法确定是哪一个，不采用（记错编号会把别的商品改价）
 * @param {{captured?: string[], url?: string, messages?: string[]}} [res]
 * @returns {string}
 */
export function parseWareId({ captured = [], url = '', messages = [] } = {}) {
  const ids = [...new Set(captured.map(String).filter((v) => /^\d{6,20}$/.test(v)))];
  if (ids.length === 1) return ids[0];
  const inUrl = String(url).match(/[?&#]wareId=(\d{6,20})/i)?.[1];
  if (inUrl) return inUrl;
  return messages.map(String).join(' ').match(/商品(?:编号|ID)\s*[:：]?\s*(\d{6,20})/i)?.[1] ?? '';
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

/**
 * 编辑页上的原京东价是否和记录的售价对得上（防止店铺商品编号填错，把价格改到别的商品上）
 * @param {Array<string|number>} pagePrices 编辑页上已启用 SKU 的京东价
 * @param {number|null} expected 记录的店铺售价
 */
export function pricesMatch(pagePrices, expected) {
  if (!(expected > 0)) return false;
  const tolerance = Math.max(0.01, expected * PRICE_MATCH_RATIO);
  return pagePrices.map(Number).some((p) => p > 0 && Math.abs(p - expected) <= tolerance + 1e-9);
}

/**
 * 改价结果写回条目：成功时店铺售价和编辑价都换成新价格（以后重新发布也用这个价）
 * @param {object} item
 * @param {{status: string, price: number, from?: string, message?: string}} res
 */
export function repricePatch(item, res, now = Date.now()) {
  const reprice = { at: now, from: res.from ?? '', to: res.price, status: res.status, message: res.message ?? '' };
  if (res.status !== 'ok') return { reprice, message: `改价未完成：${res.message ?? ''}` };
  // 只保存了草稿：店铺里的售价还没变，不更新记录，倒挂提醒继续保留
  if (res.draft) return { reprice, message: `新价格 ¥${res.price} 已保存为草稿，提交后才会生效` };
  return {
    reprice,
    salePrice: res.price,
    edits: { ...(item.edits ?? {}), price: res.price },
    message: `已改价为 ¥${res.price}${res.message ? `（${res.message}）` : ''}`,
  };
}

/** 检查时间的简短写法：10-19 09:30 */
export function formatCheckTime(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
