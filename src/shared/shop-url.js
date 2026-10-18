// 京东店铺链接解析与分页地址（纯函数）
//
// 店铺“全部商品”页：view_search-{appId}-{分类ID}-{排序}-{方向}-{每页条数}-{页码}.html
// appId 是店铺装修应用 ID，不是 shopId；只拿到首页链接时需要先打开首页，从页面链接里找出 appId。

/** 地址里的每页条数：服务端会忽略改大的值；实际每页条数由店铺模板决定（常见 24 或 20） */
export const SHOP_PAGE_SIZE = 24;

const SEARCH_PATH_RE = /\/view_search-(\d+)-(\d+)-(\d+)-(\d+)-\d+-(\d+)\.html$/;
// 店内搜索结果页等其他列表页：view_search- 后面跟更多段数字
const ANY_LIST_PATH_RE = /^\/view_search-[\d-]+\.html$/;
const FALLBACK_PAGE_SIZE = 60;

/** 默认排序翻页时商品顺序可能漂移（漏抓），数量不够时依次换这些排序补抓 */
export const SORT_FALLBACKS = Object.freeze([
  Object.freeze({ label: '上架时间', orderBy: '1' }),
  Object.freeze({ label: '销量', orderBy: '5' }),
]);
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
  // 店内搜索结果页等：打开后从页面读取店铺信息，再转到“全部商品”页
  if (ANY_LIST_PATH_RE.test(u.pathname)) return { kind: 'home', homeUrl: `https://mall.jd.com${u.pathname}` };
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
 * 解析商品总数：不同模板写法不同，如“共117条记录”“共74件商品”
 * @returns {number|null}
 */
export function parseTotalCount(text) {
  const m = String(text ?? '').match(/共\s*(\d+)\s*[条件个]/);
  return m ? Number(m[1]) : null;
}

const digitsOrNull = (v) => {
  const t = String(v ?? '').trim();
  return /^\d+$/.test(t) ? t : null;
};

/**
 * 整理页面上读到的店铺信息：appId 优先取隐藏字段 #pageInstance_appId（有些店铺首页上没有“全部商品”链接），
 * 没有时再从链接里找
 * @param {{appId?: string, venderId?: string, shopId?: string, links?: string[]}|null} info
 * @returns {{appId: string|null, venderId: string|null, shopId: string|null}}
 */
export function pickShopInfo(info) {
  return {
    appId: digitsOrNull(info?.appId) ?? appIdFromLinks(info?.links),
    venderId: digitsOrNull(info?.venderId),
    shopId: digitsOrNull(info?.shopId),
  };
}

/**
 * 兜底用的店内搜索页（关键词留空）：店铺“全部商品”页没有商品列表模块时使用。
 * 注意京东店内搜索最多返回 200 条，且不一定包含全部商品。
 */
export function buildFallbackSearchUrl({ appId, venderId, shopId }) {
  if (![appId, venderId, shopId].every((v) => digitsOrNull(v))) throw new Error('缺少店铺信息，无法打开店内搜索页');
  return `https://mall.jd.com/view_search-${appId}-${venderId}-${shopId}-0-1-0-0-1-1-${FALLBACK_PAGE_SIZE}.html?keyword=&isGlobalSearch=0`;
}

/**
 * 分页栏“下一页”链接 -> 要打开的地址。只接受京东店铺列表页；统一到 mall.jd.com。
 * 同一店铺的“全部商品”页按本轮的排序参数重建（分页栏链接会丢掉排序参数，前后页排序不一致会漏抓）。
 * @param {string} href
 * @param {{appId: string, categoryId?: string, orderBy?: string, direction?: string}|null} params
 * @returns {string|null}
 */
export function resolveNextUrl(href, params) {
  const raw = String(href ?? '').trim();
  if (!raw || /^javascript:/i.test(raw)) return null;
  const u = toUrl(raw);
  if (!u || !isJdHost(u.hostname) || !ANY_LIST_PATH_RE.test(u.pathname)) return null;
  const m = u.pathname.match(SEARCH_PATH_RE);
  if (m && params && String(params.appId) === m[1]) return buildShopSearchUrl({ ...params }, Number(m[5]));
  return `https://mall.jd.com${u.pathname}${u.search}`;
}
