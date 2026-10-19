// 采集结果落地到本地文件夹的目录规划（纯函数）：<存储位置>/<品牌>/<SKU>/{主图,详情图,商品信息.*}
import { itemBrand, brandKey } from './brand-folders.js';
import { toOriginalImageUrl } from './url-utils.js';

export const IMAGE_DIRS = { main: '主图', detail: '详情图' };
export const INFO_JSON = '商品信息.json';
export const INFO_TXT = '商品信息.txt';

const MAX_NAME_LENGTH = 80;
const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif', 'bmp']);

/** 文件夹/文件名里不能出现的字符替换成下划线，去掉首尾空格和结尾的点 */
export function safeName(name, fallback = '_') {
  const cleaned = String(name ?? '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .trim()
    .replace(/[.\s]+$/, '')
    .slice(0, MAX_NAME_LENGTH)
    .trim();
  if (!cleaned) return fallback;
  return /^\.+$/.test(cleaned) ? '_' : cleaned;
}

/** 01.jpg、02.png …；取地址里最后一个图片扩展名，拿不到时按 jpg 保存 */
export function imageFileName(url, index) {
  const path = String(url ?? '').split(/[?#!]/)[0];
  const ext = path.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase();
  return `${String(index + 1).padStart(2, '0')}.${IMAGE_EXTS.has(ext) ? ext : 'jpg'}`;
}

/** 同一品牌（括号全半角、大小写不同）沿用已有的品牌文件夹 */
export function pickBrandDir(existingDirNames, brand) {
  const key = brandKey(brand);
  return existingDirNames.find((n) => brandKey(n) === key) ?? safeName(brand);
}

function infoText(item, product, now) {
  const lines = [
    `标题：${product.title ?? ''}`,
    `SKU：${item.skuId}`,
    `链接：${product.url || item.url || ''}`,
    `品牌：${itemBrand(item)}`,
    `京东价：${product.price ?? ''}`,
    `类目：${(product.crumbs ?? []).join(' > ')}`,
    ...(product.saleDims ?? []).map((d) => `${d.name}：${d.values.join('、')}`),
    '',
    '【商品参数】',
    ...(product.params ?? []).map((p) => `${p.name}：${p.value}`),
    '',
    `采集时间：${now.toLocaleString('zh-CN', { hour12: false })}`,
  ];
  return `${lines.join('\n')}\n`;
}

/**
 * @param {object} item 已采集的任务条目
 * @returns {{brand: string, skuDir: string, images: {dir: string, name: string, url: string}[], files: {name: string, text: string}[]}}
 */
export function buildLocalPlan(item, { now = new Date() } = {}) {
  const product = item?.product;
  if (!product) throw new Error('尚未采集，无法保存到本地');
  // 早先采集的数据里存的是带水印的 /n0/ 地址，下载前统一换成无水印原图
  const toImage = (dir) => (raw, i) => {
    const url = toOriginalImageUrl(raw);
    return { dir, name: imageFileName(url, i), url };
  };
  const images = [
    ...(product.mainImages ?? []).map(toImage(IMAGE_DIRS.main)),
    ...(product.detailImages ?? []).map(toImage(IMAGE_DIRS.detail)),
  ];
  const localImages = Object.fromEntries(
    Object.values(IMAGE_DIRS).map((dir) => [dir, images.filter((img) => img.dir === dir).map((img) => img.name)]),
  );
  // 与“导出采集数据”格式一致，可以直接用“导入”按钮导回插件
  const json = {
    app: 'jdmove',
    version: 1,
    exportedAt: now.toISOString(),
    items: [{ skuId: item.skuId, product, edits: item.edits ?? {}, localImages }],
  };
  return {
    brand: itemBrand(item),
    skuDir: safeName(item.skuId),
    images,
    files: [
      { name: INFO_JSON, text: JSON.stringify(json, null, 2) },
      { name: INFO_TXT, text: infoText(item, product, now) },
    ],
  };
}
