// 注入到京东万商商品页（MAIN world），在 b2b-item-extract.js 之前加载；纯函数，也可在 Node 中测试。
// 商品页是 Vue 应用，接口返回的 goodsData 里已经有全部商品信息（商品参数、图文详情也在里面，不用滚动页面）。
(() => {
  const NS = (globalThis.__JDMOVE__ = globalThis.__JDMOVE__ || {});

  const B2B_ITEM_PATH_RE = /^\/(?:goods|trade)\/goods-detail\/(\d{6,})\/?$/;
  const UPC_PARAM_RE = /UPC|69码/i;
  const DENIED_CODE = -10000;
  // 商家留空时后台填的不可见占位字符
  const FILLER_RE = /[\sㅤ]/g;

  const str = (v) => (v == null ? '' : String(v)).trim();

  /** @returns {string} 商品详情路径里的 SKU；其他页面返回空串 */
  NS.b2bSkuFromPath = (pathname) => (String(pathname || '').match(B2B_ITEM_PATH_RE) || [])[1] || '';

  /**
   * goodsData 当前的状态。无权限的商品（页面显示“暂无购买权限”）只有 SKU 没有标题；
   * 站内跳转时可能还留着上一个商品的数据
   * @returns {'pending'|'denied'|'ready'}
   */
  NS.b2bGoodsState = function b2bGoodsState(gd, skuId) {
    const pageSku = gd && gd.viewCommonDTO && str(gd.viewCommonDTO.skuId);
    if (pageSku && pageSku !== skuId) return 'pending';
    if (gd && gd.code === DENIED_CODE) return 'denied';
    if (!pageSku) return 'pending';
    return str(gd.viewTitleDTO && gd.viewTitleDTO.title) ? 'ready' : 'denied';
  };

  /**
   * 页面显示的主价格（采购价）。无购买权限时显示为 **
   * @returns {{price: string, label: string}}
   */
  NS.b2bPriceInfo = function b2bPriceInfo(gd) {
    const value = str(gd && gd.viewPriceDTO && gd.viewPriceDTO.mainPositionPrice && gd.viewPriceDTO.mainPositionPrice.value);
    return { price: /\d/.test(value) ? value : '', label: '万商采购价' };
  };

  /**
   * #zbViewWeChatMiniImages 的 value：详情图的切片列表（逗号分隔的 /sku/jfs/...）。
   * 和页面显示的宽度一致（750，PC 端背景长图只有 569 宽），单张高度也不超过发布要求，不用再切片
   * @param {string|null|undefined} value
   * @returns {string[]} jfs 路径
   */
  NS.b2bMiniImages = (value) => str(value).split(',').map(NS.jfsOf).filter(Boolean);

  function params(gd) {
    const spec = (gd.viewGraphicDetailDTO && gd.viewGraphicDetailDTO.specification) || {};
    const groups = [...(spec.specificationList || []), ...(spec.expandInfoList || [])];
    const attrs = [...groups.flatMap((g) => g.AttributeList || []), ...(spec.specificationDetailList || [])];
    return attrs
      .map((a) => [str(a.attributeName), str(a.attributes)])
      .filter(([name, value]) => name && value !== name && value.replace(FILLER_RE, ''));
  }

  // 规格：每个按钮的 skuList 表示包含该规格值的 SKU，逐维汇总得到每个 SKU 的规格组合
  function colorSize(gd) {
    const bySku = {};
    for (const dim of (gd.viewSelectedDTO && gd.viewSelectedDTO.colorSize) || []) {
      for (const btn of dim.buttons || []) {
        for (const sku of btn.skuList || []) {
          bySku[sku] = { ...(bySku[sku] || { skuId: sku }), [dim.title || '规格']: btn.text };
        }
      }
    }
    return Object.values(bySku);
  }

  function isSelf(gd) {
    const tag = ((gd.viewTitleDTO && gd.viewTitleDTO.productTag) || []).find((t) => t.tagProperty === 'isSelf');
    return Boolean(tag) && str(tag.tagText) === 'true';
  }

  /**
   * goodsData → 与 jd-item-extract.js 相同结构的原始数据（图文详情除外，见 b2b-item-extract.js）
   * @param {any} gd
   * @returns {object}
   */
  NS.b2bRawFromGoods = function b2bRawFromGoods(gd) {
    const title = str(gd.viewTitleDTO && gd.viewTitleDTO.title);
    const crumb = gd.viewBreadCrumbDTO || {};
    const brand = gd.viewBrandDTO || {};
    const common = gd.viewCommonDTO || {};
    const list = params(gd);
    const images = (gd.viewMasterMapDTO && gd.viewMasterMapDTO.wareImage) || [];
    const upc = list.find(([name]) => UPC_PARAM_RE.test(name));
    return {
      source: 'b2b',
      domTitle: title,
      crumbs: [crumb.category1Name, crumb.category2Name, crumb.category3Name].map(str).filter(Boolean),
      brandText: str(brand.brandName || common.brandName),
      params: list,
      priceText: NS.b2bPriceInfo(gd).price,
      wareInfo: { shelf_life: '', upc_code: upc ? upc[1] : '' },
      isSelf: isSelf(gd),
      packList: str(gd.viewGraphicDetailDTO && gd.viewGraphicDetailDTO.wareQD),
      pageConfig: {
        skuid: str(common.skuId),
        name: title,
        imageList: images.map((img) => NS.jfsOf(img.big)).filter(Boolean),
        brand: brand.brandId || null,
        colorSize: colorSize(gd),
        cat: [crumb.category1Id, crumb.category2Id, crumb.category3Id].map(str).filter(Boolean),
      },
    };
  };
})();
