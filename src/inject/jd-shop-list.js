// 注入到京东店铺页（mall.jd.com / *.jd.com，MAIN world）执行。
// 店铺“全部商品”主列表由页面脚本调用带签名的接口异步渲染，这里只等待渲染完成后读 DOM，
// 不直接请求接口。总数解析、翻页判断在扩展侧完成。
(() => {
  const NS = (window.__JDMOVE__ = window.__JDMOVE__ || {});
  if (NS.extractShopPage) return;

  const POLL_MS = 400;
  const STABLE_POLLS = 2;
  const SKU_HREF_RE = /item\.jd\.com\/(\d{6,})\.html/;
  // 销售排行、推荐位等侧栏模块，不属于本页商品
  const SIDE_MODULE_SEL = '[class*="SaleRank"], [class*="saleRank"], [class*="hot-link"]';

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const qsa = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  function pageType() {
    const href = location.href;
    if (/bizsafe-intercept/.test(href)) return 'merchant_block';
    if (/pc-frequent|risk_handler|safe\.jd\.com/.test(href) || /频控|访问频繁/.test(document.title)) return 'throttle';
    if (/passport\.jd\.com/.test(href)) return 'login';
    return 'shop';
  }

  // 主列表模块：常见模板的 class 为 jGoodsList-<模板ID>；其他模板退回到分页栏所在的模块
  function listRoots() {
    const lists = qsa('[class*="jGoodsList"]');
    if (lists.length) return lists;
    const pager = document.querySelector('.jPage');
    const mod = pager && pager.closest('.j-module, [module-id], [class*="module"]');
    return mod ? [mod] : [];
  }

  function skusIn(root) {
    const ids = [];
    for (const a of qsa('a[href*="item.jd.com/"]', root)) {
      if (a.closest(SIDE_MODULE_SEL)) continue;
      const m = a.href.match(SKU_HREF_RE);
      if (m) ids.push(m[1]);
    }
    for (const el of qsa('[jdprice]', root)) {
      const v = el.getAttribute('jdprice');
      if (/^\d{6,}$/.test(v) && !el.closest(SIDE_MODULE_SEL)) ids.push(v);
    }
    return ids;
  }

  function snapshot() {
    const skus = Array.from(new Set(listRoots().flatMap(skusIn)));
    const pager = document.querySelector('.jPage');
    return { skus, totalText: pager ? pager.textContent.replace(/\s+/g, ' ').trim() : '' };
  }

  /**
   * 等待主列表渲染稳定后返回本页 SKU
   * @param {{timeoutMs?: number}} [opts]
   */
  NS.extractShopPage = async function extractShopPage({ timeoutMs = 15000 } = {}) {
    const type = pageType();
    if (type !== 'shop') return { pageType: type, skus: [], totalText: '' };
    const end = Date.now() + timeoutMs;
    let last = snapshot();
    let stable = 0;
    while (Date.now() < end) {
      await sleep(POLL_MS);
      const cur = snapshot();
      const settled = cur.skus.length === last.skus.length && (cur.skus.length > 0 || /共\s*0\s*条/.test(cur.totalText));
      stable = settled ? stable + 1 : 0;
      last = cur;
      if (stable >= STABLE_POLLS) break;
    }
    return { pageType: pageType(), skus: last.skus, totalText: last.totalText };
  };

  // 店铺首页：列出页面上的“全部商品/分类”链接，扩展侧从中找出 appId
  NS.listShopSearchLinks = function listShopSearchLinks() {
    const links = qsa('a[href*="view_search-"]').map((a) => a.href);
    const html = document.documentElement.innerHTML.match(/view_search-\d+-\d+-\d+-\d+-\d+-\d+\.html/g) || [];
    return { pageType: pageType(), links: links.concat(html) };
  };
})();
