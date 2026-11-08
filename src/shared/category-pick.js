// 目标类目：类目搜索结果的解析、用户维护的类目映射、手动输入的类目ID路径（纯函数）
import { normalizeName } from './text.js';

const NODE_RE = /^(.*?)\[(\d+)\]$/;

/**
 * "（京喜通）休闲零食[17991] > 糖巧布丁[17994]" -> [{name, id}]
 * @param {string} text
 */
export function parseCategoryText(text) {
  const parts = String(text ?? '')
    .split('>')
    .map((s) => s.trim())
    .filter(Boolean);
  const nodes = [];
  for (const part of parts) {
    const m = part.match(NODE_RE);
    if (!m) return [];
    nodes.push({ name: m[1].trim(), id: Number(m[2]) });
  }
  return nodes;
}

/** 源面包屑中叶子类目的位置（最后一级是品牌时为倒数第二级） */
function leafIndex(crumbs, leafName) {
  const want = normalizeName(leafName);
  const idx = want ? crumbs.map(normalizeName).lastIndexOf(want) : -1;
  return idx >= 0 ? idx : crumbs.length - 1;
}

/** want 作为连续片段出现在 path 中的最后结束位置；不出现时为 -1 */
function lastRunEnd(path, want) {
  for (let start = path.length - want.length; start >= 0; start -= 1) {
    if (want.every((w, i) => path[start + i] === w)) return start + want.length;
  }
  return -1;
}

/**
 * 用户维护的类目映射：source 为源面包屑中任意连续几级（用 > 分隔），
 * 写上级也能命中更细的源类目；多条命中时取级数最多、最靠近叶子的一条
 * @param {Array<{source: string, cateList: number[], name?: string}>} map
 * @param {string[]} crumbs
 */
export function matchCategoryMap(map, crumbs) {
  const path = (crumbs ?? []).map(normalizeName);
  const hits = (map ?? [])
    .map((entry, order) => {
      const want = String(entry.source ?? '')
        .split('>')
        .map(normalizeName)
        .filter(Boolean);
      return { entry, order, size: want.length, end: want.length ? lastRunEnd(path, want) : -1 };
    })
    .filter((h) => h.end >= 0)
    .sort((a, b) => b.size - a.size || b.end - a.end || a.order - b.order);
  return hits[0]?.entry ?? null;
}

/**
 * 记住类目映射时用的源路径：到叶子类目为止的末两级（不含品牌）
 * @param {{leafCategory?: string, crumbs?: string[]}} product
 */
export function mappingSourceFor(product) {
  const crumbs = product?.crumbs ?? [];
  if (!crumbs.length) return '';
  return crumbs.slice(0, leafIndex(crumbs, product.leafCategory) + 1).slice(-2).join('>');
}

/**
 * 用户手动输入类目：支持 "1,2,3" 或搜索结果整行文本
 * @param {string} input
 * @returns {number[]}
 */
export function parseCateListInput(input) {
  const text = String(input ?? '');
  const bracketed = [...text.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])).filter((n) => n > 0);
  if (bracketed.length) return bracketed;
  return (text.match(/\d+/g) ?? []).map(Number).filter((n) => n > 0);
}

/**
 * 编辑弹窗里“类目ID路径”的校验：留空（自动匹配）或能解析出类目ID时返回空字符串；
 * 填了内容却解析不出ID（如只填了类目名称）时返回提示，弹窗据此拦住保存，不再悄悄丢掉输入
 * @param {string} input
 */
export function cateListInputError(input) {
  if (!String(input ?? '').trim() || parseCateListInput(input).length) return '';
  return '类目ID路径要填类目ID（数字），如 15901,15902,15908；不知道ID时用下面的「搜索店铺类目」选择末级类目';
}

const cateLabel = (edits) => {
  const ids = `[${edits.cateList.join(',')}]`;
  return edits.cateName ? `${edits.cateName} ${ids}` : ids;
};

/**
 * 保存编辑后类目的变化，写进日志让用户知道发布时用哪个类目；类目没变时为空
 * @param {{cateList?: number[], cateName?: string}} prev
 * @param {{cateList?: number[], cateName?: string}} next
 */
export function cateChangeNote(prev = {}, next = {}) {
  const before = (prev?.cateList ?? []).join(',');
  const after = (next?.cateList ?? []).join(',');
  if (before === after) return '';
  return after ? `目标类目已设为：${cateLabel(next)}` : '已清空指定类目，发布时自动匹配';
}
