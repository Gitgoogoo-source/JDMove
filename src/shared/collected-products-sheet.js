import { buildItemUrl } from './url-utils.js';

const HEADER = ['商品名称', '京东自营价格', '一二三级类目', 'sku编码', '京东自营链接'];

/**
 * @param {import('./store.js').Item[]} items 已采集的任务
 * @returns {import('./xlsx-write.js').SheetSpec}
 */
export function collectedProductsSheet(items) {
  const rows = items.map(({ product, edits, skuId }) => {
    const price = Number(product.price);
    const sku = String(skuId ?? '');
    return [
      edits?.title || product.title || '',
      Number.isFinite(price) && price > 0 ? price : null,
      product.crumbs?.slice(0, 3).join(' > ') ?? '',
      sku,
      sku ? buildItemUrl(sku) : '',
    ];
  });
  return { name: '采集数据', rows: [HEADER, ...rows], widths: [76, 18, 48, 24, 50], textColumns: [3] };
}
