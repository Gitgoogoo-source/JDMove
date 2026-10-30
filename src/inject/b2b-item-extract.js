// 注入到京东万商（b2b.jd.com）商品页（MAIN world）执行，返回与 jd-item-extract.js 相同结构的原始数据。
// 商品数据取自商品详情组件的 goodsData；页面 DOM 是虚拟滚动和懒渲染的，不作为数据来源。
(() => {
  const NS = (window.__JDMOVE__ = window.__JDMOVE__ || {});
  if (NS.extractItem && NS.extractPrice) return;

  const GOODS_WAIT_MS = 12000;
  const GOODS_POLL_MS = 300;
  const MAX_COMPONENTS = 20000;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function pageType() {
    const { hostname, pathname } = location;
    if (/passport\.jd\.com/.test(hostname) || pathname.startsWith('/account/login')) return 'b2b_login';
    // document.title 是商品标题，不能用来判断验证页
    if (/risk_handler|safe\.jd\.com/.test(hostname + pathname)) return 'throttle';
    return NS.b2bSkuFromPath(pathname) ? 'item' : 'unknown';
  }

  // 在 Vue 组件树里找持有 goodsData 的组件
  function goodsData() {
    const root = document.getElementById('app');
    const start = root && root._vnode && root._vnode.component;
    if (!start) return null;
    const seen = new Set();
    const stack = [start.subTree];
    while (stack.length && seen.size < MAX_COMPONENTS) {
      const v = stack.pop();
      if (!v || typeof v !== 'object' || seen.has(v)) continue;
      seen.add(v);
      const c = v.component;
      if (c && c.setupState && 'goodsData' in c.setupState) return c.setupState.goodsData;
      if (c) stack.push(c.subTree);
      if (v.suspense) stack.push(v.suspense.activeBranch);
      if (Array.isArray(v.children)) stack.push(...v.children);
    }
    return null;
  }

  // 页面跳转和接口都是异步的：等到拿到当前 SKU 的数据，或确定无权限/不是商品页
  async function waitForGoods(timeout = GOODS_WAIT_MS) {
    const end = Date.now() + timeout;
    for (;;) {
      const type = pageType();
      if (type !== 'item') return { type };
      const gd = goodsData();
      const skuId = NS.b2bSkuFromPath(location.pathname);
      const state = NS.b2bGoodsState(gd, skuId);
      if (state === 'ready') return { type, gd, skuId };
      if (state === 'denied') return { type: 'b2b_denied' };
      if (Date.now() >= end) return { type: 'b2b_no_data' };
      await sleep(GOODS_POLL_MS);
    }
  }

  // 图文详情是一段 HTML：用 DOMParser 解析，不执行其中的脚本，也不依赖页面把它渲染出来
  async function detailOf(gd) {
    const graphic = gd.viewGraphicDetailDTO;
    if (!graphic) return { images: [], state: NS.DETAIL_STATE.notLoaded };
    const html = `${graphic.cssStyle || ''}${graphic.wareTextIntroduction || ''}`;
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const mini = doc.getElementById('zbViewWeChatMiniImages');
    const slices = NS.b2bMiniImages(mini && mini.getAttribute('value'));
    const images = slices.length ? slices : NS.detailFromRoot(doc, await NS.fetchExternalCss(doc));
    const state = NS.classifyDetail({
      imageCount: images.length,
      moduleCount: doc.querySelectorAll('.ssd-module').length,
      hasSection: true,
      skeleton: false,
      sectionText: '',
    });
    return { images, state };
  }

  NS.extractItem = async function extractItem() {
    const { type, gd, skuId } = await waitForGoods();
    if (type !== 'item') return { pageType: type, url: location.href };
    const detail = await detailOf(gd);
    return {
      ...NS.b2bRawFromGoods(gd),
      pageType: 'item',
      url: location.href.split('#')[0],
      skuId,
      docTitle: document.title,
      detailImages: detail.images,
      detailState: detail.state,
    };
  };

  // 只读价格（检查已发布商品的价格）：goodsData 里直接有，不用取图
  NS.extractPrice = async function extractPrice() {
    const { type, gd, skuId } = await waitForGoods();
    if (type !== 'item') return { pageType: type, url: location.href };
    const { price, label } = NS.b2bPriceInfo(gd);
    return { pageType: 'item', skuId, priceText: price, label };
  };
})();
