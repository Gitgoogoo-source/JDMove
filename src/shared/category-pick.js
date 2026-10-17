// 目标店铺类目的解析与自动匹配（纯函数）
import { normalizeName, similarity } from './text.js';

const NODE_RE = /^(.*?)\[(\d+)\]$/;
const MIN_SCORE = 40;

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

function scorePath(path, { leafName = '', crumbs = [] }) {
  if (!path.length) return 0;
  const leaf = normalizeName(stripChannel(path.at(-1).name));
  const want = normalizeName(leafName);
  let score = 0;
  if (want && leaf === want) score += 100;
  else if (want && (leaf.includes(want) || want.includes(leaf))) score += 60;
  else score += similarity(leaf, want) * 50;
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

/**
 * 用户维护的类目映射：source 为源面包屑路径（用 > 分隔，可只写末尾几级）
 * @param {Array<{source: string, cateList: number[], name?: string}>} map
 * @param {string[]} crumbs
 */
export function matchCategoryMap(map, crumbs) {
  const path = (crumbs ?? []).map(normalizeName);
  for (const entry of map ?? []) {
    const want = String(entry.source ?? '')
      .split('>')
      .map(normalizeName)
      .filter(Boolean);
    if (!want.length || want.length > path.length) continue;
    const tail = path.slice(path.length - want.length);
    const tailWithoutBrand = path.slice(Math.max(0, path.length - want.length - 1), path.length - 1);
    if (want.every((w, i) => tail[i] === w) || want.every((w, i) => tailWithoutBrand[i] === w)) return entry;
  }
  return null;
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
