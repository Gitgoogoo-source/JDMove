// 组装一次发布所需的完整填写计划（纯函数）
import { cleanTitle } from './title.js';
import { computePrice } from './pricing.js';
import { buildPropPlan, convertInputValue, findSourceValue } from './attr-mapping.js';
import { buildSalePlan } from './sale-plan.js';
import { parseAttrDefaults } from './settings.js';
import { toOriginalImageUrl } from './url-utils.js';

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
 * SKU属性抽屉里常见字段（按标签名匹配）
 */
export function skuAttrValueMap(product, sourcePrice) {
  const map = {};
  for (const p of product?.params ?? []) map[p.name] = p.value;
  if (sourcePrice > 0) {
    map['建议零售价'] = String(sourcePrice);
    map['市场价'] = String(sourcePrice);
  }
  if (product?.upc) {
    map['最小可售单位UPC'] = product.upc;
    map['商品条形码'] = product.upc;
    map['UPC'] = product.upc;
  }
  return map;
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

/**
 * @param {{product: object, edits?: object, settings: object, schema: {attrs: object[], saleDimNames: string[]}}} input
 */
export function buildPublishPlan({ product, edits = {}, settings, schema }) {
  const blockers = [];
  const defaults = { ...parseAttrDefaults(settings.attrDefaultsText), ...(edits.attrOverrides ?? {}) };
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

  const brand = edits.brandName ? { id: null, name: edits.brandName } : { id: product.brand?.id ?? null, name: product.brand?.name ?? '' };
  if (!brand.name && !brand.id) blockers.push('缺少品牌');

  const weight = findSourceValue('毛重', source);
  const { mainImageUrls, detailImageUrls } = publishImagePlan({ product, edits, settings });
  if (!mainImageUrls.length) blockers.push('缺少主图');

  return {
    title,
    brand,
    props,
    sale,
    mainImageUrls,
    detailImageUrls,
    weightKg: weight ? convertInputValue(weight.value, 'kg') || null : null,
    packList: settings.packList || '',
    skuAttrValues: skuAttrValueMap(source, sourcePrice),
    warnings: [...guessWarnings, ...sale.warnings],
    blockers,
  };
}
