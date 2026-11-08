// 插件设置：默认值、合并与校验（纯函数）。商品一律发布到 VC 自营（供应商后台 vcp.jd.com）

// VC 发布页填写完成后：一律点“保存草稿”（到 VC 后台草稿箱检查后再手动提交），或者不点按钮停在页面
export const PUBLISH_ACTIONS = {
  draft: '保存草稿（到 VC 后台草稿箱检查后再手动提交）',
  none: '只填写，不保存（停在页面供人工检查）',
};
const DEFAULT_PUBLISH_ACTION = 'draft';
// VC 发布页“商品包装”的选项
export const VC_PACK_TYPES = ['普通商品', '易碎品', '裸瓶液体', '带包装液体'];
// 京东员工 ERP 账号：字母、数字、点、下划线、横线
export const ERP_RE = /^[\w.-]{1,50}$/;
const MAX_UNIT_LENGTH = 10;

export const DEFAULT_SETTINGS = Object.freeze({
  collect: { minDelaySec: 8, maxDelaySec: 15, scrollDetail: true, useIncognito: true, allVariants: false },
  title: { prefix: '', suffix: '', removeWords: ['京东自营', '自营', '京东超市'], maxLength: 60 },
  publish: {
    action: DEFAULT_PUBLISH_ACTION,
    delaySec: 5,
    maxMainImages: 10,
    maxDetailImages: 30,
    reuploadDetailImages: true,
    fillSkuAttrs: true,
    // 保存接口限流（操作过于频繁）后建议等待的分钟数：冷却期内点“发布选中”会先确认；0 = 不提醒
    throttleCooldownMin: 60,
  },
  // 已发布商品的京东今日价检查：间隔、预警线（售价比京东今日价高出不到这个数也提醒）
  priceWatch: { minDelaySec: 3, maxDelaySec: 6, alertMargin: 0 },
  // VC 自营发布：采购员/销售员共用的 ERP（留空沿用页面默认值）、销售单位（留空按包装形式/规格推断）、
  // 包装规格、商品包装、质保期（源商品没有时用）
  vc: { erpCode: '', saleUnit: '', packSpecification: 1, packType: '普通商品', warranty: '无质保' },
  attrDefaultsText: '本品与最小可售单位数量关系=1\n销售期限=新日期',
  packList: '',
  categoryMap: [],
});

const isPlainObject = (v) => v != null && typeof v === 'object' && !Array.isArray(v);

/** 只合并默认值里有的键：旧版本留下的 POP 设置（售价倍率、库存、默认 UPC、改价等）读取时丢掉 */
function deepMerge(base, patch) {
  if (!isPlainObject(patch)) return structuredClone(base);
  const out = {};
  for (const key of Object.keys(base)) {
    const b = base[key];
    const p = patch[key];
    if (isPlainObject(b)) out[key] = deepMerge(b, p);
    else if (p === undefined) out[key] = structuredClone(b);
    else out[key] = structuredClone(p);
  }
  return out;
}

/** 旧版本的“提交并上架/提交暂不上架”等动作在 VC 上一律是“保存草稿”，只有“只填写”保留 */
const vcAction = (action) => (Object.hasOwn(PUBLISH_ACTIONS, action) ? action : DEFAULT_PUBLISH_ACTION);

export function mergeSettings(saved) {
  const merged = deepMerge(DEFAULT_SETTINGS, saved ?? {});
  return { ...merged, publish: { ...merged.publish, action: vcAction(merged.publish.action) } };
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
  const priceWatch = validatePriceWatch(v.priceWatch, num, errors);

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
    title: {
      ...v.title,
      prefix: String(v.title.prefix ?? ''),
      suffix: String(v.title.suffix ?? ''),
      removeWords: (Array.isArray(v.title.removeWords) ? v.title.removeWords : []).map(String).filter(Boolean),
      maxLength: num(v.title.maxLength, d.title.maxLength, { min: 10, max: 200 }, '标题长度'),
    },
    publish: {
      ...v.publish,
      delaySec: num(v.publish.delaySec, d.publish.delaySec, { min: 0, max: 600 }, '发布间隔'),
      maxMainImages: num(v.publish.maxMainImages, d.publish.maxMainImages, { min: 1, max: 10 }, '主图数量'),
      maxDetailImages: num(v.publish.maxDetailImages, d.publish.maxDetailImages, { min: 0, max: 50 }, '详情图数量'),
      reuploadDetailImages: Boolean(v.publish.reuploadDetailImages),
      fillSkuAttrs: Boolean(v.publish.fillSkuAttrs),
      throttleCooldownMin: num(v.publish.throttleCooldownMin, d.publish.throttleCooldownMin, { min: 0, max: 1440 }, '限流冷却时间'),
    },
    priceWatch,
    vc: validateVc(v.vc, num, errors),
    categoryMap: Array.isArray(v.categoryMap) ? v.categoryMap : [],
  };
  return { ok: errors.length === 0, errors, value };
}

function validateVc(vc, num, errors) {
  const d = DEFAULT_SETTINGS.vc;
  const erp = String(vc.erpCode ?? '').trim();
  const erpCode = erp === '' || ERP_RE.test(erp) ? erp : '';
  if (erp && !erpCode) errors.push('ERP 代码只能包含字母、数字、点、下划线、横线（如 xudezhi.6），已清空');
  const packType = VC_PACK_TYPES.includes(vc.packType) ? vc.packType : d.packType;
  if (packType !== vc.packType) errors.push(`商品包装无效，已改为${d.packType}`);
  return {
    erpCode,
    saleUnit: String(vc.saleUnit ?? '').trim().slice(0, MAX_UNIT_LENGTH),
    packSpecification: Math.floor(num(vc.packSpecification, d.packSpecification, { min: 1, max: 100000 }, '包装规格')),
    packType,
    warranty: String(vc.warranty ?? '').trim() || d.warranty,
  };
}

function validatePriceWatch(pw, num, errors) {
  const d = DEFAULT_SETTINGS.priceWatch;
  const minDelay = num(pw.minDelaySec, d.minDelaySec, { min: 2, max: 600 }, '价格检查最小间隔');
  let maxDelay = num(pw.maxDelaySec, d.maxDelaySec, { min: 2, max: 1200 }, '价格检查最大间隔');
  if (maxDelay < minDelay) {
    errors.push('价格检查的最大间隔不能小于最小间隔');
    maxDelay = minDelay;
  }
  return {
    minDelaySec: minDelay,
    maxDelaySec: maxDelay,
    alertMargin: num(pw.alertMargin, d.alertMargin, { min: 0, max: 100000 }, '价格预警线'),
  };
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
