// 品牌名（纯函数）：本地文件夹按品牌归类、上架总表的“品牌”列都用这里的品牌

export const UNKNOWN_BRAND = '未识别品牌';

/** 发布时实际使用的品牌：编辑里改过的品牌优先，其次是采集到的品牌 */
export function itemBrand(item) {
  const name = item?.edits?.brandName?.trim() || item?.product?.brand?.name?.trim();
  return name || UNKNOWN_BRAND;
}

// 全角/半角括号、大小写、空格不同的同一品牌归到一起，如“华为（HUAWEI）”和“华为(huawei)”
export const brandKey = (name) => name.normalize('NFKC').toLowerCase().replace(/\s+/g, '');
