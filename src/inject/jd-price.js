// 注入到 item.jd.com 页面（MAIN world），在 jd-item-extract.js 之前加载；纯函数，也可在 Node 中测试。
(() => {
  const NS = (globalThis.__JDMOVE__ = globalThis.__JDMOVE__ || {});

  /**
   * 取页面实际显示的主价格（京东价/补贴价/秒杀价等）。
   * priceItemList 是页面价格区的渲染数据，hitLine=true 为划线价；
   * price.p 为当前售价，price.op 为原价（页面不显示，仅最后兜底）。
   * @param {any} b 新版商品页的 wareBusiness 数据
   * @returns {string}
   */
  NS.pickBusinessPrice = function pickBusinessPrice(b) {
    const items = (b && b.warePriceGatherVO && b.warePriceGatherVO.priceItemList) || [];
    const shown = items.find((p) => p && !p.hitLine && /\d/.test(p.price || ''));
    const price = (b && b.price) || {};
    return (shown && shown.price) || price.p || price.op || '';
  };
})();
