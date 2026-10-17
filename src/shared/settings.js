// 插件设置：默认值、合并与校验（纯函数）

export const PUBLISH_ACTIONS = {
  none: '只填写，不保存（停在页面供人工检查）',
  draft: '保存草稿',
  submit_off: '提交暂不上架',
  submit_on: '提交并上架',
};

export const DEFAULT_SETTINGS = Object.freeze({
  collect: { minDelaySec: 8, maxDelaySec: 15, scrollDetail: true, useIncognito: true, allVariants: false },
  price: { multiplier: 1, add: 0, rounding: 'cent', minPrice: 0.01 },
  stock: 100,
  title: { prefix: '', suffix: '', removeWords: ['京东自营', '自营', '京东超市'], maxLength: 60 },
  publish: {
    action: 'draft',
    delaySec: 5,
    maxMainImages: 10,
    maxDetailImages: 30,
    reuploadDetailImages: true,
    fillSkuAttrs: true,
  },
  attrDefaultsText: '本品与最小可售单位数量关系=1\n销售期限=新日期',
  packList: '',
  categoryMap: [],
});

const isPlainObject = (v) => v != null && typeof v === 'object' && !Array.isArray(v);

function deepMerge(base, patch) {
  if (!isPlainObject(patch)) return structuredClone(base);
  const out = {};
  for (const key of new Set([...Object.keys(base), ...Object.keys(patch)])) {
    const b = base[key];
    const p = patch[key];
    if (isPlainObject(b)) out[key] = deepMerge(b, p);
    else if (p === undefined) out[key] = structuredClone(b);
    else out[key] = structuredClone(p);
  }
  return out;
}

export function mergeSettings(saved) {
  return deepMerge(DEFAULT_SETTINGS, saved ?? {});
}

/**
 * @returns {{ok: boolean, errors: string[], value: object}}
 */
export function validateSettings(input) {
  const errors = [];
  const v = mergeSettings(input);
  const num = (val, fallback, { min = -Infinity, max = Infinity } = {}, label) => {
    const n = Number(val);
    if (!Number.isFinite(n) || n < min || n > max) {
      errors.push(`${label} 无效，已恢复默认`);
      return fallback;
    }
    return n;
  };
  const d = DEFAULT_SETTINGS;
  const minDelay = num(v.collect.minDelaySec, d.collect.minDelaySec, { min: 3, max: 600 }, '最小间隔');
  let maxDelay = num(v.collect.maxDelaySec, d.collect.maxDelaySec, { min: 3, max: 1200 }, '最大间隔');
  if (maxDelay < minDelay) {
    errors.push('最大间隔不能小于最小间隔');
    maxDelay = minDelay;
  }
  const action = v.publish.action in PUBLISH_ACTIONS ? v.publish.action : 'draft';
  if (action !== v.publish.action) errors.push('发布动作无效，已改为保存草稿');
  const rounding = ['cent', 'jiao', 'yuan', 'nine'].includes(v.price.rounding) ? v.price.rounding : 'cent';

  const value = {
    ...v,
    collect: {
      ...v.collect,
      minDelaySec: minDelay,
      maxDelaySec: maxDelay,
      scrollDetail: Boolean(v.collect.scrollDetail),
      useIncognito: Boolean(v.collect.useIncognito),
      allVariants: Boolean(v.collect.allVariants),
    },
    price: {
      multiplier: num(v.price.multiplier, d.price.multiplier, { min: 0.01, max: 100 }, '价格倍率'),
      add: num(v.price.add, d.price.add, { min: -100000, max: 100000 }, '加价'),
      rounding,
      minPrice: num(v.price.minPrice, d.price.minPrice, { min: 0.01, max: 1000000 }, '最低价'),
    },
    stock: Math.floor(num(v.stock, d.stock, { min: 0, max: 9999999 }, '库存')),
    title: {
      ...v.title,
      prefix: String(v.title.prefix ?? ''),
      suffix: String(v.title.suffix ?? ''),
      removeWords: (Array.isArray(v.title.removeWords) ? v.title.removeWords : []).map(String).filter(Boolean),
      maxLength: num(v.title.maxLength, d.title.maxLength, { min: 10, max: 200 }, '标题长度'),
    },
    publish: {
      ...v.publish,
      action,
      delaySec: num(v.publish.delaySec, d.publish.delaySec, { min: 0, max: 600 }, '发布间隔'),
      maxMainImages: num(v.publish.maxMainImages, d.publish.maxMainImages, { min: 1, max: 10 }, '主图数量'),
      maxDetailImages: num(v.publish.maxDetailImages, d.publish.maxDetailImages, { min: 0, max: 50 }, '详情图数量'),
      reuploadDetailImages: Boolean(v.publish.reuploadDetailImages),
      fillSkuAttrs: Boolean(v.publish.fillSkuAttrs),
    },
    categoryMap: Array.isArray(v.categoryMap) ? v.categoryMap : [],
  };
  return { ok: errors.length === 0, errors, value };
}

/**
 * "属性名=值" 每行一条，# 开头为注释
 * @returns {Record<string, string>}
 */
export function parseAttrDefaults(text) {
  const out = {};
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const m = trimmed.match(/^(.+?)\s*[=＝]\s*(.+)$/);
    if (!m || !m[1].trim()) continue;
    out[m[1].trim()] = m[2].trim();
  }
  return out;
}
