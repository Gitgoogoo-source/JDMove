// 注入到 item.jd.com 页面（MAIN world）执行，返回原始商品数据。
// 页面结构经常改版，因此每项数据都有多套兜底策略；归一化在扩展侧完成。
(() => {
  const NS = (window.__JDMOVE__ = window.__JDMOVE__ || {});
  if (NS.extractItem && NS.extractPrice) return;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const text = (el) => (el ? (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim() : '');
  const qsa = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const first = (sels) => {
    for (const s of sels) {
      const el = document.querySelector(s);
      if (el && text(el)) return el;
    }
    return null;
  };

  function pageType() {
    const href = location.href;
    if (/bizsafe-intercept/.test(href)) return 'merchant_block';
    if (/pc-frequent|risk_handler|safe\.jd\.com/.test(href) || /频控|访问频繁/.test(document.title)) return 'throttle';
    if (/passport\.jd\.com/.test(href)) return 'login';
    if (/验证/.test(document.title) && !document.querySelector('.sku-name, #spec-list')) return 'throttle';
    if (/^item(\.m)?\.jd\.com$/.test(location.hostname)) return 'item';
    return 'unknown';
  }

  function pageConfigProduct() {
    const p = window.pageConfig && window.pageConfig.product;
    if (!p || !p.skuid) return null;
    const pick = ['skuid', 'name', 'src', 'imageList', 'cat', 'brand', 'colorSize', 'desc', 'venderId', 'shopId', 'isSelf'];
    const out = {};
    for (const k of pick) if (p[k] !== undefined) out[k] = JSON.parse(JSON.stringify(p[k]));
    return out;
  }

  // 新版商品页（React）：在组件状态中寻找 wareBusiness 接口数据
  function reactBusiness() {
    const root = document.getElementById('root');
    const key = root && Object.keys(root).find((k) => k.startsWith('__reactContainer'));
    if (!key) return null;
    const stack = [root[key]];
    let guard = 0;
    while (stack.length && guard < 50000) {
      guard += 1;
      const f = stack.pop();
      if (!f) continue;
      let st = f.memoizedState;
      for (let i = 0; st && i < 40; i += 1, st = st.next) {
        const v = st.memoizedState && st.memoizedState.current;
        if (v && typeof v === 'object' && v.skuHeadVO && v.colorSizeVO) return v;
      }
      if (f.child) stack.push(f.child);
      if (f.sibling) stack.push(f.sibling);
    }
    return null;
  }

  const jfsOf = (u) => (String(u || '').match(/(jfs\/[^?#!]+?)(?:\.(?:avif|webp|dpg))*(?:$|[?#!])/) || [])[1] || '';

  function fromBusiness(b) {
    const images = [];
    const mainArea = b.mainImageVO && b.mainImageVO.mainImageArea;
    if (mainArea && mainArea.imageUrl) images.push(jfsOf(mainArea.imageUrl));
    for (const c of (b.mainImageVO && b.mainImageVO.carouselArea) || []) images.push(jfsOf(c.imageUrl));
    // 规格：每个按钮的 skuList 表示包含该规格值的 SKU，逐维汇总得到每个 SKU 的规格组合
    const bySku = {};
    for (const dim of (b.colorSizeVO && b.colorSizeVO.colorSizeList) || []) {
      for (const btn of dim.buttons || []) {
        for (const sku of btn.skuList || [btn.skuId]) {
          if (!sku) continue;
          bySku[sku] = Object.assign(bySku[sku] || { skuId: sku }, { [dim.title || '规格']: btn.text });
        }
      }
    }
    const attrs = ((b.productAttributeVO && b.productAttributeVO.coreAttributes) || []).concat(
      (b.productAttributeVO && b.productAttributeVO.attributes) || [],
    );
    const pageCfg = b.pageConfigVO || {};
    const read = b.wareInfoReadMap || {};
    return {
      title: (b.skuHeadVO && b.skuHeadVO.skuTitle) || '',
      crumbs: ((b.crumbInfoVO && b.crumbInfoVO.crumbs) || []).map((c) => c.text).filter(Boolean),
      params: attrs.map((a) => [a.labelName, a.labelValue]),
      // 与页面显示一致：取主价格（京东价/补贴价等），不取页面不显示的原价 op
      priceText: NS.pickBusinessPrice(b),
      brandText: read.cn_brand || '',
      // 商品主数据里的结构化字段：保质期（参数列表没有时兜底）、商品条形码（页面上不显示）
      wareInfo: { shelf_life: read.shelf_life || '', upc_code: read.upc_code || '' },
      shopName: (b.itemShopInfo && b.itemShopInfo.shopName) || '',
      pageConfig: {
        skuid: (b.price && b.price.id) || skuIdFromUrl(),
        name: (b.skuHeadVO && b.skuHeadVO.skuTitle) || '',
        imageList: images.filter(Boolean),
        brand: pageCfg.brand || null,
        colorSize: Object.values(bySku),
        cat: (read.category_id && [read.category_id]) || [],
      },
    };
  }

  function skuIdFromUrl() {
    const m = location.pathname.match(/(\d{6,})\.html/);
    return m ? m[1] : '';
  }

  function crumbs() {
    const sels = ['#crumb-wrap .crumb .item a', '.crumb .item a', '[class*="crumb"] a', '[class*="breadcrumb"] a'];
    for (const s of sels) {
      const list = qsa(s).map(text).filter((t) => t && t.length < 30);
      if (list.length >= 2) return list;
    }
    return [];
  }

  function brandText() {
    const el = first(['#parameter-brand li a', '#parameter-brand li', '.p-parameter-brand a', '[class*="brand"] a[href*="brand"]']);
    return text(el).replace(/^品牌[：:]\s*/, '');
  }

  // 参数：li "名称：值"、dl dt/dd、table th/td 多种结构
  function params() {
    const pairs = [];
    const roots = qsa(
      '#detail, .p-parameter, .parameter2, .Ptable, #parameter2, [class*="param"], [class*="Param"], [class*="spec-list"], [class*="specification"]',
    );
    const seenNodes = new Set();
    for (const root of roots) {
      for (const li of qsa('li', root)) {
        if (seenNodes.has(li)) continue;
        seenNodes.add(li);
        const t = text(li);
        const m = t.match(/^([^：:]{1,20})[：:]\s*(.{1,200})$/);
        if (m) pairs.push([m[1], m[2]]);
      }
      for (const dl of qsa('dl', root)) {
        const dts = qsa('dt', dl);
        const dds = qsa('dd', dl).filter((dd) => !dd.classList.contains('Ptable-tips'));
        dts.forEach((dt, i) => dds[i] && pairs.push([text(dt), text(dds[i])]));
      }
      for (const tr of qsa('tr', root)) {
        const cells = qsa('th, td', tr);
        if (cells.length === 2) pairs.push([text(cells[0]), text(cells[1])]);
      }
    }
    return pairs.filter(([k, v]) => k && v && k.length <= 20);
  }

  function mainImages() {
    const sels = ['#spec-list img', '.spec-list img', '.lh li img', '[class*="thumb"] img', '[class*="preview"] img', '#spec-img', '[class*="main-img"] img'];
    const urls = [];
    for (const s of sels) {
      for (const img of qsa(s)) {
        const u = img.getAttribute('data-url') || img.getAttribute('data-origin') || img.getAttribute('data-src') || img.currentSrc || img.src;
        if (u && /360buyimg\.com/.test(u)) urls.push(u);
      }
      if (urls.length >= 3) break;
    }
    return urls;
  }

  function priceText() {
    const sels = [
      '.p-price .price',
      '.summary-price .price',
      '[class*="J-p-"]',
      '[class*="price"] [class*="num"]',
      '[class*="finalPrice"]',
      '[class*="price-now"]',
      '[class*="price"]',
    ];
    for (const s of sels) {
      for (const el of qsa(s)) {
        const t = text(el);
        if (/\d/.test(t) && t.length < 30 && !/plus|PLUS|会员|原价|划线/.test(t + (el.className || ''))) return t;
      }
    }
    return '';
  }

  function saleDims() {
    const dims = [];
    for (const box of qsa('#choose-attrs .p-choose, [class*="choose-attr"], [class*="sku-attr"] > div')) {
      const name = (box.getAttribute('data-type') || text(box.querySelector('.dt, [class*="label"], [class*="title"]'))).replace(/[：:]/g, '').trim();
      const values = qsa('.item, [class*="item"], li', box)
        .map((el) => ({
          text: el.getAttribute('data-value') || text(el.querySelector('i, span')) || text(el),
          skuId: el.getAttribute('data-sku') || '',
          selected: el.classList.contains('selected') || el.getAttribute('aria-selected') === 'true',
        }))
        .filter((v) => v.text && v.text.length <= 40);
      if (name && values.length) dims.push({ name, values });
    }
    return dims;
  }

  // 详情：<img> 与 ssd-module 背景图（CSS 中按模块 class 定义，如 .ssd-module-wrap .M1786...）按 DOM 顺序收集
  function detailFromRoot(root) {
    const urls = [];
    const bgByClass = {};
    const styleText = qsa('style', root).map((s) => s.textContent || '').join('\n');
    for (const m of styleText.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
      const url = (m[2].match(/background(?:-image)?\s*:[^;]*?url\(\s*['"]?([^'")]+)['"]?\s*\)/) || [])[1];
      const cls = (m[1].trim().match(/\.([\w-]+)\s*$/) || [])[1];
      if (url && cls && !bgByClass[cls]) bgByClass[cls] = url;
    }
    for (const el of root.querySelectorAll('img, [class*="ssd-module"], [style*="background"]')) {
      if (el.tagName === 'IMG') {
        const u = el.getAttribute('data-lazyload') || el.getAttribute('data-src') || el.getAttribute('data-original') || el.getAttribute('src');
        if (u) urls.push(u);
        continue;
      }
      const cls = Array.from(el.classList).find((c) => bgByClass[c]);
      if (cls) urls.push(bgByClass[cls]);
      const inline = (el.getAttribute('style') || '').match(/url\(\s*['"]?([^'")]+)['"]?\s*\)/);
      if (inline) urls.push(inline[1]);
    }
    return urls.filter((u) => /360buyimg\.com|^\/\/|^https?:/.test(u));
  }

  function detailRoot() {
    const sels = ['#detail-main', '#J-detail-content', '.detail-content', '#detail .detail-content', '[class*="detail-content"]', '[class*="goods-detail"]', '[class*="graphic"]'];
    for (const s of sels) {
      const el = document.querySelector(s);
      if (el && el.querySelector('img, style, [class*="ssd-module"]')) return el;
    }
    return null;
  }

  async function fetchDescription(pc) {
    if (!pc || !pc.desc) return [];
    const url = pc.desc.startsWith('//') ? `https:${pc.desc}` : pc.desc;
    try {
      const res = await fetch(url, { credentials: 'include' });
      const body = await res.text();
      const jsonText = body.replace(/^[^{]*?\(/, '').replace(/\)\s*;?\s*$/, '');
      const data = JSON.parse(body.trim().startsWith('{') ? body : jsonText);
      const html = data.content || (data.data && data.data.content) || '';
      if (!html) return [];
      const doc = new DOMParser().parseFromString(`<div id="x">${html}</div>`, 'text/html');
      return detailFromRoot(doc.getElementById('x'));
    } catch {
      return [];
    }
  }

  async function scrollThrough() {
    const total = document.documentElement.scrollHeight;
    const step = Math.max(400, Math.floor(window.innerHeight * 0.8));
    for (let y = 0; y < total; y += step) {
      window.scrollTo(0, y);
      await sleep(250 + Math.random() * 250);
    }
    await sleep(800);
    window.scrollTo(0, 0);
  }

  async function waitForBusiness(timeout = 6000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const b = reactBusiness();
      if (b) return b;
      if (window.pageConfig && window.pageConfig.product && window.pageConfig.product.skuid) return null;
      await sleep(300);
    }
    return null;
  }

  async function waitForPrice(timeout = 5000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const t = priceText();
      if (/\d/.test(t)) return t;
      await sleep(300);
    }
    return '';
  }

  NS.extractItem = async function extractItem(opts = {}) {
    const type = pageType();
    if (type !== 'item') return { pageType: type, url: location.href };
    const biz = await waitForBusiness();
    const fromBiz = biz ? fromBusiness(biz) : null;
    const pc = (fromBiz && fromBiz.pageConfig) || pageConfigProduct();
    const price = fromBiz && fromBiz.priceText ? fromBiz.priceText : await waitForPrice();
    if (opts.scrollDetail !== false) await scrollThrough();
    const root = detailRoot();
    let detailImages = root ? detailFromRoot(root) : [];
    if (detailImages.length === 0) detailImages = await fetchDescription(pc);
    const shopName = (fromBiz && fromBiz.shopName) || text(first(['.contact .name', '.J-hove-wrap .name', '[class*="shop-name"]', '[class*="shopName"]']));
    const self = document.querySelector('.u-jd, [class*="self-operated"], [class*="ziying"]');
    return {
      pageType: 'item',
      source: fromBiz ? 'react' : pc ? 'pageConfig' : 'dom',
      url: location.href.split('#')[0],
      skuId: (pc && String(pc.skuid)) || skuIdFromUrl(),
      pageConfig: pc,
      domTitle: (fromBiz && fromBiz.title) || text(first(['.sku-name', '.itemInfo-wrap .sku-name', '[class*="sku-title"]', '[class*="goods-title"]', 'h1'])),
      docTitle: document.title,
      crumbs: fromBiz && fromBiz.crumbs.length ? fromBiz.crumbs : crumbs(),
      brandText: (fromBiz && fromBiz.brandText) || brandText(),
      params: (fromBiz ? fromBiz.params : []).concat(params()),
      wareInfo: fromBiz ? fromBiz.wareInfo : null,
      mainImages: mainImages(),
      priceText: price || priceText(),
      saleDims: saleDims(),
      detailImages,
      isSelf: self || /自营/.test(shopName) ? true : null,
    };
  };

  // 只读价格（检查已发布商品的京东今日价）：不滚动页面、不取图片，比完整采集快得多
  NS.extractPrice = async function extractPrice() {
    const type = pageType();
    if (type !== 'item') return { pageType: type, url: location.href };
    const biz = await waitForBusiness();
    const info = biz ? NS.pickBusinessPriceInfo(biz) : { price: await waitForPrice(), label: '' };
    return {
      pageType: 'item',
      skuId: (biz && biz.price && String(biz.price.id || '')) || skuIdFromUrl(),
      priceText: info.price,
      label: info.label,
    };
  };

  // 从当前列表页（店铺页/搜索页）提取商品 SKU
  NS.extractListSkus = function extractListSkus() {
    const ids = new Set();
    for (const a of qsa('a[href*="item.jd.com/"]')) {
      const m = a.href.match(/item\.jd\.com\/(\d{6,})\.html/);
      if (m) ids.add(m[1]);
    }
    for (const el of qsa('[data-sku]')) {
      const v = el.getAttribute('data-sku');
      if (/^\d{6,}$/.test(v)) ids.add(v);
    }
    return Array.from(ids);
  };
})();
