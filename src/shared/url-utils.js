// 京东链接 / 图片地址相关工具（纯函数）

// 文本里的京东链接（可以没有协议头）；遇到空白、引号或中文标点就结束
const JD_LINK_RE = /(?:https?:)?(?:\/\/)?(?:[\w-]+\.)*(?:jd\.com|jd\.hk)(?:[/?#][^\s<>"'，。；！？、（）【】]*)?/gi;
// 商品页路径：/100197331139.html、/product/100197331139.html
const ITEM_PATH_RE = /^\/(?:product\/)?(\d{6,})\.html$/;
// 京东万商（B2B 商城）商品页：/goods/goods-detail/100289450311；/trade/ 路径会跳转到这里
const B2B_HOST = 'b2b.jd.com';
const B2B_ITEM_PATH_RE = /^\/(?:goods|trade)\/goods-detail\/(\d{6,})\/?$/;
// 链接参数里直接带 SKU 的写法：ware/view.action?wareId=…、…?skuId=…
const SKU_PARAMS = ['wareId', 'skuId', 'sku'];
// 不在链接里的纯数字编码
const BARE_SKU_RE = /(?:^|[^\d])(\d{8,15})(?=$|[^\d])/g;

const IMG_HOST = 'https://img14.360buyimg.com';
// 京东自营商品的 /n0/、/n1/… 图会叠加“JD.COM 京东”水印；/sku/ 返回同一张图未加水印的原图
const ORIGINAL_PREFIX = `${IMG_HOST}/sku/`;
const IMGZONE_PREFIX = 'https://img10.360buyimg.com/imgzone/';
const PUBLISH_BASE = 'https://wares-jdm.jd.com/popPublish/';

const withScheme = (link) => (/^https?:/i.test(link) ? link : `https://${link.replace(/^\/\//, '')}`);

function parseLink(link) {
  try {
    return new URL(withScheme(link));
  } catch {
    return null;
  }
}

const b2bSkuOf = (u) => (u?.hostname === B2B_HOST ? (u.pathname.match(B2B_ITEM_PATH_RE)?.[1] ?? null) : null);

/** 是否京东万商商品页 */
export const isB2bItemUrl = (url) => Boolean(b2bSkuOf(parseLink(String(url ?? ''))));

/**
 * 京东链接对应的商品 SKU：只看商品页路径和 wareId/skuId 参数，后缀里的其他参数（spmTag、pvid、时间戳等）一律忽略
 * @param {string} link
 * @returns {string|null} 不是商品链接时返回 null
 */
export function skuFromLink(link) {
  const u = parseLink(link);
  if (!u) return null;
  const b2b = b2bSkuOf(u);
  if (b2b) return b2b;
  const inPath = u.pathname.match(ITEM_PATH_RE)?.[1];
  if (inPath) return inPath;
  const inParam = SKU_PARAMS.map((k) => u.searchParams.get(k)).find((v) => /^\d{6,}$/.test(v ?? ''));
  return inParam ?? null;
}

/**
 * 从任意文本中提取京东商品 SKU（保持出现顺序、去重）。
 * 同一个 SKU 不管链接后面加了什么后缀都识别为同一个商品；链接里除 SKU 以外的数字不会被当成商品
 * @param {string} text
 * @returns {string[]}
 */
export function extractSkuIds(text) {
  const src = String(text ?? '');
  const links = [...src.matchAll(JD_LINK_RE)];
  const fromLinks = links.map((m) => ({ id: skuFromLink(m[0]), at: m.index })).filter((x) => x.id);
  // 链接部分换成空格后再找纯数字编码，避免把链接参数里的数字当成 SKU
  const rest = links.reduce((acc, m) => acc.slice(0, m.index) + ' '.repeat(m[0].length) + acc.slice(m.index + m[0].length), src);
  const bare = [...rest.matchAll(BARE_SKU_RE)].map((m) => ({ id: m[1], at: m.index }));
  const hits = [...fromLinks, ...bare].sort((a, b) => a.at - b.at);
  return [...new Set(hits.map((h) => h.id))];
}

/**
 * 文本里的京东万商商品链接（SKU → 链接）：万商的商品只能在万商页采集，链接原样保留（buId 等参数决定业务线）
 * @param {string} text
 * @returns {Record<string, string>}
 */
export function b2bItemUrls(text) {
  const links = [...String(text ?? '').matchAll(JD_LINK_RE)].map((m) => withScheme(m[0])).filter(isB2bItemUrl);
  return Object.fromEntries(links.map((url) => [skuFromLink(url), url]));
}

export function buildItemUrl(skuId) {
  return `https://item.jd.com/${skuId}.html`;
}

function withProtocol(url) {
  if (url.startsWith('//')) return `https:${url}`;
  if (url.startsWith('http://')) return `https://${url.slice(7)}`;
  return url;
}

/**
 * 把京东缩略图 / 带水印图地址转换为无水印原图地址
 * @param {string} url
 * @returns {string}
 */
export function toOriginalImageUrl(url) {
  const raw = String(url ?? '').trim();
  if (!raw) return '';
  if (raw.startsWith('jfs/')) return `${ORIGINAL_PREFIX}${raw}`;
  let out = withProtocol(raw);
  if (!/360buyimg\.com/.test(out)) return out;
  // 去掉 !q70.dpg.webp / .avif / _.webp 等派生后缀
  out = out.replace(/!q\d+.*$/i, '').replace(/(\.(?:jpe?g|png|gif|bmp))(?:\.(?:avif|webp|dpg))+$/i, '$1');
  out = out.replace(/_\.webp$/i, '');
  // /n0/jfs/...、/n5/s54x54_jfs/... -> /sku/jfs/...
  out = out.replace(/\/n\d+\/(?:s\d+x\d+_)?(jfs\/)/, '/sku/$1');
  out = out.replace(/\/(sku|imgzone|cms)\/s\d+x\d+_(jfs\/)/, '/$1/$2');
  // 其他带尺寸前缀的缩略图（如 /pcpubliccms/s228x228_jfs/）统一换成商品原图地址
  const sized = out.match(/\/[\w-]+\/s\d+x\d+_(jfs\/.+)$/);
  if (sized) out = `${ORIGINAL_PREFIX}${sized[1]}`;
  return out;
}

export function jfsPathOf(url) {
  const m = String(url ?? '').match(/(jfs\/[^?#!]+)/);
  return m ? m[1] : null;
}

export function imgzoneUrl(jfsPath) {
  return `${IMGZONE_PREFIX}${jfsPath}`;
}

/**
 * 页面类型识别：item / merchant_block / throttle / login / b2b_login / publish / category / other
 * @param {string} url
 */
export function classifyPageUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return 'other';
  }
  const host = u.hostname;
  // 商家账号登录状态下，京东禁止查看其他店铺商品
  if (host === 'bizsafe-intercept.jd.com') return 'merchant_block';
  if (/pc-frequent|risk_handler|safe\.jd\.com/.test(host + u.pathname)) return 'throttle';
  if (/passport\.jd\.com|plogin\.m\.jd\.com/.test(host)) return 'login';
  if (/^item(\.m)?\.jd\.com$/.test(host)) return 'item';
  if (host === B2B_HOST && u.pathname.startsWith('/account/login')) return 'b2b_login';
  if (b2bSkuOf(u)) return 'item';
  if (host === 'wares-jdm.jd.com' && u.pathname.startsWith('/popPublish')) return 'publish';
  if (host === 'wares-jdm.jd.com' && /categorySelect/.test(u.pathname)) return 'category';
  return 'other';
}

/**
 * 构造发布页地址（直接带类目进入填写页）
 * @param {{cateList: Array<number|string>}} input
 */
export function buildPublishUrl({ cateList }) {
  const ids = (cateList ?? []).map(String).filter((s) => /^\d+$/.test(s));
  if (ids.length === 0) throw new Error('缺少有效的类目ID');
  const params = new URLSearchParams({
    categoryId: ids[ids.length - 1],
    cateList: ids.join(','),
    newFlow: '1',
    newSource: 'true',
    locType: '0',
    source: '1',
    publishType: '1',
    publishPageType: '1',
  });
  return `${PUBLISH_BASE}?${params.toString()}`;
}
