// 发布：类目定位 -> 打开发布页 -> 按计划逐项填写 -> 执行保存/提交
import { buildPublishPlan, descriptionHtml } from '../shared/publish-plan.js';
import { searchBestCategory, matchCategoryMap } from '../shared/category-pick.js';
import { buildPublishUrl, imgzoneUrl } from '../shared/url-utils.js';
import { callBackend, openWorkTab, navigateTab, closeTab, sleep } from './chrome-env.js';
import { CATEGORY_PAGE, CATEGORY_REDIRECT_MSG, landedPageKind } from './category-search.js';
import { makeMainImage, makeDetailImages } from './images.js';

const LOGIN_MSG = '商家后台需要重新登录';
const DETAIL_CHUNK = 6;
const MAX_DETAIL_SLICES = 40;

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

async function processImages(urls, maker, log) {
  const out = [];
  for (const [i, url] of urls.entries()) {
    try {
      const made = await maker(url, i);
      out.push(...(Array.isArray(made) ? made : [made]));
    } catch (e) {
      log(`图片处理失败：${e.message}`);
    }
  }
  return out;
}

async function fillDescription(tabId, plan, settings, sku, log) {
  if (!plan.detailImageUrls.length) {
    log('源商品没有详情图，跳过商品详情');
    return;
  }
  let urls = plan.detailImageUrls;
  if (settings.publish.reuploadDetailImages) {
    const stamp = Date.now() % 1e6;
    const slices = (await processImages(urls, (u, i) => makeDetailImages(u, `jdmove_${sku}_d${i}_${stamp}`), log)).slice(0, MAX_DETAIL_SLICES);
    const uploaded = [];
    for (let i = 0; i < slices.length; i += DETAIL_CHUNK) {
      const res = await callBackend(tabId, 'uploadDetailImages', slices.slice(i, i + DETAIL_CHUNK));
      if (res?.errors?.length) log(`详情图上传问题：${res.errors.join('；')}`);
      if (!res?.ok) throw new Error(res?.error || '详情图上传失败');
      uploaded.push(...res.urls);
    }
    urls = uploaded.map(imgzoneUrl);
    log(`详情图已转存 ${urls.length} 张`);
  }
  const desc = await callBackend(tabId, 'setDescriptionHtml', descriptionHtml(urls));
  if (!desc?.ok) throw new Error(desc?.error || '商品详情写入失败');
  if (desc.direct) log('详情编辑器没有同步内容，已直接写入表单，请在页面上核对商品详情');
}

async function fillForm(tabId, item, settings, plan, log) {
  const sku = item.skuId;
  const basics = await callBackend(tabId, 'setBasics', { title: plan.title, weightKg: plan.weightKg, packList: plan.packList });
  if (!basics?.ok) throw new Error('标题填写失败');
  log(`标题：${basics.report.title}`);

  const brand = await callBackend(tabId, 'selectBrand', plan.brand);
  if (!brand?.ok) return { needAction: brand?.error || '品牌选择失败' };
  log(`品牌：${brand.label}`);

  const props = await callBackend(tabId, 'setProps', plan.props.values);
  if (!props?.ok) log(`部分属性写入异常：${props?.failed?.join(',')}`);
  const unmatched = plan.props.report.filter((r) => r.status === 'unmatched' || (r.status === 'missing' && r.value == null));
  if (unmatched.length) log(`未填属性：${unmatched.map((r) => r.title).join('、')}`);

  const mains = await processImages(plan.mainImageUrls, (u, i) => makeMainImage(u, `jdmove_${sku}_m${i}.jpg`), log);
  const up = await callBackend(tabId, 'uploadMainImages', mains);
  if (up?.errors?.length) log(`主图问题：${up.errors.join('；')}`);
  if (!up?.ok) throw new Error(up?.error || '主图上传失败');
  log(`主图 ${up.urls.length} 张`);

  const sale = await callBackend(tabId, 'setSaleValues', plan.sale.dims);
  // 规格值没生效时京麦稍后会重建 SKU 表，京东价/库存被清空：直接停下，不带着空价格保存
  if (sale?.uncommitted?.length) throw new Error(`销售属性值没有生效：${sale.uncommitted.join(',')}`);
  if (!sale?.ok) log(`销售属性写入失败：${sale?.failed?.join(',')}`);
  const rows = await callBackend(tabId, 'setSkuRows', plan.sale.rows);
  if (!rows?.ok) log(`SKU 表：${rows?.issues?.join('；')}`);
  log(`SKU ${rows?.rows ?? 0} 行`);
  if (settings.publish.fillSkuAttrs) {
    const drawers = await callBackend(tabId, 'fillSkuAttrDrawers', plan.skuAttrValues);
    const miss = (drawers?.results ?? []).flatMap((r) => r.missing ?? []);
    if (miss.length) log(`SKU属性未填：${[...new Set(miss)].join('、')}`);
  }

  await fillDescription(tabId, plan, settings, sku, log);
  return {};
}

/**
 * 发布单个条目
 * @returns {Promise<{status: 'published'|'filled'|'need_action'|'failed', message: string, target?: object, tabId?: number}>}
 */
export async function publishItem(item, settings, log) {
  if (!item.product) return { status: 'need_action', message: '尚未采集' };
  const preset = presetCategory(item, settings);
  let startUrl;
  try {
    // 已知类目时直接打开发布页，省掉一次类目页 -> 发布页的跳转
    startUrl = preset ? buildPublishUrl(preset) : CATEGORY_PAGE;
  } catch (e) {
    return { status: 'failed', message: e.message };
  }
  const tab = await openWorkTab(startUrl);
  const result = await publishInTab(tab, item, settings, log, preset);
  // 需要人工检查的情况保留标签页，其余关闭
  if (!result.tabId) await closeTab(tab.id);
  return result;
}

async function publishInTab(tab, item, settings, log, preset) {
  try {
    let target = preset;
    if (!target) {
      const auto = await autoCategory(tab.id, item.product, log);
      if (auto.error) return { status: 'need_action', message: auto.error };
      target = auto.target;
    }
    log(`目标类目：${target.name} [${target.cateList.join(',')}]`);
    if (!preset) await navigateTab(tab.id, buildPublishUrl(target));

    const landed = await landedPageKind(tab.id);
    if (landed === 'login') return { status: 'need_action', message: LOGIN_MSG, target };
    if (landed !== 'publish') return { status: 'failed', message: '发布页没有打开（类目可能不是末级或无权限）', target };
    const st = await waitReady(tab.id);
    if (st.loginRequired) return { status: 'need_action', message: LOGIN_MSG, target };
    if (!st.ready) return { status: 'failed', message: '发布页未就绪（类目可能不是末级或无权限）', target };
    if (st.publishDisabled) log(`注意：${st.publishDisabledMsg}`);

    const schema = await callBackend(tab.id, 'getFormSchema');
    if (!schema?.ok) throw new Error(schema?.error || '读取表单结构失败');
    const plan = buildPublishPlan({ product: item.product, edits: item.edits, settings, schema });
    plan.warnings.forEach((w) => log(w));
    if (plan.blockers.length) return { status: 'need_action', message: plan.blockers.join('；'), target };

    const filled = await fillForm(tab.id, item, settings, plan, log);
    if (filled.needAction) return { status: 'need_action', message: filled.needAction, target };

    // 京麦可能在填写过程中重建 SKU 表、清空京东价和库存：保存前重写一遍并核对，写不进去就不保存
    const skuCheck = await callBackend(tab.id, 'setSkuRows', plan.sale.rows);
    if (skuCheck?.missing?.length) {
      return { status: 'failed', message: `SKU 表的京东价/库存没有写进去，已停止保存：${skuCheck.issues.join('；')}`, target, tabId: tab.id };
    }

    const action = settings.publish.action;
    if (action === 'none') return { status: 'filled', message: '已填写完成，请在工作窗口中检查后手动提交', target, tabId: tab.id };
    const result = await callBackend(tab.id, 'runAction', action);
    if (result?.confirmText) return { status: 'need_action', message: `页面弹出确认：${result.confirmText}`, target, tabId: tab.id };
    if (!result?.ok) {
      const detail = [result?.error, ...(result?.errors ?? []), ...(result?.messages ?? [])].filter(Boolean).join('；');
      return { status: 'failed', message: detail || '提交未成功', target, tabId: tab.id };
    }
    return { status: 'published', message: (result.messages ?? []).join('；') || '完成', target };
  } catch (e) {
    return { status: 'failed', message: e.message, tabId: tab.id };
  }
}
