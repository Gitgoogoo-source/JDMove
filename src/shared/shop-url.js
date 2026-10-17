// 京东店铺链接解析与分页地址（纯函数）
//
// 店铺“全部商品”页：view_search-{appId}-{分类ID}-{排序}-{方向}-{每页条数}-{页码}.html
// appId 是店铺装修应用 ID，不是 shopId；只拿到首页链接时需要先打开首页，从页面链接里找出 appId。

/** 京东服务端固定每页 24 条，URL 里改大也不会多返回 */
export const SHOP_PAGE_SIZE = 24;

const SEARCH_PATH_RE = /\/view_search-(\d+)-(\d+)-(\d+)-(\d+)-\d+-\d+\.html$/;
const SEARCH_LINK_RE = /view_search-(\d+)-\d+-\d+-\d+-\d+-\d+\.html/;
const MALL_INDEX_RE = /^\/index-(\d+)\.html$/;
// 这些 *.jd.com 二级域名不是店铺
const NON_SHOP_HOSTS = new Set(['jd.com', 'www.jd.com', 'mall.jd.com', 'item.jd.com', 'search.jd.com', 'passport.jd.com', 'cart.jd.com', 'order.jd.com', 'wares-jdm.jd.com']);

const mallIndexUrl = (shopId) => `https://mall.jd.com/index-${shopId}.html`;
const isJdHost = (host) => host === 'jd.com' || host.endsWith('.jd.com');

function toUrl(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return null;
  const withProtocol = raw.startsWith('//') ? `https:${raw}` : /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    return new URL(withProtocol);
  } catch {
    return null;
  }
}

/**
 * 识别用户填写的店铺链接
 * @param {string} input
 * @returns {{kind: 'search', appId: string, categoryId: string, orderBy: string, direction: string}
 *   | {kind: 'home', homeUrl: string} | null}
 */
export function parseShopInput(input) {
  const u = toUrl(input);
  if (!u || !isJdHost(u.hostname)) return null;
  const search = u.pathname.match(SEARCH_PATH_RE);
  if (search) {
    const [, appId, categoryId, orderBy, direction] = search;
    return { kind: 'search', appId, categoryId, orderBy, direction };
  }
  const shopId = u.searchParams.get('shopId');
  if (u.hostname === 'shop.m.jd.com' && /^\d+$/.test(shopId ?? '')) return { kind: 'home', homeUrl: mallIndexUrl(shopId) };
  const index = u.pathname.match(MALL_INDEX_RE);
  if (u.hostname === 'mall.jd.com' && index) return { kind: 'home', homeUrl: mallIndexUrl(index[1]) };
  // 店铺二级域名首页，如 dovechocolate.jd.com
  const isRoot = u.pathname === '/' || u.pathname === '/index.html';
  if (isRoot && !NON_SHOP_HOSTS.has(u.hostname) && !u.hostname.includes('.m.')) {
    return { kind: 'home', homeUrl: `https://${u.hostname}/` };
  }
  return null;
}

/**
 * 构造店铺商品列表第 pageNo 页的地址
 * @param {{appId: string|number, categoryId?: string|number, orderBy?: string|number, direction?: string|number}} shop
 * @param {number} pageNo 从 1 开始
 */
export function buildShopSearchUrl({ appId, categoryId = '0', orderBy = '0', direction = '1' }, pageNo) {
  const digits = (v) => /^\d+$/.test(String(v));
  if (!digits(appId)) throw new Error('店铺 appId 无效');
  if (![categoryId, orderBy, direction].every(digits)) throw new Error('店铺分类或排序参数无效');
  if (!Number.isInteger(pageNo) || pageNo < 1) throw new Error('页码无效');
  return `https://mall.jd.com/view_search-${appId}-${categoryId}-${orderBy}-${direction}-${SHOP_PAGE_SIZE}-${pageNo}.html`;
}

/**
 * 从店铺首页的链接中找出店铺 appId（取出现次数最多的那个，避免被友情链接干扰）
 * @param {string[]} links
 * @returns {string|null}
 */
export function appIdFromLinks(links) {
  const counts = new Map();
  for (const link of Array.isArray(links) ? links : []) {
    const m = String(link).match(SEARCH_LINK_RE);
    if (m) counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
  }
  let best = null;
  for (const [id, n] of counts) if (!best || n > counts.get(best)) best = id;
  return best;
}

/**
 * 解析分页栏里的“共117条记录”
 * @returns {number|null}
 */
export function parseTotalCount(text) {
  const m = String(text ?? '').match(/共\s*(\d+)\s*条/);
  return m ? Number(m[1]) : null;
}
