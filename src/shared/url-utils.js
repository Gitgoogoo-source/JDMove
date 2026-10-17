// 京东链接 / 图片地址相关工具（纯函数）

const SKU_PATTERNS = [
  /item\.jd\.com\/(\d{6,})\.html/g,
  /item\.m\.jd\.com\/product\/(\d{6,})\.html/g,
  /item\.m\.jd\.com\/(?:ware\/view\.action\?wareId=)(\d{6,})/g,
  /(?:^|[^\d])(\d{8,15})(?=$|[^\d])/gm,
];

const IMG_HOST = 'https://img14.360buyimg.com';
const IMGZONE_PREFIX = 'https://img10.360buyimg.com/imgzone/';
const PUBLISH_BASE = 'https://wares-jdm.jd.com/popPublish/';

/**
 * 从任意文本中提取京东商品 SKU（保持出现顺序、去重）
 * @param {string} text
 * @returns {string[]}
 */
export function extractSkuIds(text) {
  const src = String(text ?? '');
  const hits = [];
  for (const re of SKU_PATTERNS) {
    for (const m of src.matchAll(re)) hits.push({ id: m[1], at: m.index });
  }
  hits.sort((a, b) => a.at - b.at);
  return [...new Set(hits.map((h) => h.id))];
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
 * 把京东缩略图地址转换为原图地址
 * @param {string} url
 * @returns {string}
 */
export function toOriginalImageUrl(url) {
  const raw = String(url ?? '').trim();
  if (!raw) return '';
  if (raw.startsWith('jfs/')) return `${IMG_HOST}/n0/${raw}`;
  let out = withProtocol(raw);
  if (!/360buyimg\.com/.test(out)) return out;
  // 去掉 !q70.dpg.webp / .avif / _.webp 等派生后缀
  out = out.replace(/!q\d+.*$/i, '').replace(/(\.(?:jpe?g|png|gif|bmp))(?:\.(?:avif|webp|dpg))+$/i, '$1');
  out = out.replace(/_\.webp$/i, '');
  // /n5/s54x54_jfs/... -> /n0/jfs/...
  out = out.replace(/\/n\d+\/(?:s\d+x\d+_)?(jfs\/)/, '/n0/$1');
  out = out.replace(/\/(sku|imgzone|cms)\/s\d+x\d+_(jfs\/)/, '/$1/$2');
  // 其他带尺寸前缀的缩略图（如 /pcpubliccms/s228x228_jfs/）统一换成商品原图地址
  const sized = out.match(/\/[\w-]+\/s\d+x\d+_(jfs\/.+)$/);
  if (sized) out = `${IMG_HOST}/n0/${sized[1]}`;
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
 * 页面类型识别：item / merchant_block / throttle / login / publish / category / other
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
