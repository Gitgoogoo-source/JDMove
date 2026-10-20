// “已发布”归档视图：品牌文件夹列表与面包屑
import { h, safeImgSrc } from './dom.js';

const PREVIEW_COUNT = 4;

function folderCard(folder, { onOpen, isAlert }) {
  const previews = folder.items
    .map((i) => safeImgSrc(i.product?.mainImages?.[0]))
    .filter(Boolean)
    .slice(0, PREVIEW_COUNT);
  const alerts = folder.alert ? 0 : folder.items.filter(isAlert).length;
  const count = folder.alert ? `${folder.items.length} 个商品需要处理` : `${folder.items.length} 个商品`;
  return h(
    'button',
    { type: 'button', class: folder.alert ? 'folder alert' : 'folder', title: `打开「${folder.brand}」`, onclick: () => onOpen(folder.key) },
    h('span', { class: 'folder-icon', 'aria-hidden': 'true' }),
    h('span', { class: 'folder-name' }, folder.brand),
    h('span', { class: 'folder-count' }, count, alerts ? h('span', { class: 'alert-badge' }, `倒挂 ${alerts}`) : null),
    h('span', { class: 'folder-previews' }, ...previews.map((src) => h('img', { src, alt: '', referrerpolicy: 'no-referrer', loading: 'lazy' }))),
  );
}

/**
 * @param {{key: string, brand: string, items: object[], alert?: boolean}[]} folders alert=true 为“价格倒挂”虚拟文件夹
 * @param {{onOpen: (key: string) => void, isAlert: (item: object) => boolean}} ctx
 */
export function renderFolders(folders, ctx) {
  return folders.map((f) => folderCard(f, ctx));
}

/**
 * @param {{folders: object[], folder: object|null, alerts?: number, onHome: () => void, onExit: () => void}} ctx
 */
export function renderCrumb({ folders, folder, alerts = 0, onHome, onExit }) {
  const total = folders.reduce((n, f) => n + f.items.length, 0);
  const back = h('button', { type: 'button', class: 'link', onclick: onExit }, '← 返回任务列表');
  const home = folder
    ? h('button', { type: 'button', class: 'link', onclick: onHome }, '已发布')
    : h('strong', {}, '已发布');
  const tail = folder
    ? [h('span', { class: 'muted' }, '/'), h('strong', {}, folder.brand), h('span', { class: 'muted' }, `${folder.items.length} 个商品`)]
    : [
        h('span', { class: 'muted' }, `${folders.length} 个品牌 · ${total} 个商品`),
        alerts ? h('span', { class: 'alert-text' }, `价格倒挂 ${alerts} 个`) : null,
      ];
  return [back, h('span', { class: 'sep' }), home, ...tail];
}
