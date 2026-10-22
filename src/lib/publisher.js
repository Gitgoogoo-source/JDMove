// 发布：类目定位 -> 打开发布页 -> 按计划逐项填写 -> 执行保存/提交
import { buildPublishPlan, descriptionHtml, publishImagePlan } from '../shared/publish-plan.js';
import { searchBestCategory, matchCategoryMap } from '../shared/category-pick.js';
import { buildPublishUrl, imgzoneUrl } from '../shared/url-utils.js';
import { callBackend, openWorkTab, navigateTab, closeTab, sleep, waitForTabUrl } from './chrome-env.js';
import { CATEGORY_PAGE, CATEGORY_REDIRECT_MSG, landedPageKind } from './category-search.js';
import { startImagePrep } from './image-prep.js';
import { createStopwatch } from '../shared/stopwatch.js';
import { parseWareId } from '../shared/price-watch.js';
import { describeSkuAttrResults, formatMissingRows, missingSkuAttrs, skuAttrStop } from '../shared/sku-attrs.js';

const LOGIN_MSG = '商家后台需要重新登录';
const DETAIL_CHUNK = 6;
// 提交成功后京麦整页跳到 /ware/publish-success?wareId=<店铺商品编号>
const SUCCESS_PAGE_RE = /\/publish-success\b/;
const LAND_TIMEOUT_MS = 5000;

async function waitReady(tabId, timeoutMs = 40000) {
  const end = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < end) {
    last = await callBackend(tabId, 'status').catch(() => null);
    if (last && last.ready) return last;
    if (last && last.loginRequired) return last;
    await sleep(1000);
  }
  return last ?? { ready: false };
}

/** 在类目选择页按多个关键词搜索，汇总结果后自动挑选 */
function searchCategory(tabId, product, log) {
  return searchBestCategory((kw) => callBackend(tabId, 'searchCategory', kw), product, log);
}

/** 手动指定或类目映射得到的目标类目；都没有时返回 null，需要到类目选择页自动搜索 */
function presetCategory(item, settings) {
  if (item.edits?.cateList?.length) return { cateList: item.edits.cateList, name: item.edits.cateName || '手动指定', from: 'manual' };
  const mapped = matchCategoryMap(settings.categoryMap, item.product.crumbs);
  if (mapped) return { cateList: mapped.cateList, name: mapped.name || mapped.source, from: 'map' };
  return null;
}

/** 在类目选择页自动搜索；京麦把类目页跳到别处时直接返回原因，不再从发布页来回跳转 */
async function autoCategory(tabId, product, log) {
  const kind = await landedPageKind(tabId);
  if (kind === 'login') return { error: LOGIN_MSG };
  if (kind !== 'category') return { error: CATEGORY_REDIRECT_MSG };
  const target = await searchCategory(tabId, product, log);
  return target ? { target } : { error: `未找到匹配类目（源类目：${product.crumbs.join(' > ')}），请在编辑中指定` };
}

async function fillDescription(tabId, plan, settings, log, { timer, images }) {
  // 源商品没有详情图时发布计划已经拦下；走到这里说明设置里的详情图数量为 0
  if (!plan.detailImageUrls.length) {
    log('详情图数量设置为 0，跳过商品详情');
    return;
  }
  let urls = plan.detailImageUrls;
  if (settings.publish.reuploadDetailImages) {
    const slices = await images.detail;
    timer.lap('等待详情图处理');
    const uploaded = [];
    for (let i = 0; i < slices.length; i += DETAIL_CHUNK) {
      const res = await callBackend(tabId, 'uploadDetailImages', slices.slice(i, i + DETAIL_CHUNK));
      if (res?.errors?.length) log(`详情图上传问题：${res.errors.join('；')}`);
      if (!res?.ok) throw new Error(res?.error || '详情图上传失败');
      uploaded.push(...res.urls);
    }
    urls = uploaded.map(imgzoneUrl);
    timer.lap('详情图上传');
    log(`详情图已转存 ${urls.length} 张`);
  }
  const desc = await callBackend(tabId, 'setDescriptionHtml', descriptionHtml(urls));
  timer.lap('详情写入');
  if (!desc?.ok) throw new Error(desc?.error || '商品详情写入失败');
  if (desc.direct) log('详情编辑器没有同步内容，已直接写入表单，请在页面上核对商品详情');
}

/** 标题、品牌、属性；品牌没选上时返回 needAction */
async function fillBasics(tabId, plan, log, timer) {
  const basics = await callBackend(tabId, 'setBasics', { title: plan.title, weightKg: plan.weightKg, packList: plan.packList });
  timer.lap('标题');
  if (!basics?.ok) throw new Error('标题填写失败');
  log(`标题：${basics.report.title}`);

  const brand = await callBackend(tabId, 'selectBrand', plan.brand);
  timer.lap('品牌');
  if (!brand?.ok) return { needAction: brand?.error || '品牌选择失败' };
  log(`品牌：${brand.label}`);

  const upc = await callBackend(tabId, 'setUpcCode', plan.upc);
  if (upc?.present) log(upc.value ? `商品条形码：${upc.value}` : '商品条形码：没有可填的值');

  const props = await callBackend(tabId, 'setProps', plan.props.values);
  timer.lap('属性');
  if (!props?.ok) log(`部分属性写入异常：${props?.failed?.join(',')}`);
  const unmatched = plan.props.report.filter((r) => r.status === 'unmatched' || (r.status === 'missing' && r.value == null));
  if (unmatched.length) log(`未填属性：${unmatched.map((r) => r.title).join('、')}`);
  return {};
}

async function fillMainImages(tabId, log, { timer, images }) {
  const mains = await images.main;
  timer.lap('等待主图处理');
  const up = await callBackend(tabId, 'uploadMainImages', mains);
  timer.lap('主图上传');
  if (up?.errors?.length) log(`主图问题：${up.errors.join('；')}`);
  if (!up?.ok) throw new Error(up?.error || '主图上传失败');
  log(`主图 ${up.urls.length} 张`);
}

/**
 * 保存前填写 SKU属性并按表单数据核对：京麦在填写过程中会重建 SKU 表、清空已填的 SKU属性（页面上看不出来），
 * 所以放在最后一步填，空了重填一次；仍为空就返回停止原因，不带着空的必填项保存
 * @returns {Promise<{stop?: {status: string, message: string}}>}
 */
async function ensureSkuAttrs(tabId, plan, log, timer) {
  const enabled = plan.sale.rows.map((r) => r.enabled);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const drawers = await callBackend(tabId, 'fillSkuAttrDrawers', plan.skuAttrValues);
    timer.lap(attempt ? 'SKU 属性重填' : 'SKU 属性');
    describeSkuAttrResults(drawers?.results).forEach((line) => log(line));
    const state = await callBackend(tabId, 'readSkuAttrState');
    if (!state?.ok) {
      log(`无法核对 SKU属性：${state?.error || '页面没有返回数据'}`);
      return {};
    }
    const missing = missingSkuAttrs(state, enabled);
    if (!missing.length) return {};
    if (attempt === 0) log(`保存前核对：SKU属性必填项为空（${formatMissingRows(missing)}），重新填写一次`);
    else return { stop: skuAttrStop(missing, plan.skuAttrValues) };
  }
  return {};
}

const EMPTY_UPC_MSG = '请在「编辑 → UPC」中填写商品条形码，或在设置里填写「默认 UPC」';

/**
 * SKU 表核对结果对应的停止原因：值没写进去/被清空算失败；必填的商品条形码为空（计划里没有可填的值）需要用户补
 * @param {{missing?: {row: number}[], emptyUpc?: number[]} | undefined} check setSkuRows / checkSkuRows 的结果
 * @param {string} when 发生在哪一步，写进提示里
 * @returns {{status: 'failed'|'need_action', message: string} | null}
 */
function skuTableStop(check, when) {
  const rowList = (rows) => rows.map((r) => r + 1).join('、');
  if (check?.missing?.length) {
    return { status: 'failed', message: `${when}SKU 表第 ${rowList(check.missing.map((m) => m.row))} 行的京东价/库存/商品条形码没有写进去或被清空，已停止保存，请在工作窗口中检查` };
  }
  if (check?.emptyUpc?.length) {
    return { status: 'need_action', message: `SKU 表第 ${rowList(check.emptyUpc)} 行的商品条形码为空（必填），已停止保存；${EMPTY_UPC_MSG}` };
  }
  return null;
}

/**
 * 保存前重写并核对基本信息里的商品条形码（upcCode）：没有可填的值时需要用户补，写不进去算失败
 * @returns {Promise<{status: 'failed'|'need_action', message: string} | null>}
 */
async function upcCodeStop(tabId, plan) {
  const res = await callBackend(tabId, 'setUpcCode', plan.upc);
  if (!res?.present) return null;
  if (!res.value) return { status: 'need_action', message: `商品基本信息的商品条形码为空（必填），已停止保存；${EMPTY_UPC_MSG}` };
  if (!res.ok) return { status: 'failed', message: `商品基本信息的商品条形码没有写进去（页面上是“${res.value}”），已停止保存，请在工作窗口中检查` };
  return null;
}

async function fillForm(tabId, settings, plan, log, ctx) {
  const { timer } = ctx;
  const basics = await fillBasics(tabId, plan, log, timer);
  if (basics.needAction) return basics;
  await fillMainImages(tabId, log, ctx);

  const sale = await callBackend(tabId, 'setSaleValues', plan.sale.dims);
  timer.lap('销售属性');
  // 规格值没生效时京麦稍后会重建 SKU 表，京东价/库存被清空：直接停下，不带着空价格保存
  if (sale?.uncommitted?.length) throw new Error(`销售属性值没有生效：${sale.uncommitted.join(',')}`);
  if (!sale?.ok) log(`销售属性写入失败：${sale?.failed?.join(',')}`);
  const rows = await callBackend(tabId, 'setSkuRows', plan.sale.rows);
  timer.lap('SKU 表');
  if (!rows?.ok) log(`SKU 表：${rows?.issues?.join('；')}`);
  log(`SKU ${rows?.rows ?? 0} 行`);

  await fillDescription(tabId, plan, settings, log, ctx);
  return {};
}

/**
 * 点保存/提交按钮。提交成功后京麦马上整页跳到成功页，页面脚本可能来不及返回结果（或返回了但没带编号）：
 * 这时以落地的成功页为准，编号从地址里的 wareId 读。保存草稿不跳转，不等
 */
async function submitAction(tabId, action, landTimeoutMs) {
  let result;
  let error;
  try {
    result = await callBackend(tabId, 'runAction', action);
  } catch (e) {
    error = e;
  }
  const hasId = result?.ok && parseWareId({ captured: result.wareIds, url: result.url, messages: result.messages });
  if (action === 'draft' || hasId || (result && !result.ok)) return result;
  const url = await waitForTabUrl(tabId, SUCCESS_PAGE_RE, landTimeoutMs);
  if (url) {
    const messages = result?.messages?.length ? result.messages : ['商品提交成功'];
    return { ...result, ok: true, url, messages, errors: [], confirmText: '', wareIds: result?.wareIds ?? [] };
  }
  if (error) throw error;
  return result;
}

/**
 * 发布单个条目
 * @param {{imageMakers?: {main?: Function, detail?: Function}, landTimeoutMs?: number}} [deps]
 *   imageMakers：图片处理函数；landTimeoutMs：提交后等待跳到成功页的时间（测试时替换）
 * @returns {Promise<{status: 'published'|'filled'|'need_action'|'failed', message: string, target?: object, tabId?: number,
 *   price?: number, wareId?: string}>} price：发布的售价；wareId：店铺商品编号（拿得到时）
 */
export async function publishItem(item, settings, log, { imageMakers, landTimeoutMs = LAND_TIMEOUT_MS } = {}) {
  if (!item.product) return { status: 'need_action', message: '尚未采集' };
  const preset = presetCategory(item, settings);
  let startUrl;
  try {
    // 已知类目时直接打开发布页，省掉一次类目页 -> 发布页的跳转
    startUrl = preset ? buildPublishUrl(preset) : CATEGORY_PAGE;
  } catch (e) {
    return { status: 'failed', message: e.message };
  }
  const timer = createStopwatch();
  const images = startImagePrep(
    { sku: item.skuId, ...publishImagePlan({ product: item.product, edits: item.edits, settings }), reuploadDetail: settings.publish.reuploadDetailImages },
    { log, timer, makers: imageMakers },
  );
  let tab;
  try {
    tab = await openWorkTab(startUrl);
  } catch (e) {
    images.cancel();
    throw e;
  }
  timer.lap('打开页面');
  const result = await publishInTab(tab, item, settings, log, preset, { timer, images, landTimeoutMs });
  images.cancel();
  log(`耗时：${timer.summary()}`);
  // 需要人工检查的情况保留标签页，其余关闭
  if (!result.tabId) await closeTab(tab.id);
  return result;
}

async function publishInTab(tab, item, settings, log, preset, ctx) {
  const { timer } = ctx;
  try {
    let target = preset;
    if (!target) {
      const auto = await autoCategory(tab.id, item.product, log);
      if (auto.error) return { status: 'need_action', message: auto.error };
      target = auto.target;
    }
    log(`目标类目：${target.name} [${target.cateList.join(',')}]`);
    if (!preset) {
      await navigateTab(tab.id, buildPublishUrl(target));
      timer.lap('选类目');
    }

    const landed = await landedPageKind(tab.id);
    if (landed === 'login') return { status: 'need_action', message: LOGIN_MSG, target };
    if (landed !== 'publish') return { status: 'failed', message: '发布页没有打开（类目可能不是末级或无权限）', target };
    const st = await waitReady(tab.id);
    if (st.loginRequired) return { status: 'need_action', message: LOGIN_MSG, target };
    if (!st.ready) return { status: 'failed', message: '发布页未就绪（类目可能不是末级或无权限）', target };
    if (st.publishDisabled) log(`注意：${st.publishDisabledMsg}`);
    timer.lap('页面就绪');

    const schema = await callBackend(tab.id, 'getFormSchema');
    if (!schema?.ok) throw new Error(schema?.error || '读取表单结构失败');
    const plan = buildPublishPlan({ product: item.product, edits: item.edits, settings, schema });
    plan.warnings.forEach((w) => log(w));
    if (plan.blockers.length) return { status: 'need_action', message: plan.blockers.join('；'), target };

    const filled = await fillForm(tab.id, settings, plan, log, ctx);
    if (filled.needAction) return { status: 'need_action', message: filled.needAction, target };

    // 京麦可能在填写过程中重建 SKU 表、清空京东价/库存/商品条形码：保存前重写一遍并核对，写不进去就不保存
    const skuCheck = await callBackend(tab.id, 'setSkuRows', plan.sale.rows);
    timer.lap('SKU 核对');
    const tableStop = skuTableStop(skuCheck, '');
    if (tableStop) return { ...tableStop, target, tabId: tab.id };
    if (settings.publish.fillSkuAttrs) {
      const attrs = await ensureSkuAttrs(tab.id, plan, log, timer);
      if (attrs.stop) return { ...attrs.stop, target, tabId: tab.id };
      const afterAttrs = skuTableStop(await callBackend(tab.id, 'checkSkuRows', plan.sale.rows), '填写 SKU属性后');
      if (afterAttrs) return { ...afterAttrs, target, tabId: tab.id };
    }
    const upcStop = await upcCodeStop(tab.id, plan);
    if (upcStop) return { ...upcStop, target, tabId: tab.id };

    const action = settings.publish.action;
    if (action === 'none') return { status: 'filled', message: '已填写完成，请在工作窗口中检查后手动提交', target, tabId: tab.id };
    const result = await submitAction(tab.id, action, ctx.landTimeoutMs);
    timer.lap('保存');
    if (result?.confirmText) return { status: 'need_action', message: `页面弹出确认：${result.confirmText}`, target, tabId: tab.id };
    if (!result?.ok) {
      const detail = [result?.error, ...(result?.errors ?? []), ...(result?.messages ?? [])].filter(Boolean).join('；');
      return { status: 'failed', message: detail || '提交未成功', target, tabId: tab.id };
    }
    const wareId = parseWareId({ captured: result.wareIds, url: result.url, messages: result.messages });
    log(wareId ? `店铺商品编号：${wareId}` : '没有拿到店铺商品编号：以后改价前请在“编辑”中填写');
    return { status: 'published', message: (result.messages ?? []).join('；') || '完成', target, price: plan.price, wareId };
  } catch (e) {
    return { status: 'failed', message: e.message, tabId: tab.id };
  }
}
