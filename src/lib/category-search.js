// 京麦类目选择页：落地页判断 + 任务面板中手动搜索目标店铺类目
import { parseCategoryText } from '../shared/category-pick.js';
import { classifyPageUrl } from '../shared/url-utils.js';
import { callBackend, openWorkTab, closeTab, sleep } from './chrome-env.js';

export const CATEGORY_PAGE = 'https://wares-jdm.jd.com/ware/categorySelectNew?source=1';
export const CATEGORY_REDIRECT_MSG =
  '京麦的类目选择页直接跳到了商品发布页，无法自动搜索类目。请在「编辑」中填写类目ID路径，或在设置的「类目映射」中配置';
const LANDING_SETTLE_MS = 1200;

/** 页面可能在加载后再用脚本跳转：稍等后按标签页的实际地址判断落在哪一页 */
export async function landedPageKind(tabId) {
  await sleep(LANDING_SETTLE_MS);
  const tab = await chrome.tabs.get(tabId);
  return classifyPageUrl(tab.url);
}

/**
 * @returns {Promise<Array<{text: string, path: Array<{name: string, id: number}>}>>}
 */
export async function searchShopCategories(keyword) {
  const tab = await openWorkTab(CATEGORY_PAGE);
  try {
    const kind = await landedPageKind(tab.id);
    if (kind === 'login') throw new Error('商家后台需要重新登录');
    if (kind !== 'category') throw new Error(CATEGORY_REDIRECT_MSG);
    const res = await callBackend(tab.id, 'searchCategory', keyword);
    if (!res?.ok) throw new Error(res?.error || '类目搜索失败（请确认商家后台已登录）');
    return res.results.map((text) => ({ text, path: parseCategoryText(text) })).filter((r) => r.path.length);
  } finally {
    await closeTab(tab.id);
  }
}
