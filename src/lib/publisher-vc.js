// VC 自营发布：源商品的类目/品牌 → 直接打开 VC 发布页 → 按计划逐项填写 → 页面本地校验 → 保存草稿（不点“发布商品”）。
// POP 的流程在 publisher.js，两边只共用详情写入（同一个详情编辑器）
import { buildVcPublishPlan, vcPreflight, vcTarget, vcActionLabel } from '../shared/vc-plan.js';
import { buildVcPublishUrl } from '../shared/url-utils.js';
import { callVcBackend, openWorkTab, closeTab, sleep, waitForTabUrl } from './chrome-env.js';
import { landedPageKind } from './category-search.js';
import { startImagePrep } from './image-prep.js';
import { fillDescription } from './publisher.js';
import { createStopwatch } from '../shared/stopwatch.js';
import { parseWareId } from '../shared/price-watch.js';
import { detectSaveThrottle } from '../shared/publish-throttle.js';

const LOGIN_MSG = '商家后台需要重新登录';
const NOT_OPENED_MSG = 'VC 发布页没有打开：品牌可能没有授权，或类目不在账号的产品线里（可在「编辑」中指定类目ID和品牌ID）';
const LAND_TIMEOUT_MS = 5000;
// 提交成功后页面可能整页跳走（成功页的地址还没核实过）：只认路径里带 success 的一段，不认查询参数
const SUCCESS_PAGE_RE = /^https:\/\/[^/?#]+\/(?:[^?#]*\/)?[\w-]*success[\w-]*(?:[/?#]|$)/i;
// 这些字段没写进去就不能提交
const CRITICAL_FIELDS = ['标题', '型号', '市场价', '京东价', '采购价', '长', '宽', '高', '毛重'];

async function waitVcReady(tabId, timeoutMs = 40000) {
  const end = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < end) {
    last = await callVcBackend(tabId, 'vcStatus').catch(() => null);
    if (last && (last.ready || last.loginRequired)) return last;
    await sleep(1000);
  }
  return last ?? { ready: false };
}

const stop = (status, message) => ({ stop: { status, message } });

async function fillFields(tabId, plan, log, timer) {
  const res = await callVcBackend(tabId, 'vcSetFields', { title: plan.title, model: plan.model, prices: plan.prices, logistics: plan.logistics });
  timer.lap('基本信息与物流');
  if (res?.skipped?.length) log(`页面上没有这些字段，已跳过：${res.skipped.join('、')}`);
  const failed = res?.failed ?? ['表单未就绪'];
  if (failed.some((f) => CRITICAL_FIELDS.some((c) => f.startsWith(c)))) return stop('failed', `这些字段没有写进去：${failed.join('、')}`);
  if (failed.length) log(`部分字段没有写进去：${failed.join('、')}`);
  log(`标题：${plan.title}`);
  log(`价格：市场价 ¥${plan.prices.marketPrice} / 京东价 ¥${plan.prices.jdPrice} / 采购价 ¥${plan.prices.costPrice}`);
  if (plan.erpCode) {
    const erp = await callVcBackend(tabId, 'vcSetErp', plan.erpCode);
    timer.lap('采购员/销售员');
    if (!erp?.ok) return stop('need_action', `采购员/销售员 ERP 填写失败：${(erp?.errors ?? ['页面没有返回结果']).join('；')}`);
    log(erp.people.join('，'));
  }
  const props = await callVcBackend(tabId, 'setProps', plan.props.values);
  timer.lap('属性');
  if (!props?.ok) log(`部分属性写入异常：${props?.failed?.join(',')}`);
  const unmatched = plan.props.report.filter((r) => r.status === 'unmatched' || (r.status === 'missing' && r.value == null));
  if (unmatched.length) log(`未填属性：${unmatched.map((r) => r.title).join('、')}`);
  return {};
}

/** 方图（上传）→ 透图（上传 PNG）→ 图片信息识别（勾选刚传的第一张主图） */
async function fillImages(tabId, log, { timer, images }) {
  const mains = await images.main;
  timer.lap('等待主图处理');
  if (!mains.length) return stop('failed', '主图处理失败，没有可上传的图片');
  const main = await callVcBackend(tabId, 'vcPutImages', { field: 'imageList', images: mains });
  timer.lap('方图上传');
  if (!main?.ok) return stop('failed', `方图上传失败：${(main?.errors ?? []).join('；') || '页面没有返回结果'}`);
  log(`方图 ${main.count} 张`);
  const png = await images.transparent;
  if (!png) return stop('need_action', '透图生成失败（见日志），请在发布页手动上传 1 张透明底 PNG');
  const transparent = await callVcBackend(tabId, 'vcPutImages', { field: 'transparentImageList', images: [png] });
  timer.lap('透图上传');
  if (!transparent?.ok) return stop('failed', `透图上传失败：${(transparent?.errors ?? []).join('；') || '页面没有返回结果'}`);
  log('透图：由第一张主图自动去掉白底生成，请在页面上核对效果');
  const rec = await callVcBackend(tabId, 'vcPutImages', { field: 'aiRecImages', names: [mains[0].name] });
  timer.lap('图片信息识别');
  if (!rec?.ok) return stop('failed', `图片信息识别没有放上图片：${(rec?.errors ?? []).join('；') || '页面没有返回结果'}`);
  return {};
}

/**
 * 图片信息识别：图片放好后点“开始识别”并选“补充数据”（已填的不动，只补空白字段）。
 * 不识别的话点“发布商品”会被页面拦下（请先进行图片识别）。放在详情和 SKU 之前：识别会补填 SKU 行的空白列，后面的步骤再按计划覆盖
 */
async function recognizeImages(tabId, plan, log, timer) {
  const rec = await callVcBackend(tabId, 'vcRecognize', { text: plan.title });
  timer.lap('图片识别');
  if (!rec?.ok) {
    const why = (rec?.errors ?? []).join('；') || '页面没有返回结果';
    return stop('need_action', `图片信息识别没有完成（${why}），请在发布页点“开始识别”→“补充数据”后再发布`);
  }
  if (!rec.already) log('图片信息识别：已识别（补充数据，已填内容不变，请核对页面自动补上的字段）');
  return {};
}

const drawerNote = (r) => [r?.missing?.length ? `必填项没填：${r.missing.join('、')}` : '', ...(r?.errors ?? [])].filter(Boolean).join('；');

/** SKU 表（单行）：规格（选填，填不好跳过）→ 商品名称、条形码 → SKU属性（必填） */
async function fillSku(tabId, plan, settings, log, timer) {
  const ctx = { values: plan.skuAttrValues, units: plan.skuAttrUnits, desc: plan.sku.spec.desc };
  if (plan.sku.spec.text) {
    const spec = await callVcBackend(tabId, 'vcFillSpec', ctx);
    timer.lap('规格');
    if (spec?.confirmed) log(`规格：已填写 ${spec.filled.join('、')}`);
    else log(`规格没有填好（${drawerNote(spec) || '抽屉没有关上'}），已跳过：单规格商品可以不填，商品名称里已带上规格`);
  }
  const row = await callVcBackend(tabId, 'vcSetSkuRow', { name: plan.sku.name, upc: plan.sku.upc });
  timer.lap('SKU 商品名称/条形码');
  if (!row?.ok) return stop('failed', `SKU 表没有写好：${(row?.errors ?? []).join('；')}`);
  log(`SKU 商品名称：${plan.sku.name}`);
  if (row.upcNotice) log(`商品条形码 ${plan.sku.upc}：${row.upcNotice}`);
  if (settings.publish.fillSkuAttrs) {
    const attrs = await callVcBackend(tabId, 'vcFillSkuAttrs', ctx);
    timer.lap('SKU属性');
    if (!attrs?.confirmed) {
      return stop('need_action', `SKU属性没有填好（${drawerNote(attrs) || '抽屉没有关上'}），请在「编辑 → 属性覆盖」中补充后重新发布`);
    }
    log(`SKU属性：已填写 ${attrs.filled.join('、')}`);
  }
  // 填抽屉时页面可能重建这一行：名称被清空就再写一次
  const state = await callVcBackend(tabId, 'vcSkuRowState');
  if (state?.ok && state.skuName !== plan.sku.name) await callVcBackend(tabId, 'vcSetSkuRow', { name: plan.sku.name });
  return {};
}

async function fillVcForm(tabId, plan, settings, log, ctx) {
  for (const step of [
    () => fillFields(tabId, plan, log, ctx.timer),
    () => fillImages(tabId, log, ctx),
    () => recognizeImages(tabId, plan, log, ctx.timer),
    () => fillDescription(tabId, { detailImageUrls: plan.images.detailImageUrls }, settings, log, ctx).then(() => ({})),
    () => fillSku(tabId, plan, settings, log, ctx.timer),
  ]) {
    const res = await step();
    if (res.stop) return res;
  }
  return {};
}

/** 点“发布商品”/“保存草稿”；页面整页跳走、脚本来不及返回时按落地地址判断 */
async function submitVc(tabId, action, landTimeoutMs) {
  let result;
  let error;
  try {
    result = await callVcBackend(tabId, 'runAction', action);
  } catch (e) {
    error = e;
  }
  if (action === 'vc_draft' || (result && (result.ok || result.confirmText || result.errors?.length))) return result;
  const url = await waitForTabUrl(tabId, SUCCESS_PAGE_RE, landTimeoutMs);
  if (url) return { ...result, ok: true, url, messages: result?.messages?.length ? result.messages : ['商品已提交'], errors: [], confirmText: '' };
  if (error) throw error;
  return result;
}

function submitOutcome(result, plan, target, tabId, log, action) {
  const throttle = !result?.ok && detectSaveThrottle({ responses: result?.saveResponses, messages: result?.messages, confirmText: result?.confirmText });
  if (throttle) {
    log(`${throttle.message}，已关闭发布页`);
    return { status: 'throttle', message: throttle.message, target };
  }
  if (result?.confirmText) return { status: 'need_action', message: `页面弹出确认：${result.confirmText}`, target, tabId };
  if (!result?.ok) {
    const detail = [result?.error, ...(result?.errors ?? []), ...(result?.messages ?? [])].filter(Boolean).join('；');
    return { status: 'failed', message: detail || '提交未成功', target, tabId };
  }
  if (action === 'vc_draft') {
    log('已保存草稿：请到 VC 后台草稿箱检查后手动提交');
    return { status: 'published', message: (result.messages ?? []).join('；') || '已保存草稿', target, price: plan.prices.jdPrice };
  }
  const wareId = parseWareId({ captured: result.wareIds, url: result.url, messages: result.messages });
  log(wareId ? `商品编号：${wareId}` : '没有拿到商品编号（VC 商品提交后进入采销审核）');
  return { status: 'published', message: (result.messages ?? []).join('；') || '已提交', target, price: plan.prices.jdPrice, wareId };
}

async function publishInVcTab(tab, item, settings, log, target, ctx) {
  try {
    log(`目标类目：${target.name} [${target.cateList.join(',')}]，品牌ID ${target.brandId}`);
    const landed = await landedPageKind(tab.id);
    if (landed === 'login') return { status: 'need_action', message: LOGIN_MSG, target };
    if (landed !== 'publish') return { status: 'failed', message: NOT_OPENED_MSG, target };
    const st = await waitVcReady(tab.id);
    if (st.loginRequired) return { status: 'need_action', message: LOGIN_MSG, target };
    if (!st.ready) return { status: 'failed', message: 'VC 发布页未就绪（类目可能不是末级或不在产品线里）', target };
    if (st.publishDisabled) log(`注意：${st.publishDisabledMsg}`);
    ctx.timer.lap('页面就绪');

    const schema = await callVcBackend(tab.id, 'getFormSchema');
    if (!schema?.ok) throw new Error(schema?.error || '读取表单结构失败');
    const plan = buildVcPublishPlan({ product: item.product, edits: item.edits, settings, schema });
    plan.warnings.forEach((w) => log(w));
    if (plan.blockers.length) return { status: 'need_action', message: plan.blockers.join('；'), target };

    const filled = await fillVcForm(tab.id, plan, settings, log, ctx);
    if (filled.stop) return { ...filled.stop, target, tabId: tab.id };
    const check = await callVcBackend(tab.id, 'vcValidate');
    ctx.timer.lap('页面校验');
    if (!check?.ok) return { status: 'failed', message: `页面校验没通过：${(check?.errors ?? []).join('；')}`, target, tabId: tab.id };

    const action = vcActionLabel(settings.publish.action);
    if (!action) return { status: 'filled', message: '已填写完成，请在工作窗口中检查后手动点“保存草稿”或“发布商品”', target, tabId: tab.id };
    const result = await submitVc(tab.id, action, ctx.landTimeoutMs);
    ctx.timer.lap(action === 'vc_draft' ? '保存草稿' : '发布商品');
    return submitOutcome(result, plan, target, tab.id, log, action);
  } catch (e) {
    return { status: 'failed', message: e.message, target, tabId: tab.id };
  }
}

/**
 * 发布单个条目到 VC 自营店铺
 * @param {{imageMakers?: {main?: Function, detail?: Function, transparent?: Function}, landTimeoutMs?: number}} [deps]
 * @returns {Promise<{status: 'published'|'filled'|'need_action'|'failed'|'throttle', message: string, target?: object, tabId?: number,
 *   price?: number, wareId?: string}>} price：京东价；tabId：需要人工检查时保留的发布页
 */
export async function publishVcItem(item, settings, log, { imageMakers, landTimeoutMs = LAND_TIMEOUT_MS } = {}) {
  if (!item.product) return { status: 'need_action', message: '尚未采集' };
  const picked = vcTarget({ product: item.product, edits: item.edits, settings });
  if (picked.error) return { status: 'need_action', message: picked.error };
  const { blockers } = vcPreflight({ product: item.product, edits: item.edits, settings });
  if (blockers.length) return { status: 'need_action', message: blockers.join('；'), target: picked.target };

  const timer = createStopwatch();
  const { images: imagePlan } = buildVcPublishPlan({ product: item.product, edits: item.edits, settings, schema: { attrs: [] } });
  // 文件名带时间戳：按文件名在图片空间里勾选时不会选到以前传过的同名图片
  const sku = `vc_${item.skuId}_${Date.now() % 1e6}`;
  const images = startImagePrep(
    { sku, ...imagePlan, reuploadDetail: settings.publish.reuploadDetailImages },
    { log, timer, makers: imageMakers },
  );
  let tab;
  try {
    tab = await openWorkTab(buildVcPublishUrl(picked.target));
  } catch (e) {
    images.cancel();
    throw e;
  }
  timer.lap('打开页面');
  const result = await publishInVcTab(tab, item, settings, log, picked.target, { timer, images, landTimeoutMs });
  images.cancel();
  log(`耗时：${timer.summary()}`);
  if (!result.tabId) await closeTab(tab.id);
  return result;
}
