// 销售属性 / SKU 表填写计划（纯函数）
import { normalizeName, similarity } from './text.js';
import { truncateWeighted } from './title.js';
import { findSourceValue } from './attr-mapping.js';

const DIM_SYNONYMS = [
  ['颜色', '颜色分类', '主体颜色', '色系'],
  ['尺码', '尺寸', '码数', '鞋码'],
  ['规格', '版本', '型号', '容量', '重量', '套餐', '包装规格', '净含量', '规格型号'],
  ['口味', '风味'],
].map((g) => g.map(normalizeName));

const MAX_VALUE_LENGTH = 30; // 京东：销售属性值 ≤15 个汉字（30 字符）
const FALLBACK_VALUE = '标准装';

function dimScore(target, source) {
  const t = normalizeName(target);
  const s = normalizeName(source);
  if (t === s) return 1;
  if (DIM_SYNONYMS.some((g) => g.includes(t) && g.includes(s))) return 0.9;
  return similarity(t, s);
}

/**
 * 把源规格维度分配到目标销售属性维度上，返回与 targetDims 等长的二维数组
 * @param {string[]} targetDims
 * @param {string[]} sourceDims
 * @returns {string[][]}
 */
export function assignDims(targetDims, sourceDims) {
  const slots = targetDims.map(() => []);
  const pending = [];
  const used = new Set();
  for (const src of sourceDims) {
    let bestIdx = -1;
    let best = 0.5;
    targetDims.forEach((t, i) => {
      const s = dimScore(t, src);
      if (!used.has(i) && s >= best) {
        best = s;
        bestIdx = i;
      }
    });
    if (bestIdx >= 0) {
      slots[bestIdx].push(src);
      used.add(bestIdx);
    } else pending.push(src);
  }
  for (const src of pending) {
    const free = slots.findIndex((s, i) => s.length === 0 && !used.has(i));
    const idx = free >= 0 ? free : slots.findIndex((s) => s.length > 0);
    if (idx < 0) continue;
    slots[idx].push(src);
    used.add(idx);
  }
  // 合并时保持源维度的原始顺序
  return slots.map((s) => [...s].sort((a, b) => sourceDims.indexOf(a) - sourceDims.indexOf(b)));
}

const clip = (v) => truncateWeighted(String(v).trim(), MAX_VALUE_LENGTH);

function cartesian(lists) {
  return lists.reduce((acc, list) => acc.flatMap((prefix) => list.map((v) => [...prefix, v])), [[]]);
}

function capValues(dims, maxRows, warnings) {
  let current = dims.map((d) => ({ ...d, values: [...d.values] }));
  const count = () => current.reduce((n, d) => n * d.values.length, 1);
  while (count() > maxRows) {
    const largest = current.reduce((a, b) => (b.values.length > a.values.length ? b : a));
    if (largest.values.length <= 1) break;
    current = current.map((d) => (d === largest ? { ...d, values: d.values.slice(0, -1) } : d));
  }
  if (current.some((d, i) => d.values.length !== dims[i].values.length)) {
    warnings.push(`SKU 组合超过上限 ${maxRows}，已截断部分规格值`);
  }
  return current;
}

function fallbackSpec(product) {
  const hit = findSourceValue('规格', product) ?? findSourceValue('净含量', product) ?? findSourceValue('型号', product);
  return clip(hit?.value || FALLBACK_VALUE);
}

/**
 * @param {string[]} targetDims 目标类目销售属性维度名（按页面顺序）
 * @param {object} product 归一化商品
 * @param {{defaultPrice?: number, prices?: Record<string, number>, stock?: number, maxRows?: number}} opts
 */
export function buildSalePlan(targetDims, product, opts = {}) {
  const { defaultPrice = null, prices = {}, stock = 0, maxRows = 20 } = opts;
  const warnings = [];
  if (!targetDims?.length) return { dims: [], rows: [], warnings };

  const sourceDims = (product?.saleDims ?? []).filter((d) => d.values?.length);
  const assignment = assignDims(targetDims, sourceDims.map((d) => d.name));
  const variants = product?.variants ?? [];
  const combine = (valueOf, srcNames) => clip(srcNames.map(valueOf).filter(Boolean).join(' '));

  let dims;
  if (!sourceDims.length) {
    dims = [{ name: targetDims[0], values: [fallbackSpec(product)] }];
  } else {
    dims = targetDims
      .map((name, i) => {
        const srcNames = assignment[i];
        if (!srcNames.length) return null;
        const values = variants.length
          ? variants.map((v) => combine((n) => v.values[n], srcNames))
          : cartesian(srcNames.map((n) => sourceDims.find((d) => d.name === n).values)).map((combo) =>
              clip(combo.join(' ')),
            );
        return { name, values: [...new Set(values.filter(Boolean))], srcNames };
      })
      .filter(Boolean);
  }
  dims = capValues(dims, maxRows, warnings);

  const variantKey = (v) => dims.map((d) => combine((n) => v.values[n], d.srcNames ?? [])).join('\u0001');
  const byKey = new Map(variants.map((v) => [variantKey(v), v]));
  const rows = cartesian(dims.map((d) => d.values)).map((values) => {
    const match = byKey.get(values.join('\u0001')) ?? null;
    const enabled = variants.length === 0 || match != null;
    return {
      values,
      price: (match && prices[match.skuId]) ?? defaultPrice,
      stock: enabled ? stock : 0,
      enabled,
      sourceSkuId: match?.skuId ?? null,
    };
  });
  return { dims: dims.map(({ name, values }) => ({ name, values })), rows, warnings };
}
