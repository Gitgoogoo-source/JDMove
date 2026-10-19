// 目标店铺类目的解析与自动匹配（纯函数）
import { normalizeName, similarity } from './text.js';

const NODE_RE = /^(.*?)\[(\d+)\]$/;
const MIN_SCORE = 40;
// 和源面包屑上一级同名时按叶子名匹配的折扣计分
const PARENT_FACTOR = 0.8;
const MAX_KEYWORDS = 8;
const MIN_KEYWORD_LEN = 2;

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

const stripChannel = (name) => String(name).replace(/^（[^）]*）|^\([^)]*\)/, '');

function nameScore(leaf, want) {
  if (!want) return 0;
  if (leaf === want) return 100;
  if (leaf.includes(want) || want.includes(leaf)) return 60;
  return similarity(leaf, want) * 50;
}

/** 源面包屑中叶子类目的位置（最后一级是品牌时为倒数第二级） */
function leafIndex(crumbs, leafName) {
  const want = normalizeName(leafName);
  const idx = want ? crumbs.map(normalizeName).lastIndexOf(want) : -1;
  return idx >= 0 ? idx : crumbs.length - 1;
}

function scorePath(path, { leafName = '', crumbs = [] }) {
  if (!path.length) return 0;
  const leaf = normalizeName(stripChannel(path.at(-1).name));
  const parent = normalizeName(crumbs[leafIndex(crumbs, leafName) - 1] ?? '');
  // 店铺类目常比前台类目粗一级：如“牛奶巧克力”在店铺里只有“巧克力”
  let score = Math.max(nameScore(leaf, normalizeName(leafName)), nameScore(leaf, parent) * PARENT_FACTOR);
  const upper = path.slice(0, -1).map((n) => stripChannel(n.name));
  const crumbHits = upper.filter((u) => crumbs.some((c) => similarity(u, c) >= 0.5)).length;
  score += crumbHits * 8;
  score += path.length * 3;
  return score;
}

/**
 * @param {Array<Array<{name: string, id: number}>>} paths 搜索结果
 * @param {{leafName?: string, crumbs?: string[]}} hints 源商品类目信息
 */
export function pickCategory(paths, hints = {}) {
  const ranked = (paths ?? [])
    .filter((p) => p?.length)
    .map((path) => ({ path, score: scorePath(path, hints) }))
    .sort((a, b) => b.score - a.score);
  const top = ranked[0];
  return { best: top && top.score >= MIN_SCORE ? top.path : null, ranked };
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

/** 叶子名去掉前后修饰后的较短写法：“牛奶巧克力”->“奶巧克力”“巧克力”…，“饼干礼盒”->“饼干” */
function shorterNames(name) {
  const out = [];
  for (let len = name.length - 1; len >= MIN_KEYWORD_LEN; len -= 1) out.push(name.slice(name.length - len), name.slice(0, len));
  return out;
}

/**
 * 到店铺类目页搜索时依次尝试的关键词：叶子名 -> 最近上级 -> 叶子名缩短 -> 更上级
 * @param {{leafCategory?: string, crumbs?: string[]}} product
 * @returns {string[]}
 */
export function categoryKeywords(product) {
  const crumbs = (product?.crumbs ?? []).map((c) => String(c).trim()).filter(Boolean);
  const leaf = String(product?.leafCategory ?? '').trim();
  if (!leaf && !crumbs.length) return [];
  const uppers = crumbs.slice(0, leafIndex(crumbs, leaf)).reverse();
  const all = [leaf, ...uppers.slice(0, 1), ...shorterNames(leaf), ...uppers.slice(1)];
  return [...new Set(all.filter((k) => k.length >= MIN_KEYWORD_LEN))].slice(0, MAX_KEYWORDS);
}

/**
 * 合并多次搜索的结果：按类目ID路径去重，并去掉是其他结果前缀的非末级类目
 * @param {Array<Array<Array<{name: string, id: number}>>>} lists
 */
export function mergeSearchResults(lists) {
  const byKey = new Map();
  for (const path of (lists ?? []).flat()) if (path?.length) byKey.set(path.map((n) => n.id).join(','), path);
  const keys = [...byKey.keys()];
  return [...byKey.entries()].filter(([key]) => !keys.some((k) => k.startsWith(`${key},`))).map(([, path]) => path);
}

/** 店铺末级类目与源叶子类目或其上一级同名：再换关键词也不会更好 */
function isSureMatch(path, { leafName, crumbs }) {
  const leaf = normalizeName(stripChannel(path.at(-1).name));
  const parent = crumbs[leafIndex(crumbs, leafName) - 1];
  return [leafName, parent].some((n) => n && normalizeName(n) === leaf);
}

/**
 * 依次用关键词搜索店铺类目，汇总所有结果统一打分；找到同名类目时提前结束
 * @param {(keyword: string) => Promise<{ok?: boolean, error?: string, results?: string[]}>} search
 * @param {{leafCategory?: string, crumbs?: string[]}} product
 * @param {(msg: string) => void} log
 * @returns {Promise<{cateList: number[], name: string, from: 'auto'} | null>}
 */
export async function searchBestCategory(search, product, log) {
  const hints = { leafName: product?.leafCategory, crumbs: product?.crumbs ?? [] };
  let found = [];
  let best = null;
  for (const kw of categoryKeywords(product)) {
    const res = await search(kw);
    if (res && res.ok === false) log(`类目搜索“${kw}”失败：${res.error || '未知错误'}`);
    const paths = (res?.results ?? []).map(parseCategoryText).filter((p) => p.length);
    log(`类目搜索“${kw}”：${paths.length} 个结果`);
    found = [...found, paths];
    const picked = pickCategory(mergeSearchResults(found), hints);
    best = picked.best;
    if (best && isSureMatch(best, hints)) break;
  }
  return best ? { cateList: best.map((n) => n.id), name: best.map((n) => n.name).join(' > '), from: 'auto' } : null;
}

/**
 * 用户手动输入类目：支持 "1,2,3" 或搜索结果整行文本
 * @param {string} input
 * @returns {number[]}
 */
export function parseCateListInput(input) {
  const text = String(input ?? '');
  const bracketed = [...text.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1]));
  if (bracketed.length) return bracketed;
  return (text.match(/\d+/g) ?? []).map(Number);
}
