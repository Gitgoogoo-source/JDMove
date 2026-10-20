// 注入到京东店铺页（mall.jd.com / *.jd.com，MAIN world）执行。
// 店铺“全部商品”主列表由页面脚本异步渲染，这里只等待渲染完成后读 DOM，不直接请求接口。
//
// 店铺装修模板差异（实测几十家自营店铺后归纳）：
// - 列表模块可能是 jGoodsList-<模板ID>、JColorSearchList（J-goods-list）或店内搜索的 jSearchListArea；
// - 同一页面可能有多个列表模块，各自有分页栏；
// - “下一页”可能是普通链接（地址里的页码有效），也可能是 onclick="pageGoodsList(n, this)" 页内翻页；
// - 每页条数 20 / 24 / 60 不等，总数写法有“共N条记录”“共N件商品”；
// - 列表接口被限流时模块一直停在“努力加载中”（div.m_render_structure.loading）。
// 所以这里以“带分页栏的模块”为单位工作，翻页跟着该模块里的“下一页”走。
// 每张商品卡片是一个 SPU，卡片下方的规格缩略图（li[sid]）是同一 SPU 的其他 SKU，一并返回（见 src/shared/shop-spu.js）。
(() => {
  const NS = (window.__JDMOVE__ = window.__JDMOVE__ || {});
  // 以最新加入的标记判断，避免同一页面里残留旧版本脚本
  if (NS.shopListSpus) return;
  NS.shopListSpus = true;

  const POLL_MS = 400;
  const STABLE_POLLS = 2;
  const WAIT_MS = 15000;
  const EMPTY_WAIT_MS = 6000;
  const SKU_HREF_RE = /item\.jd\.com\/(\d{6,})\.html/;
  const TOTAL_RE = /共\s*\d+\s*[条件个][^\s]{0,4}/;
  const ZERO_TOTAL_RE = /共\s*0\s*[条件个]/;
  // 列表容器（含表头的排序、总数和分页栏）；找不到时退回到模块实例（.J_LayoutArea 的直接子元素）
  const LIST_ROOT_SEL = '.JColorSearchList, .jSearchListArea, [class*="jGoodsList"]';
  const MODULE_SEL = '.J_LayoutArea > *';
  const LIST_SEL = '[class*="jGoodsList"], .J-goods-list, .jSearchListArea';
  const LOADING_SEL = '.m_render_structure.loading';
  // 销售排行、推荐位等侧栏模块，不属于商品列表
  const SIDE_MODULE_SEL = '[class*="SaleRank"], [class*="saleRank"], [class*="hot-link"], [class*="GoodsRecommend"]';
  // 商品卡片下方的规格缩略图：li[sid] 的 sid 是同一 SPU 其他规格的 SKU
  const THUMB_SEL = '[sid]';
  const CARD_SEL = '.jSubObject, .gl-item, .jItem';

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const qsa = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const text = (el) => (el ? (el.innerText || el.textContent || '').replace(/\s+/g, ' ') : '');

  function pageType() {
    const href = location.href;
    if (/bizsafe-intercept/.test(href)) return 'merchant_block';
    if (/pc-frequent|risk_handler|safe\.jd\.com/.test(href) || /频控|访问频繁/.test(document.title)) return 'throttle';
    if (/passport\.jd\.com/.test(href)) return 'login';
    return 'shop';
  }

  // 取最近的列表容器，避免把同一装修模块里推荐位的商品也算进来
  function moduleRootOf(el) {
    return el.closest(LIST_ROOT_SEL) || el.closest(MODULE_SEL) || el.closest('.j-module') || el;
  }

  const loadingPending = () => Boolean(document.querySelector(LOADING_SEL));

  // 列表模块：每个分页栏所在的模块；页面上没有分页栏时退回到已知的列表容器
  function listModules() {
    const roots = [];
    const add = (el) => {
      const root = moduleRootOf(el);
      if (!roots.includes(root) && !root.closest(SIDE_MODULE_SEL)) roots.push(root);
    };
    qsa('.jPage').forEach(add);
    if (!roots.length) qsa(LIST_SEL).forEach(add);
    return roots;
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
    return Array.from(new Set(ids));
  }

  const thumbSkus = (root) => qsa(THUMB_SEL, root).map((el) => el.getAttribute('sid')).filter((v) => /^\d{6,}$/.test(v));

  // 主 SKU 所在的商品卡片：主图/标题链接或价格元素最近的卡片容器（不能是缩略图本身）
  function cardOf(root, sku) {
    const links = qsa(`a[href*="item.jd.com/${sku}.html"], [jdprice="${sku}"]`, root).filter((el) => !el.closest(THUMB_SEL));
    for (const el of links) {
      const card = el.closest(CARD_SEL) || el.closest('li');
      if (card && root.contains(card)) return card;
    }
    return null;
  }

  // 每张卡片是一个 SPU：主 SKU + 规格缩略图（最多显示 5 个）；模板不显示缩略图时 sids 为 null
  function spusIn(root, skus) {
    const hasThumbs = thumbSkus(root).length > 0;
    return skus.map((sku) => {
      const card = hasThumbs ? cardOf(root, sku) : null;
      return { sku, sids: card ? Array.from(new Set(thumbSkus(card))) : null };
    });
  }

  // 可点的“下一页”；最后一页时它是不可点的 span（如 span.jPageDisable）
  function nextLink(root) {
    const pager = root && root.querySelector('.jPage');
    if (!pager) return null;
    return qsa('a', pager).find((a) => /下一页/.test(a.textContent) && !/disable/i.test(a.className)) || null;
  }

  function pagerMax(root) {
    const pager = root && root.querySelector('.jPage');
    const nums = pager ? qsa('a, span, em, b', pager).map((x) => x.textContent.trim()).filter((t) => /^\d+$/.test(t)).map(Number) : [];
    return nums.length ? Math.max(...nums) : null;
  }

  function snapshot(index) {
    const modules = listModules();
    const root = modules[index];
    return {
      moduleCount: modules.length,
      root,
      skus: root ? skusIn(root) : [],
      totalText: root ? (text(root).match(TOTAL_RE) || [''])[0] : '',
    };
  }

  const isRealHref = (href) => Boolean(href) && href !== '#' && !/^javascript:/i.test(href);

  async function clickAndWait(link, index, timeoutMs) {
    const before = snapshot(index).skus.join(',');
    link.click();
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      await sleep(POLL_MS);
      const cur = snapshot(index).skus;
      if (cur.length && cur.join(',') !== before) return true;
    }
    return false;
  }

  /**
   * 等第 module 个列表模块渲染稳定后返回它的商品：skus 为各卡片的主 SKU，spus 另带每张卡片的规格缩略图
   * @param {{module?: number, timeoutMs?: number}} [opts]
   */
  NS.extractShopPage = async function extractShopPage({ module = 0, timeoutMs = WAIT_MS } = {}) {
    const type = pageType();
    if (type !== 'shop') return { pageType: type, moduleCount: 0, skus: [], spus: [], totalText: '', hasNext: false, pagerMax: null };
    const start = Date.now();
    let lastKey = '';
    let stable = 0;
    let cur = snapshot(module);
    while (Date.now() - start < timeoutMs) {
      cur = snapshot(module);
      // 页面上还有模块在“加载中”时继续等，不当作“没有列表”
      const noList = cur.moduleCount === 0 && !loadingPending() && Date.now() - start >= EMPTY_WAIT_MS;
      const ready = cur.skus.length > 0 || ZERO_TOTAL_RE.test(cur.totalText) || noList;
      const key = `${cur.moduleCount}:${cur.skus.length}`;
      stable = ready && key === lastKey ? stable + 1 : 0;
      lastKey = key;
      if (stable >= STABLE_POLLS) break;
      await sleep(POLL_MS);
    }
    const stuck = cur.skus.length === 0 && !ZERO_TOTAL_RE.test(cur.totalText) && loadingPending();
    return {
      pageType: stuck ? 'loading_failed' : pageType(),
      moduleCount: cur.moduleCount,
      skus: cur.skus,
      spus: cur.root ? spusIn(cur.root, cur.skus) : [],
      totalText: cur.totalText,
      hasNext: Boolean(nextLink(cur.root)),
      pagerMax: pagerMax(cur.root),
    };
  };

  /**
   * 第 module 个列表模块翻到下一页：普通链接交给扩展按地址打开（action=navigate, url）；
   * 页内按钮直接点击并等待列表换成新商品
   * @returns {Promise<{pageType: string, action: 'end'|'navigate'|'clicked', url?: string, changed?: boolean}>}
   */
  NS.nextShopPage = async function nextShopPage({ module = 0, timeoutMs = WAIT_MS } = {}) {
    const type = pageType();
    const link = type === 'shop' ? nextLink(snapshot(module).root) : null;
    if (!link) return { pageType: type, action: 'end' };
    const href = (link.getAttribute('href') || '').trim();
    if (isRealHref(href)) return { pageType: type, action: 'navigate', url: link.href };
    const changed = await clickAndWait(link, module, timeoutMs);
    return { pageType: pageType(), action: 'clicked', changed };
  };

  /**
   * 第 module 个列表模块切换排序（如“上架时间”），用于补抓排序漂移漏掉的商品
   * @returns {Promise<{pageType: string, action: 'none'|'navigate'|'clicked', url?: string, changed?: boolean}>}
   */
  NS.sortShopModule = async function sortShopModule({ module = 0, label = '', timeoutMs = WAIT_MS } = {}) {
    const type = pageType();
    const root = type === 'shop' ? snapshot(module).root : null;
    const link = root && label ? qsa('a', root).find((a) => a.textContent.trim().startsWith(label)) : null;
    if (!link) return { pageType: type, action: 'none' };
    const href = (link.getAttribute('href') || '').trim();
    if (isRealHref(href)) return { pageType: type, action: 'navigate', url: link.href };
    const changed = await clickAndWait(link, module, timeoutMs);
    return { pageType: pageType(), action: 'clicked', changed };
  };

  // 店铺信息：appId 在隐藏字段里（有些店铺首页没有“全部商品”链接），链接作为备选
  NS.readShopInfo = function readShopInfo() {
    const val = (id) => {
      const el = document.getElementById(id);
      return el ? String(el.value || '').trim() : '';
    };
    const links = qsa('a[href*="view_search-"]').map((a) => a.href);
    const inHtml = document.documentElement.innerHTML.match(/view_search-\d+-\d+-\d+-\d+-\d+-\d+\.html/g) || [];
    return { pageType: pageType(), appId: val('pageInstance_appId'), venderId: val('vender_id'), shopId: val('shop_id'), links: links.concat(inHtml) };
  };
})();
