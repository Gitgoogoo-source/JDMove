// 已发布归档：把发布成功的商品按品牌归到同一个“文件夹”（纯函数）

export const UNKNOWN_BRAND = '未识别品牌';

/** 发布时实际使用的品牌：编辑里改过的品牌优先，其次是采集到的品牌 */
export function itemBrand(item) {
  const name = item?.edits?.brandName?.trim() || item?.product?.brand?.name?.trim();
  return name || UNKNOWN_BRAND;
}

/**
 * 发布成功过的商品从任务列表移到“已发布”页。publishedAt 让归档后“重新发布”的商品
 * 在发布中/失败时也继续留在已发布页；旧数据没有 publishedAt，按状态判断
 */
export const isArchived = (item) => Boolean(item) && (item.status === 'published' || item.publishedAt > 0);

/** 任务列表只显示还没发布成功的商品 */
export const taskItems = (items) => items.filter((i) => !isArchived(i));

// 全角/半角括号、大小写、空格不同的同一品牌归到一起，如“华为（HUAWEI）”和“华为(huawei)”
export const brandKey = (name) => name.normalize('NFKC').toLowerCase().replace(/\s+/g, '');

/**
 * @param {object[]} items
 * @returns {{key: string, brand: string, items: object[]}[]} 商品多的品牌在前；文件夹内最近更新的在前
 */
export function groupPublishedByBrand(items) {
  const groups = new Map();
  for (const item of items) {
    if (!isArchived(item)) continue;
    const brand = itemBrand(item);
    const key = brandKey(brand);
    const group = groups.get(key) ?? { key, brand, items: [] };
    groups.set(key, { ...group, items: [...group.items, item] });
  }
  const unknownKey = brandKey(UNKNOWN_BRAND);
  return [...groups.values()]
    .map((g) => ({ ...g, items: [...g.items].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0)) }))
    .sort(
      (a, b) =>
        (a.key === unknownKey) - (b.key === unknownKey) ||
        b.items.length - a.items.length ||
        a.brand.localeCompare(b.brand, 'zh-CN'),
    );
}

/** 按品牌名搜索文件夹 */
export function filterFolders(folders, query) {
  const q = brandKey(String(query ?? ''));
  return q ? folders.filter((f) => f.key.includes(q)) : folders;
}
