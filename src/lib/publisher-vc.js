// VC 自营发布：源商品的类目/品牌 → 直接打开 VC 发布页 → 按计划逐项填写 → 页面本地校验 → 保存草稿（不点“发布商品”）
import { buildVcPublishPlan, vcPreflight, vcTarget, vcActionLabel } from '../shared/vc-plan.js';
import { descriptionHtml } from '../shared/publish-plan.js';
import { buildVcPublishUrl, imgzoneUrl } from '../shared/url-utils.js';
import { callVcBackend, openWorkTab, navigateTab, closeTab, sleep, waitForTabUrl } from './chrome-env.js';
import { landedPageKind } from './category-search.js';
import { forgetLeaf, resolveLeafTarget, sharedLeafCache } from './vc-leaf.js';
import { startImagePrep } from './image-prep.js';
import { createStopwatch } from '../shared/stopwatch.js';
import { detectSaveThrottle } from '../shared/publish-throttle.js';
import { loadVcTemplate } from './vc-templates.js';

const LOGIN_MSG = '商家后台需要重新登录';
const NOT_OPENED_MSG = 'VC 发布页没有打开：品牌可能没有授权，或类目不在账号的产品线里（可在「编辑」中指定类目ID和品牌ID）';
const LAND_TIMEOUT_MS = 5000;
// 详情图转存时每次传给页面的张数
const DETAIL_CHUNK = 6;
// 保存草稿成功后页面 100ms 内整页跳到草稿箱（wareList?activeTab=DraftWare），脚本可能来不及返回
const DRAFT_LIST_RE = /^https:\/\/[^/?#]+\/ware\/wareList\?[^#]*activeTab=DraftWare/;

async function waitVcReady(tabId, timeoutMs = 40000) {
  const end = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < end) {
    last = await callVcBackend(tabId, 'vcStatus').catch(() => null);
    // 页面显示了打不开的原因（如“您选择的类目不是末级类目”）：再等也不会好
    if (last && (last.ready || last.loginRequired || last.pageError)) return last;
    await sleep(1000);
  }
  return last ?? { ready: false };
}

const stop = (status, message) => ({ stop: { status, message } });
const valueOf = (plan, field) => plan.form.find((e) => e.field === field)?.value ?? '—';

/** 没写进去就不能保存的字段：标题 + 计划里标了 critical 的（型号、三个价格、长宽高、毛重） */
const criticalLabels = (plan) => ['标题', ...plan.form.filter((e) => e.critical).map((e) => e.label)];

async function fillFields(tabId, plan, log, timer) {
  const res = await callVcBackend(tabId, 'vcSetFields', { title: plan.title, entries: plan.form });
  timer.lap('基本信息与物流');
  if (res?.skipped?.length) log(`页面上没有这些字段，已跳过：${res.skipped.join('、')}`);
  const failed = res?.failed ?? [res?.error || '表单未就绪'];
  const critical = criticalLabels(plan);
  if (failed.some((f) => critical.some((c) => f === c || f.startsWith(`${c}（`)) || f === '表单未就绪')) {
    return stop('failed', `这些字段没有写进去：${failed.join('、')}`);
  }
  if (failed.length) log(`部分字段没有写进去：${failed.join('、')}`);
  log(`物流：长 ${valueOf(plan, 'length')} × 宽 ${valueOf(plan, 'wide')} × 高 ${valueOf(plan, 'height')} mm，毛重 ${valueOf(plan, 'weight')} kg`);
  log(`标题：${plan.title}`);
  log(`价格：市场价 ¥${plan.prices.marketPrice} / 京东价 ¥${plan.prices.jdPrice} / 采购价 ¥${plan.prices.costPrice}`);
  if (plan.erp.buyer || plan.erp.saler) {
    const erp = await callVcBackend(tabId, 'vcSetErp', plan.erp);
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

/** 详情图转存（可选）+ 代码模式写入商品详情 */
async function fillDescription(tabId, plan, settings, log, { timer, images }) {
  // 源商品没有详情图时发布前检查已经拦下；走到这里说明设置里的详情图数量为 0
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
      const res = await callVcBackend(tabId, 'uploadDetailImages', slices.slice(i, i + DETAIL_CHUNK));
      if (res?.errors?.length) log(`详情图上传问题：${res.errors.join('；')}`);
      if (!res?.ok) throw new Error(res?.error || '详情图上传失败');
      uploaded.push(...res.urls);
    }
    urls = uploaded.map(imgzoneUrl);
    timer.lap('详情图上传');
    log(`详情图已转存 ${urls.length} 张`);
  }
  const desc = await callVcBackend(tabId, 'setDescriptionHtml', descriptionHtml(urls));
  timer.lap('详情写入');
  if (!desc?.ok) throw new Error(desc?.error || '商品详情写入失败');
  if (desc.direct) log('详情编辑器没有同步内容，已直接写入表单，请在页面上核对商品详情');
}

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

/**
 * 保存前用页面自己的 convertData() 生成提交数据，确认插件写的字段没有变成带小数的数字：
 * 写成数字（尤其带小数）时保存接口返回“无效的字符串/数字，请核对后再试 [456]/[455]”
 */
async function checkPayload(tabId, plan, log) {
  const res = await callVcBackend(tabId, 'vcPayloadCheck', { fields: plan.form.map(({ field, label }) => ({ field, label })) });
  if (res?.error) log(`提交数据检查：${res.error}`);
  if (res?.floats?.length) log(`提交数据里有带小数的数字（请留意保存结果）：${res.floats.join('、')}`);
  if (res && res.ok === false && res.problems?.length) {
    return stop('failed', `这些字段在提交数据里是带小数的数字，保存会被拒收（[455]/[456]）：${res.problems.join('、')}`);
  }
  return {};
}

/** 点“保存草稿”；草稿保存成功后页面整页跳到草稿箱，脚本来不及返回时按落地地址判断 */
async function saveVcDraft(tabId, landTimeoutMs) {
  let result;
  let error;
  try {
    result = await callVcBackend(tabId, 'runAction', 'vc_draft');
  } catch (e) {
    error = e;
  }
  if (result && (result.ok || result.confirmText || result.errors?.length || result.messages?.length)) return result;
  const draftUrl = await waitForTabUrl(tabId, DRAFT_LIST_RE, landTimeoutMs);
  if (draftUrl) return { ...result, ok: true, url: draftUrl, messages: ['草稿已保存'], errors: [], confirmText: '' };
  if (error) throw error;
  return result;
}

function submitOutcome(result, plan, target, tabId, log) {
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
  log(result.draftId ? `已保存草稿（草稿编号 ${result.draftId}）：请到 VC 后台草稿箱检查后手动提交` : '已保存草稿：请到 VC 后台草稿箱检查后手动提交');
  return { status: 'published', message: (result.messages ?? []).join('；') || '已保存草稿', target, price: plan.prices.jdPrice };
}

async function publishInVcTab(tab, item, settings, log, target, ctx) {
  try {
    log(`目标类目：${target.name} [${target.cateList.join(',')}]，品牌ID ${target.brandId}`);
    const landed = await landedPageKind(tab.id);
    if (landed === 'login') return { status: 'need_action', message: LOGIN_MSG, target };
    if (landed !== 'publish') return { status: 'failed', message: NOT_OPENED_MSG, target };
    const st = await waitVcReady(tab.id);
    if (st.loginRequired) return { status: 'need_action', message: LOGIN_MSG, target };
    // notLeaf：由 publishVcItem 换成末级类目后重开发布页
    if (st.notLeaf) return { status: 'failed', notLeaf: true, message: `VC 发布页提示：${st.pageError}`, target };
    if (st.pageError) return { status: 'failed', message: `VC 发布页打不开：${st.pageError}`, target };
    if (!st.ready) return { status: 'failed', message: 'VC 发布页未就绪（页面加载超时，或类目不在账号的产品线里）', target };
    if (st.publishDisabled) log(`注意：${st.publishDisabledMsg}`);
    ctx.timer.lap('页面就绪');

    const schema = await callVcBackend(tab.id, 'getFormSchema');
    if (!schema?.ok) throw new Error(schema?.error || '读取表单结构失败');
    const plan = buildVcPublishPlan({ product: item.product, edits: item.edits, settings, schema, template: ctx.template });
    plan.warnings.forEach((w) => log(w));
    if (plan.blockers.length) return { status: 'need_action', message: plan.blockers.join('；'), target };

    const filled = await fillVcForm(tab.id, plan, settings, log, ctx);
    if (filled.stop) return { ...filled.stop, target, tabId: tab.id };
    const check = await callVcBackend(tab.id, 'vcValidate');
    ctx.timer.lap('页面校验');
    if (!check?.ok) return { status: 'failed', message: `页面校验没通过：${(check?.errors ?? []).join('；')}`, target, tabId: tab.id };
    const payload = await checkPayload(tab.id, plan, log);
    if (payload.stop) return { ...payload.stop, target, tabId: tab.id };

    if (!vcActionLabel(settings.publish.action)) {
      return { status: 'filled', message: '已填写完成，请在工作窗口中检查后手动点“保存草稿”或“发布商品”', target, tabId: tab.id };
    }
    const result = await saveVcDraft(tab.id, ctx.landTimeoutMs);
    ctx.timer.lap('保存草稿');
    return submitOutcome(result, plan, target, tab.id, log);
  } catch (e) {
    return { status: 'failed', message: e.message, target, tabId: tab.id };
  }
}

/** 自动换过类目时在结果里写明，不只写在日志里（保存草稿后要按这个核对类目） */
const withLeafNote = (result, note) => (note ? { ...result, message: `${result.message}（${note}）` } : result);

/** 源类目不是末级类目：到类目选择页选子类目，在同一个标签页里换成末级类目的发布页再填一遍 */
async function retryWithLeaf(tab, item, settings, log, leafArgs, ctx) {
  const leaf = await resolveLeafTarget({ ...leafArgs, tabId: tab.id });
  ctx.timer.lap('选末级类目');
  if (leaf.error) return { status: 'need_action', message: leaf.error, target: leafArgs.target };
  try {
    await navigateTab(tab.id, buildVcPublishUrl(leaf.target));
  } catch (e) {
    return { status: 'failed', message: e.message, target: leaf.target };
  }
  ctx.timer.lap('打开页面');
  const { notLeaf, ...result } = await publishInVcTab(tab, item, settings, log, leaf.target, ctx);
  if (!notLeaf) return withLeafNote(result, leaf.note);
  forgetLeaf(leafArgs.cache, leaf.target.cateList);
  const message = `自动选的子类目「${leaf.target.name}」[${leaf.target.categoryId}] 在 VC 发布页上仍提示不是末级类目，请在「编辑」中填写类目ID路径`;
  return { ...result, message };
}

/**
 * 类目的上架模板（templates/vc/，按类目ID路径从末级往上找）；没有模板或读取失败时返回 null，按原来的默认规则发布
 */
async function templateFor(target, log, loadTemplate) {
  try {
    const template = await loadTemplate(target.cateList);
    if (template) log(`上架模板：${template.path.map((p) => p.name).join(' > ')}（${template.capturedAt.slice(0, 10)} 录制）`);
    else log('这个类目没有上架模板，按默认规则检查');
    return template;
  } catch (e) {
    log(`上架模板读取失败（${e.message}），按默认规则检查`);
    return null;
  }
}

/**
 * 发布单个条目到 VC 自营店铺
 * @param {{imageMakers?: {main?: Function, detail?: Function, transparent?: Function}, landTimeoutMs?: number,
 *   leafCache?: Map<string, object[]>, loadTemplate?: (cateList: string[]) => Promise<object|null>}} [deps]
 *   leafCache：读到的子类目（类目ID → 子类目），默认整个运行期共用一份；loadTemplate：读上架模板（测试时替换）
 * @returns {Promise<{status: 'published'|'filled'|'need_action'|'failed'|'throttle', message: string, target?: object, tabId?: number,
 *   price?: number}>} price：京东价（记作店铺售价，检查京东今日价时对比）；tabId：需要人工检查时保留的发布页
 */
export async function publishVcItem(
  item,
  settings,
  log,
  { imageMakers, landTimeoutMs = LAND_TIMEOUT_MS, leafCache = sharedLeafCache, loadTemplate = loadVcTemplate } = {},
) {
  if (!item.product) return { status: 'need_action', message: '尚未采集' };
  const picked = vcTarget({ product: item.product, edits: item.edits, settings });
  if (picked.error) return { status: 'need_action', message: picked.error };
  const template = await templateFor(picked.target, log, loadTemplate);
  const { blockers } = vcPreflight({ product: item.product, edits: item.edits, settings, template });
  if (blockers.length) return { status: 'need_action', message: blockers.join('；'), target: picked.target };
  // 之前已经读到过这个类目的子类目（不是末级类目）：直接换成子类目，不再打开会报错的发布页
  const leafArgs = { product: item.product, edits: item.edits, log, cache: leafCache };
  const known = await resolveLeafTarget({ ...leafArgs, target: picked.target });
  if (known.error) return { status: 'need_action', message: known.error, target: picked.target };
  const { target } = known;

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
    tab = await openWorkTab(buildVcPublishUrl(target));
  } catch (e) {
    images.cancel();
    throw e;
  }
  timer.lap('打开页面');
  const ctx = { timer, images, landTimeoutMs, template };
  const first = await publishInVcTab(tab, item, settings, log, target, ctx);
  // 用记下的子类目打开后仍报不是末级类目：清掉记录，从源类目重新选
  if (first.notLeaf && known.changed) forgetLeaf(leafCache, target.cateList);
  const retryFrom = known.changed ? picked.target : target;
  const result = first.notLeaf
    ? await retryWithLeaf(tab, item, settings, log, { ...leafArgs, target: retryFrom }, ctx)
    : withLeafNote(first, known.note);
  images.cancel();
  log(`耗时：${timer.summary()}`);
  if (!result.tabId) await closeTab(tab.id);
  return result;
}
