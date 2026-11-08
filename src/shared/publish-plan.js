// 发布用的图片计划与商品详情 HTML（纯函数）
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
