// “已发布”归档视图：品牌文件夹列表与面包屑
import { h, safeImgSrc } from './dom.js';

const PREVIEW_COUNT = 4;

function folderCard(folder, onOpen) {
  const previews = folder.items
    .map((i) => safeImgSrc(i.product?.mainImages?.[0]))
    .filter(Boolean)
    .slice(0, PREVIEW_COUNT);
  return h(
    'button',
    { type: 'button', class: 'folder', title: `打开「${folder.brand}」`, onclick: () => onOpen(folder.key) },
    h('span', { class: 'folder-icon', 'aria-hidden': 'true' }),
    h('span', { class: 'folder-name' }, folder.brand),
    h('span', { class: 'folder-count' }, `${folder.items.length} 个商品`),
    h('span', { class: 'folder-previews' }, ...previews.map((src) => h('img', { src, alt: '', referrerpolicy: 'no-referrer', loading: 'lazy' }))),
  );
}

/**
 * @param {{key: string, brand: string, items: object[]}[]} folders
 * @param {{onOpen: (key: string) => void}} ctx
 */
export function renderFolders(folders, { onOpen }) {
  return folders.map((f) => folderCard(f, onOpen));
}

/**
 * @param {{folders: object[], folder: object|null, onHome: () => void, onExit: () => void}} ctx
 */
export function renderCrumb({ folders, folder, onHome, onExit }) {
  const total = folders.reduce((n, f) => n + f.items.length, 0);
  const back = h('button', { type: 'button', class: 'link', onclick: onExit }, '← 返回任务列表');
  const home = folder
    ? h('button', { type: 'button', class: 'link', onclick: onHome }, '已发布')
    : h('strong', {}, '已发布');
  const tail = folder
    ? [h('span', { class: 'muted' }, '/'), h('strong', {}, folder.brand), h('span', { class: 'muted' }, `${folder.items.length} 个商品`)]
    : [h('span', { class: 'muted' }, `${folders.length} 个品牌 · ${total} 个商品`)];
  return [back, h('span', { class: 'sep' }), home, ...tail];
}
