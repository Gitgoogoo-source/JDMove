// VC 发布页提示“您选择的类目不是末级类目”时：到类目选择页读子类目，按商品信息选一个（规则见 shared/vc-category.js），
// 换成末级类目再打开发布页。读到的子类目按类目ID记在内存里，同一批里同类目的商品不用再跑类目页
import { leafHints, pickLeafChild } from '../shared/vc-category.js';
import { callVcBackend, navigateTab } from './chrome-env.js';
import { CATEGORY_PAGE, landedPageKind } from './category-search.js';

// 京东类目最多四级，源类目一般是三级：最多再往下选两级
const MAX_EXTRA_LEVELS = 2;
const LOGIN_MSG = '商家后台需要重新登录';
const FIX_HINT = '可在「编辑」中填写类目ID路径，或在设置的「类目映射」中配置';

/** 本次运行里读到的子类目：类目ID → 子类目列表（Service Worker 重启后清空，最多多跑一次类目页） */
export const sharedLeafCache = new Map();

const label = (node) => `「${node.name}」[${node.id}]`;
const notLeafText = (parent) => `类目${label(parent)}在 VC 后台不是末级类目`;

async function openCategoryPage(tabId) {
  await navigateTab(tabId, CATEGORY_PAGE);
  const kind = await landedPageKind(tabId);
  if (kind === 'login') return LOGIN_MSG;
  return kind === 'category' ? '' : '类目选择页没有打开（被跳到了别的页面）';
}

/**
 * 某个类目的子类目：先查缓存；tabId 为 null 时只查缓存
 * @returns {Promise<{children?: object[], miss?: boolean, error?: string}>}
 */
async function loadChildren({ tabId, path, cache, page }) {
  const id = path.at(-1);
  if (cache.has(id)) return { children: cache.get(id) };
  if (tabId == null) return { miss: true };
  if (!page.opened) {
    const error = await openCategoryPage(tabId);
    if (error) return { error };
    page.opened = true;
  }
  const res = await callVcBackend(tabId, 'vcChildCategories', { path });
  if (!res?.ok) return { error: res?.error || '类目选择页没有返回子类目' };
  if (res.leaf) return { error: '类目选择页上它却是末级类目，请在发布页上核对' };
  cache.set(id, res.children);
  return { children: res.children };
}

function ambiguousText(parent, path, candidates) {
  if (!candidates.length) return `${notLeafText(parent)}，下面也没有可以发布的子类目（可能不在账号的产品线里）；${FIX_HINT}`;
  const list = candidates.map((c) => `${c.name}[${c.id}]`).join('、');
  return `${notLeafText(parent)}，自动判断不出该选哪个子类目：${list}。请在「编辑」中填写类目ID路径（如 ${[...path, candidates[0].id].join(',')}），或在设置的「类目映射」中配置`;
}

/** 自动选的子类目发布页还是不认：清掉这条路径上记下的子类目，下次重新读 */
export function forgetLeaf(cache, cateList) {
  for (const id of cateList.slice(0, -1)) cache.delete(String(id));
}

/**
 * 把目标类目换成末级类目；选好之后才写日志（中途缓存没有、要回头打开页面时不写，免得同一句写两遍）
 * @param {{tabId?: number|null, target: {categoryId: string, cateList: string[], name: string}, product: object,
 *   edits?: object, log: (msg: string) => void, cache?: Map<string, object[]>}} input
 *   tabId 为 null：打开发布页之前只用缓存，缓存里没有就原样返回
 * @returns {Promise<{target: object, changed: boolean, note?: string} | {error: string}>} note：写进结果的换类目说明
 */
export async function resolveLeafTarget({ tabId = null, target, product, edits, log, cache = sharedLeafCache }) {
  const hints = leafHints(product, edits);
  const page = { opened: false };
  let path = target.cateList.map(String);
  let names = [target.name];
  let parent = { id: String(target.categoryId), name: String(target.name).split('>').at(-1).trim() };
  let notes = [];
  for (let level = 0; level < MAX_EXTRA_LEVELS; level += 1) {
    let loaded;
    try {
      loaded = await loadChildren({ tabId, path, cache, page });
    } catch (e) {
      loaded = { error: e.message };
    }
    if (loaded.miss) return { target, changed: false };
    if (loaded.error) return { error: `${notLeafText(parent)}，读取子类目失败：${loaded.error}；${FIX_HINT}` };
    const picked = pickLeafChild(loaded.children, hints, parent.name);
    if (!picked.child) return { error: ambiguousText(parent, path, picked.candidates) };
    const { child } = picked;
    path = [...path, String(child.id)];
    names = [...names, child.name];
    notes = [...notes, `${notLeafText(parent)}，已改用子类目${label(child)}（${picked.reason}），请核对；${FIX_HINT}`];
    if (child.isLeaf) {
      notes.forEach((n) => log(n));
      const leafTarget = { ...target, categoryId: String(child.id), cateList: path, name: names.join(' > ') };
      return { changed: true, target: leafTarget, note: `类目已自动改为「${leafTarget.name}」[${child.id}]，请核对` };
    }
    parent = child;
  }
  return { error: `${label(parent)} 下面的类目层级太深，没能选到末级类目；${FIX_HINT}` };
}
