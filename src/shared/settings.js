// 插件设置：默认值、合并与校验（纯函数）
import { deriveEditUrlTemplate } from './price-watch.js';
import { normalizeUpc } from './sku-attrs.js';

export const PUBLISH_ACTIONS = {
  submit_on: '提交并上架（推荐：审核通过后直接售卖，能拿到店铺编号）',
  submit_off: '提交暂不上架',
  draft: '保存草稿（草稿没有店铺编号）',
  none: '只填写，不保存（停在页面供人工检查）',
};
const DEFAULT_PUBLISH_ACTION = 'submit_on';
// 第 2 版起默认“提交并上架”：之前保存的“保存草稿”多半是旧默认值，读取时迁移一次
const PUBLISH_ACTION_VERSION = 2;

// 发布到哪种店铺后台：VC 自营（供应商）和 POP 的发布页、表单字段完全不同
export const PUBLISH_PLATFORMS = {
  vc: 'VC 自营（供应商后台 vcp.jd.com）',
  pop: 'POP 店铺（京麦商家后台）',
};
const DEFAULT_PLATFORM = 'vc';
// VC 发布页“商品包装”的选项
export const VC_PACK_TYPES = ['普通商品', '易碎品', '裸瓶液体', '带包装液体'];
// 京东员工 ERP 账号：字母、数字、点、下划线、横线
export const ERP_RE = /^[\w.-]{1,50}$/;
const MAX_UNIT_LENGTH = 10;

export const EDIT_URL_RULE =
  '需要京东商家后台的 https 链接，且只含一个商品编号；地址里同时有多个编号（如 wareId 和 skuId）时，请把商品编号写成 {wareId}，并删掉其他编号参数';

// 改价时在商品编辑页填好新价格后点哪个按钮
export const REPRICE_ACTIONS = {
  auto: '自动点“提交”或“保存”按钮（不会点“上架/下架”类按钮）',
  submit_on: '提交并上架',
  submit_off: '提交暂不上架',
  draft: '保存草稿',
  none: '只填写新价格，不保存（停在页面供人工检查）',
};

export const DEFAULT_SETTINGS = Object.freeze({
  collect: { minDelaySec: 8, maxDelaySec: 15, scrollDetail: true, useIncognito: true, allVariants: false },
  price: { multiplier: 1, add: 0, rounding: 'cent', minPrice: 0.01 },
  stock: 100,
  title: { prefix: '', suffix: '', removeWords: ['京东自营', '自营', '京东超市'], maxLength: 60 },
  publish: {
    platform: DEFAULT_PLATFORM,
    action: DEFAULT_PUBLISH_ACTION,
    actionVersion: PUBLISH_ACTION_VERSION,
    delaySec: 5,
    maxMainImages: 10,
    maxDetailImages: 30,
    reuploadDetailImages: true,
    fillSkuAttrs: true,
    // 源商品没有条形码（编辑里也没填）时填到商品基本信息和 SKU 表的“商品条形码”、“最小可售单位UPC”的默认值；留空则不填，由发布流程停下提示
    defaultUpc: '6914973039001',
    // 京麦提交接口限流（操作过于频繁）后建议等待的分钟数：冷却期内点“发布选中”会先确认；0 = 不提醒
    throttleCooldownMin: 60,
  },
  // 已发布商品的京东今日价检查与批量改价；editUrlTemplate 为店铺商品编辑页地址，商品编号写成 {wareId}
  priceWatch: { minDelaySec: 3, maxDelaySec: 6, alertMargin: 0, editUrlTemplate: '', repriceAction: 'auto' },
  // VC 自营发布：采购员/销售员共用的 ERP（留空沿用页面默认值）、销售单位（留空按包装形式/规格推断）、
  // 包装规格、商品包装、质保期（源商品没有时用）
  vc: { erpCode: '', saleUnit: '', packSpecification: 1, packType: '普通商品', warranty: '无质保' },
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

/** 旧版本保存的“保存草稿”改为“提交并上架”：草稿箱里的商品不会售卖，也没有店铺编号 */
function migratePublishAction(saved) {
  const publish = isPlainObject(saved) ? saved.publish : null;
  if (!isPlainObject(publish) || publish.actionVersion >= PUBLISH_ACTION_VERSION) return saved;
  const action = publish.action === 'draft' ? DEFAULT_PUBLISH_ACTION : publish.action;
  return { ...saved, publish: { ...publish, action, actionVersion: PUBLISH_ACTION_VERSION } };
}

export function mergeSettings(saved) {
  return deepMerge(DEFAULT_SETTINGS, migratePublishAction(saved ?? {}));
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
  const action = Object.hasOwn(PUBLISH_ACTIONS, v.publish.action) ? v.publish.action : DEFAULT_PUBLISH_ACTION;
  if (action !== v.publish.action) errors.push('发布动作无效，已改为提交并上架');
  const rounding = ['cent', 'jiao', 'yuan', 'nine'].includes(v.price.rounding) ? v.price.rounding : 'cent';
  const priceWatch = validatePriceWatch(v.priceWatch, num, errors);
  const platform = Object.hasOwn(PUBLISH_PLATFORMS, v.publish.platform) ? v.publish.platform : DEFAULT_PLATFORM;
  if (platform !== v.publish.platform) errors.push('发布平台无效，已改为 VC 自营');

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
      platform,
      action,
      delaySec: num(v.publish.delaySec, d.publish.delaySec, { min: 0, max: 600 }, '发布间隔'),
      maxMainImages: num(v.publish.maxMainImages, d.publish.maxMainImages, { min: 1, max: 10 }, '主图数量'),
      maxDetailImages: num(v.publish.maxDetailImages, d.publish.maxDetailImages, { min: 0, max: 50 }, '详情图数量'),
      reuploadDetailImages: Boolean(v.publish.reuploadDetailImages),
      fillSkuAttrs: Boolean(v.publish.fillSkuAttrs),
      defaultUpc: validDefaultUpc(v.publish.defaultUpc, errors),
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

/** 默认 UPC：留空表示不使用；填了但不是有效条形码（8~14 位数字、校验位正确）时恢复默认 */
function validDefaultUpc(input, errors) {
  if (String(input ?? '').trim() === '') return '';
  const code = normalizeUpc(input);
  if (code) return code;
  errors.push('默认 UPC 应为 8~14 位数字的有效条形码（校验位正确），已恢复默认');
  return DEFAULT_SETTINGS.publish.defaultUpc;
}

function validatePriceWatch(pw, num, errors) {
  const d = DEFAULT_SETTINGS.priceWatch;
  const minDelay = num(pw.minDelaySec, d.minDelaySec, { min: 2, max: 600 }, '价格检查最小间隔');
  let maxDelay = num(pw.maxDelaySec, d.maxDelaySec, { min: 2, max: 1200 }, '价格检查最大间隔');
  if (maxDelay < minDelay) {
    errors.push('价格检查的最大间隔不能小于最小间隔');
    maxDelay = minDelay;
  }
  const rawUrl = String(pw.editUrlTemplate ?? '').trim();
  const derived = deriveEditUrlTemplate(rawUrl);
  if (rawUrl && !derived) errors.push(`商品编辑页地址无效，已清空：${EDIT_URL_RULE}`);
  const repriceAction = Object.hasOwn(REPRICE_ACTIONS, pw.repriceAction) ? pw.repriceAction : d.repriceAction;
  if (repriceAction !== pw.repriceAction) errors.push('改价后的动作无效，已改为自动');
  return {
    minDelaySec: minDelay,
    maxDelaySec: maxDelay,
    alertMargin: num(pw.alertMargin, d.alertMargin, { min: 0, max: 100000 }, '价格预警线'),
    editUrlTemplate: derived?.template ?? '',
    repriceAction,
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
