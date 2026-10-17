// 任务面板中手动搜索目标店铺类目
import { parseCategoryText } from '../shared/category-pick.js';
import { callBackend, openWorkTab, closeTab, sleep } from './chrome-env.js';

const CATEGORY_PAGE = 'https://wares-jdm.jd.com/ware/categorySelectNew?source=1';

/**
 * @returns {Promise<Array<{text: string, path: Array<{name: string, id: number}>}>>}
 */
export async function searchShopCategories(keyword) {
  const tab = await openWorkTab(CATEGORY_PAGE);
  try {
    await sleep(1200);
    const res = await callBackend(tab.id, 'searchCategory', keyword);
    if (!res?.ok) throw new Error(res?.error || '类目搜索失败（请确认商家后台已登录）');
    return res.results.map((text) => ({ text, path: parseCategoryText(text) })).filter((r) => r.path.length);
  } finally {
    await closeTab(tab.id);
  }
}
