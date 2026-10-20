// 组装一次发布所需的完整填写计划（纯函数）
import { cleanTitle } from './title.js';
import { computePrice } from './pricing.js';
import { buildPropPlan, convertInputValue, findSourceValue } from './attr-mapping.js';
import { buildSalePlan } from './sale-plan.js';
import { parseAttrDefaults } from './settings.js';
import { toOriginalImageUrl } from './url-utils.js';
import { UPC_LABEL, hasUpc, normalizeUpc, productUpc, skuAttrValueMap } from './sku-attrs.js';

const escapeAttr = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * 代码编辑模式下的详情 HTML
 * @param {string[]} urls
 */
export function descriptionHtml(urls) {
  if (!urls?.length) return '';
  const imgs = urls
    .map((u) => `<p style="margin:0;padding:0;"><img src="${escapeAttr(u)}" style="display:block;width:100%;" /></p>`)
    .join('');
  return `<div style="width:750px;margin:0 auto;">${imgs}</div>`;
}

/**
 * 要上传的主图 / 详情图地址。不依赖发布页表单结构，打开发布页之前就能算出来，用于提前处理图片
 * @param {{product: object, edits?: object, settings: object}} input
 * @returns {{mainImageUrls: string[], detailImageUrls: string[]}}
 */
export function publishImagePlan({ product, edits = {}, settings }) {
  // 早先采集的数据里存的是带水印的 /n0/ 地址，发布前统一换成无水印原图
  const mainImageUrls = (edits.mainImages ?? product.mainImages ?? [])
    .slice(0, settings.publish.maxMainImages)
    .map(toOriginalImageUrl);
  return { mainImageUrls, detailImageUrls: (product.detailImages ?? []).slice(0, settings.publish.maxDetailImages) };
}

// 京麦部分类目的 SKU属性抽屉要求必填 UPC；缺了抽屉点不了“确定”，建议零售价也跟着保存不上
function upcWarnings(present, enabledRows, defaultUpc) {
  if (!present) {
    return [`未填写${UPC_LABEL}（商品条形码）：部分类目必填，缺少时 SKU属性面板无法保存、建议零售价也写不进去；源商品页没有条形码时请在「编辑 → UPC」中填写，或在设置里填写「默认 UPC」；之前采集的商品请重新采集`];
  }
  const usedDefault = defaultUpc ? [`源商品没有条形码，${UPC_LABEL}使用设置里的默认 UPC ${defaultUpc}`] : [];
  const shared = enabledRows > 1 ? [`${enabledRows} 个规格将共用同一个 UPC，京东可能要求每个规格使用不同的条形码，请核对`] : [];
  return [...usedDefault, ...shared];
}

/**
 * @param {{product: object, edits?: object, settings: object, schema: {attrs: object[], saleDimNames: string[]}}} input
 */
export function buildPublishPlan({ product, edits = {}, settings, schema }) {
  const blockers = [];
  const attrDefaults = parseAttrDefaults(settings.attrDefaultsText);
  const defaults = { ...attrDefaults, ...(edits.attrOverrides ?? {}) };
  // 用户覆盖的属性值优先于源数据：把它们放到参数列表最前面
  const overrideParams = Object.entries(edits.attrOverrides ?? {}).map(([name, value]) => ({ name, value }));
  const source = { ...product, params: [...overrideParams, ...(product.params ?? [])] };

  const title = edits.title?.trim() || cleanTitle(product.title, settings.title);
  if (!title) blockers.push('缺少标题');

  const sourcePrice = product.price;
  const price = Number(edits.price) > 0 ? Number(edits.price) : computePrice(sourcePrice, settings.price);
  if (!(price > 0)) blockers.push('缺少价格（源页面未采到价格，请在编辑中填写）');
  const stock = Number.isFinite(Number(edits.stock)) && edits.stock !== '' && edits.stock != null ? Number(edits.stock) : settings.stock;

  const props = buildPropPlan(schema.attrs ?? [], source, { defaults });
  if (props.missingRequired.length) {
    blockers.push(
      `必填属性未匹配：${props.missingRequired.join('、')}（源商品页没有这些信息，请在「编辑 → 属性覆盖」或设置的「属性默认值」中填写）`,
    );
  }
  const guessWarnings = props.report
    .filter((r) => r.status === 'guessed')
    .map((r) => `属性按推断填写，请核对：${r.title}=${r.label ?? r.raw}（依据：${r.source}）`);

  const variantPrices = Object.fromEntries(
    Object.entries(product.variantPrices ?? {}).map(([sku, p]) => [sku, computePrice(p, settings.price)]),
  );
  const sale = buildSalePlan(schema.saleDimNames ?? [], source, {
    defaultPrice: price,
    prices: Number(edits.price) > 0 ? {} : variantPrices,
    stock,
  });

  const skuAttrValues = skuAttrValueMap({
    params: product.params ?? [],
    defaults: attrDefaults,
    overrides: edits.attrOverrides ?? {},
    sourcePrice,
    // productUpc：修复前采集的商品可能把 SKU 编号存成了 upc，这里同样排除
    upc: edits.upc || productUpc(product),
    fallbackUpc: settings.publish.defaultUpc,
  });
  const ownUpc = skuAttrValueMap({ overrides: edits.attrOverrides ?? {}, upc: edits.upc || productUpc(product) });
  const defaultUsed = hasUpc(ownUpc) ? '' : normalizeUpc(settings.publish.defaultUpc);
  const skuAttrWarnings = upcWarnings(hasUpc(skuAttrValues), sale.rows.filter((r) => r.enabled).length, defaultUsed);

  const brand = edits.brandName ? { id: null, name: edits.brandName } : { id: product.brand?.id ?? null, name: product.brand?.name ?? '' };
  if (!brand.name && !brand.id) blockers.push('缺少品牌');

  const weight = findSourceValue('毛重', source);
  const { mainImageUrls, detailImageUrls } = publishImagePlan({ product, edits, settings });
  if (!mainImageUrls.length) blockers.push('缺少主图');
  // 按源商品判断，不按截取后的列表：详情图数量设为 0 是有意不传详情
  if (!product.detailImages?.length) blockers.push('缺少详情图（采集时没有拿到详情图，请重新采集后再发布）');

  return {
    title,
    price,
    brand,
    props,
    sale,
    mainImageUrls,
    detailImageUrls,
    weightKg: weight ? convertInputValue(weight.value, 'kg') || null : null,
    packList: settings.packList || '',
    skuAttrValues,
    warnings: [...guessWarnings, ...sale.warnings, ...skuAttrWarnings],
    blockers,
  };
}
