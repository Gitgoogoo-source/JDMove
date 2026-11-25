// 任务面板入口：列表展示、批量采集/发布、设置与编辑
import { h, $, openDialog } from './dom.js';
import { createTaskList } from './task-list.js';
import { editItem } from './editor.js';
import { editSettings } from './settings-dialog.js';
import { createStorageController } from './storage-ui.js';
import { openVcImportDialog } from './vc-import-dialog.js';
import { openPublishReview } from './publish-review-dialog.js';
import { createBatchFlow } from './batch-flow.js';
import { createMasterController } from './master-ui.js';
import { createPublishResult } from './publish-result.js';
import { downloadBytes } from './download.js';
import { rebaseEdits } from '../shared/vc-review.js';
import { importEdit } from '../shared/vc-import.js';
import { extractSkuIds, b2bItemUrls } from '../shared/url-utils.js';
import { parseShopInput } from '../shared/shop-url.js';
import { itemRepo, settingsRepo, throttleRepo, masterRepo } from '../lib/chrome-env.js';
import { EDITED_NOTE, THROTTLE_KEY, editsEqual, pickRecollect } from '../shared/store.js';
import { cateChangeNote } from '../shared/category-pick.js';
import { PUBLISH_ACTIONS } from '../shared/settings.js';
import { createQueueRunner } from '../lib/queue.js';
import { cooldownNotice } from '../shared/publish-throttle.js';
import { BATCHES_KEY } from '../shared/batch.js';
import { MASTER_KEY } from '../shared/master-store.js';
import { LISTING_TEMPLATE_NAME, listingTemplateXlsx } from '../shared/listing-template.js';
import { collectedProductsSheet } from '../shared/collected-products-sheet.js';
import { buildXlsx } from '../shared/xlsx-write.js';

const MAX_LOG = 400;
let items = [];
let settings = null;
// 最近一次保存接口限流的记录（冷却期内发布前提醒）
let throttle = null;
const selected = new Set();
let logLines = [];
let lastShopUrl = '';

const MODE_LABELS = { collect: '采集', publish: '发布', shop: '抓取店铺', save: '保存到本地' };
const RESUME_HINTS = {
  collect: '处理完成后重新点击“采集选中/重新采集选中/发布选中”即可继续。',
  shop: '处理完成后重新点击“抓取店铺”即可（已加入的商品不会重复添加）。',
  publish: '没有保存成功的商品仍在任务列表里，等限流冷却结束后重新点击“发布选中”即可继续。',
};
// 限流冷却横幅的刷新间隔：冷却结束后自动消失
const COOLDOWN_REFRESH_MS = 60e3;
// 表格导入后写进日志的问题行数（全部问题在导入弹窗里看）
const IMPORT_LOG_PROBLEMS = 30;

function appendLog(line) {
  logLines = [...logLines, `${new Date().toLocaleTimeString()} ${line}`].slice(-MAX_LOG);
  const el = $('#log');
  el.textContent = logLines.join('\n');
  el.scrollTop = el.scrollHeight;
}

const storage = createStorageController({ onLog: appendLog, onChange: () => renderState() });
const master = createMasterController({ masterRepo, onLog: appendLog, onChange: () => renderState() });
const runner = createQueueRunner({
  onChange: renderState,
  onLog: appendLog,
  saveLocal: (item, opts) => storage.save(item, opts),
  // 上架表的商品采集完后自动生成发布前检查表；每轮发布结束后把发布成功的商品写进上架总表，
  // 再弹出发布结果（成功/失败），有失败的商品时下载失败表格
  onRunEnd: (info) => {
    batchFlow.onRunEnd(info);
    publishResult.onRunEnd(info, master.onRunEnd(info));
  },
});
const batchFlow = createBatchFlow({
  runner, storage, onLog: appendLog, reload: () => reload(), confirmCooldown: () => confirmPublishDuringCooldown(),
  onUploadStatus: (message) => {
    const status = $('#uploadStatus');
    status.textContent = message;
    status.hidden = !message;
  },
});
const publishResult = createPublishResult({ storage, onLog: appendLog, exportReview: (ids, label) => batchFlow.exportReviewFor(ids, label) });

const TASKS_EMPTY_TEXT = $('#empty').textContent;
const TASKS_DONE_NOTE = '发布成功的商品会写进上架总表（点上方“上架总表”设置位置）并移出任务列表。';
const taskList = createTaskList();

// 批量操作按状态筛选取商品，折叠品牌组只影响展示。
function visibleItems() {
  const filter = $('#filter').value;
  return filter === 'all' ? items : items.filter((i) => i.status === filter);
}

function renderState() {
  const st = runner.getState();
  const el = $('#runState');
  el.textContent = st.running ? `${MODE_LABELS[st.mode] ?? ''}中：${st.currentId ?? ''}${st.stopRequested ? '（正在停止）' : ''}` : '空闲';
  el.classList.toggle('busy', st.running);
  for (const id of ['btnCollect', 'btnRecollect', 'btnPublish', 'btnDelete', 'btnAdd', 'btnShop', 'btnUpload', 'btnSettings', 'btnImport', 'btnSaveLocal', 'btnStorage', 'btnVcImport']) {
    $(`#${id}`).disabled = st.running;
  }
  $('#btnStorage').textContent = storage.label();
  $('#btnStorage').title = storage.title();
  $('#btnMaster').textContent = master.label();
  $('#btnMaster').title = master.title();
  $('#btnStop').disabled = !st.running;
  const banner = $('#pauseBanner');
  const cooling = st.running ? '' : cooldownNotice(throttle, Date.now());
  banner.hidden = !st.pauseReason && !cooling;
  banner.textContent = st.pauseReason ? `任务已暂停：${st.pauseReason}。${RESUME_HINTS[st.pausedMode] ?? RESUME_HINTS.collect}` : cooling;
}

/** 冷却期内发布前确认；不在冷却期或用户确认继续时返回 true，取消时写日志 */
function confirmPublishDuringCooldown() {
  const notice = cooldownNotice(throttle, Date.now());
  if (!notice || confirm(`${notice}\n\n冷却期内多半仍会被拒绝保存。仍要现在发布吗？`)) return true;
  appendLog('已取消发布：限流冷却中');
  return false;
}

function render() {
  const busy = runner.getState().running;
  const list = visibleItems();
  taskList.render(list, selected, {
    settings,
    busy,
    onEdit: handleEdit,
    onRemove: (id) => deleteItems([id]),
    onRetry: (id) => {
      const item = items.find((i) => i.id === id);
      if (!item?.product) return runner.collect([id]);
      return confirmPublishDuringCooldown() && runner.publish([id]);
    },
    onRecollect: handleRecollect,
  });
  $('#empty').hidden = list.length > 0;
  $('#empty').textContent = items.length ? '没有符合筛选条件的任务' : `${TASKS_EMPTY_TEXT}${TASKS_DONE_NOTE}`;
  const count = (s) => items.filter((i) => i.status === s).length;
  $('#summary').textContent = `任务 ${items.length} · 待采集 ${count('pending')} · 已采集 ${count('collected')} · 需处理 ${count('need_action')} · 失败 ${count('failed')}`;
  batchFlow.render($('#batchBar'), items, busy);
  renderState();
}

// 已采集的商品重新采集：覆盖商品数据（例如上次没采到详情图），编辑内容保留
async function handleRecollect(id) {
  const local = await storage.prepare();
  appendLog(`[${id}] 开始重新采集${local ? '（完成后自动保存到本地）' : ''}`);
  runner.collect([id]);
}

/** 批量重新采集勾选的已采集商品：覆盖商品信息和图片，编辑内容保留 */
async function handleRecollectSelected() {
  const { ids, skipped } = pickRecollect(visibleItems(), selected);
  const skipNote = skipped ? `（${skipped} 个不能重新采集：未采集的用“采集选中”，正在采集/发布的等结束后再试）` : '';
  if (!ids.length) return appendLog(`请先在任务列表勾选已采集的商品${skipNote}`);
  const c = settings.collect;
  const minutes = Math.max(1, Math.ceil((ids.length * (c.minDelaySec + c.maxDelaySec)) / 2 / 60));
  const msg =
    `确定重新采集选中的 ${ids.length} 个商品？预计约 ${minutes} 分钟。` +
    '\n会重新打开京东商品页，覆盖已采集的商品信息和图片（编辑内容保留）；设置了存储位置时本地文件夹也会更新。' +
    '\n某个商品重新采集失败时保留它上次采集的数据。';
  // 先申请存储文件夹权限（需要在用户点击后立即进行），再确认
  const local = await storage.prepare();
  if (!confirm(msg)) return;
  appendLog(`开始重新采集 ${ids.length} 个商品${skipNote}${local ? '（完成后自动保存到本地）' : ''}`);
  runner.collect(ids);
}

async function reload(selectIds = []) {
  [items, settings, throttle] = await Promise.all([itemRepo.findAll(), settingsRepo.get(), throttleRepo.get(), batchFlow.refresh()]);
  if (selectIds.length) {
    const requested = new Set(selectIds);
    const filter = $('#filter');
    if (filter.value !== 'all' && items.some((item) => requested.has(item.id) && item.status !== filter.value)) {
      filter.value = 'all';
    }
  }
  for (const id of selectIds) selected.add(id);
  // 发布成功的商品会移出列表，刷新任务时清理已不在当前结果中的勾选。
  const visible = new Set(visibleItems().map((item) => item.id));
  for (const id of selected) {
    if (!visible.has(id)) selected.delete(id);
  }
  render();
}

function targetIds(predicate) {
  const visible = visibleItems();
  const chosen = visible.filter((i) => selected.has(i.id));
  const pool = chosen.length ? chosen : visible;
  return pool.filter(predicate).map((i) => i.id);
}

/** 添加结果日志：识别数量、新增数量、已在列表的数量（以前发布过的也会加入） */
function addSummary(total, { added, existing }) {
  return `识别到 ${total} 个 SKU，新增 ${added.length} 个${existing.length ? `（${existing.length} 个已在任务列表）` : ''}`;
}

async function handleAdd() {
  const area = h('textarea', { rows: 10, placeholder: '粘贴京东商品链接或 SKU，每行一个；也可以直接粘贴整段文本' });
  const dialog = h(
    'dialog',
    {},
    h(
      'form',
      { method: 'dialog' },
      h('div', { class: 'dlg-head' }, '添加商品链接'),
      h('div', { class: 'dlg-body' }, h('label', { class: 'field' }, area)),
      h('div', { class: 'dlg-foot' }, h('button', { value: 'cancel' }, '取消'), h('button', { value: 'ok', class: 'primary' }, '添加')),
    ),
  );
  if ((await openDialog(dialog)) !== 'ok') return;
  const skus = extractSkuIds(area.value);
  const res = await itemRepo.addTasks(skus, { urls: b2bItemUrls(area.value) });
  appendLog(addSummary(skus.length, res));
  await reload(skus);
}

async function handleShop() {
  const input = h('input', {
    type: 'text',
    value: lastShopUrl,
    placeholder: 'https://mall.jd.com/view_search-646206-0-99-1-24-1.html',
    required: true,
  });
  const dialog = h(
    'dialog',
    {},
    h(
      'form',
      { method: 'dialog' },
      h('div', { class: 'dlg-head' }, '抓取店铺全部商品'),
      h(
        'div',
        { class: 'dlg-body' },
        h('label', { class: 'field' }, h('span', {}, '店铺链接'), input),
        h('p', { class: 'muted' }, '填写店铺“全部商品”页或店铺首页的链接；“全部商品”页里选了分类时，只抓这个分类。抓到的商品会直接加入任务列表（已在列表里的不会重复）。'),
      ),
      h('div', { class: 'dlg-foot' }, h('button', { value: 'cancel', formnovalidate: true }, '取消'), h('button', { value: 'ok', class: 'primary' }, '开始抓取')),
    ),
  );
  if ((await openDialog(dialog)) !== 'ok') return;
  const url = input.value.trim();
  if (!parseShopInput(url)) return appendLog('不是京东店铺链接，请填写店铺首页或“全部商品”页的链接');
  lastShopUrl = url;
  appendLog(`开始抓取店铺：${url}`);
  await runner.crawlShop(url);
}

async function handleEdit(id) {
  const item = items.find((i) => i.id === id);
  if (!item) return;
  const res = await editItem(item, { onLog: appendLog, settings });
  if (!res) return;
  // 没改内容时不保存，避免发布过（需处理/失败）的商品被误标为“已修改，尚未重新发布”
  if (editsEqual(item.edits, res.edits)) {
    appendLog(`[${id}] 内容没有变化，没有保存`);
  } else {
    const saved = await itemRepo.saveEdits(id, res.edits);
    if (!saved) return appendLog(`[${id}] 条目已不存在，修改未保存`);
    const cateNote = cateChangeNote(item.edits, res.edits);
    appendLog(`[${id}] 修改已保存${cateNote ? `，${cateNote}` : ''}`);
    if (saved.message.startsWith(EDITED_NOTE)) appendLog(`[${id}] 需点行内“发布”或“发布选中”才会提交到店铺`);
  }
  if (res.mapping) {
    const others = settings.categoryMap.filter((m) => m.source !== res.mapping.source);
    await settingsRepo.save({ ...settings, categoryMap: [...others, res.mapping] });
    appendLog(`已记住类目映射：${res.mapping.source} => ${res.mapping.name}`);
  }
  await reload();
}

/**
 * 表格批量填写 VC 的市场价/京东价/采购价/采购员ERP/销售员ERP。模板列出任务列表里的商品（勾选了就只列勾选的），
 * 导入按商品链接对应，一次保存
 */
async function handleVcImport() {
  const tasks = visibleItems();
  const chosen = tasks.filter((i) => selected.has(i.id));
  const res = await openVcImportDialog({ items, templateItems: chosen.length ? chosen : tasks, onLog: appendLog });
  if (!res) return;
  const changed = await itemRepo.saveEditsMany(res.updates.map((u) => ({ id: u.id, edit: importEdit(u.values) })));
  const notes = res.notes.length ? `；${res.notes.join('，')}` : '';
  appendLog(`表格导入：已修改 ${changed.length} 个商品的市场价/京东价/采购价/ERP${notes}`);
  res.problems.slice(0, IMPORT_LOG_PROBLEMS).forEach((p) => appendLog(`表格导入 第 ${p.row} 行：${p.text}`));
  if (res.problems.length > IMPORT_LOG_PROBLEMS) appendLog(`表格导入：还有 ${res.problems.length - IMPORT_LOG_PROBLEMS} 行问题没写进日志，请重新打开导入弹窗选择这个表格查看`);
  await reload();
}

/**
 * 「发布选中」：先打开发布前检查弹窗（按上架模板列出每个商品要填的内容，缺的可以补、可以选模板、可以表格批量填），
 * 保存弹窗里的修改后发布勾选的商品
 */
async function handlePublishSelected() {
  const ids = targetIds((i) => i.product && ['collected', 'failed', 'need_action'].includes(i.status));
  if (!ids.length) return appendLog('没有可发布的条目（需先采集；发布成功的商品已写进上架总表并移出任务列表）');
  if (!confirmPublishDuringCooldown()) return;
  let res;
  try {
    res = await openPublishReview({ items: ids.map((id) => items.find((i) => i.id === id)).filter(Boolean), settings, onLog: appendLog });
  } catch (e) {
    return appendLog(`发布前检查打不开：${e.message}`);
  }
  if (!res) return appendLog('已取消发布');
  if (res.changes.length) {
    try {
      // 以存储里最新的编辑内容为准，只覆盖弹窗里改过的项（弹窗打开期间在别处的修改保留）
      const changed = await itemRepo.saveEditsMany(res.changes.map((c) => ({ id: c.id, edit: (current) => rebaseEdits(c.before, c.edits, current) })));
      appendLog(`发布前检查：已保存 ${changed.length} 个商品的修改`);
    } catch (e) {
      appendLog(`发布前检查：修改保存失败，没有发布：${e.message}`);
      return reload();
    }
  }
  await reload();
  if (!res.publishIds.length) return appendLog(res.changes.length ? '只保存了修改，没有发布' : '没有勾选要发布的商品');
  appendLog(`开始发布 ${res.publishIds.length} 条（填写完成后：${PUBLISH_ACTIONS[settings.publish.action] ?? settings.publish.action}）`);
  runner.publish(res.publishIds);
}

/** 删除本地文件夹；返回删除成功（或本来就没有文件夹）的条目 id */
async function removeLocalFolders(targets) {
  const done = [];
  for (const item of targets) {
    try {
      const res = await storage.removeFolder(item);
      if (res?.removed) appendLog(`[${item.id}] 已删除本地文件夹：${res.dir}`);
      done.push(item.id);
    } catch (e) {
      appendLog(`[${item.id}] 本地文件夹删除失败，任务已保留：${e.message}`);
    }
  }
  return done;
}

// 删除任务时同步删除本地的“品牌/SKU”文件夹（图片和商品信息）
async function deleteItems(ids) {
  const targets = items.filter((i) => ids.includes(i.id));
  if (!targets.length) return;
  const saved = targets.filter((i) => i.local?.dir).length;
  // 先申请权限（需要在用户点击后立即进行），没有权限时不删任务，避免本地留下对不上的文件夹
  const access = storage.isSet() && (await storage.ensureAccess());
  if (saved && !access) {
    return appendLog('无法访问存储文件夹，任务未删除：请先点击“存储位置”授权后再删除');
  }
  const localNote = saved ? `\n其中 ${saved} 条已保存到本地，会同时删除对应的“品牌/SKU”文件夹（图片和商品信息），删除后无法恢复。` : '';
  const head = targets.length === 1 ? `确定删除任务 SKU ${targets[0].skuId}？` : `确定删除选中的 ${targets.length} 条任务？`;
  if (!confirm(`${head}${localNote}\n（不会影响店铺后台）`)) return;
  const withFolder = access ? targets.filter((i) => i.product || i.local?.dir) : [];
  const cleared = new Set(await removeLocalFolders(withFolder));
  const keep = new Set(withFolder.filter((i) => !cleared.has(i.id)).map((i) => i.id));
  const dropIds = targets.map((i) => i.id).filter((id) => !keep.has(id));
  await itemRepo.remove(dropIds);
  for (const id of dropIds) selected.delete(id);
  appendLog(`已删除 ${dropIds.length} 条任务${keep.size ? `，${keep.size} 条因本地文件夹删除失败而保留` : ''}`);
  await reload();
}

async function handleSettings() {
  const res = await editSettings(settings);
  if (!res) return;
  await settingsRepo.save(res.value);
  res.errors.forEach((e) => appendLog(`设置：${e}`));
  appendLog('设置已保存');
  await reload();
}

/** 下载固定的上架表模板（参考链接、价格、协议价、条形码……照着填好后点“上传表格”） */
function handleListingTemplate() {
  downloadBytes(listingTemplateXlsx(), LISTING_TEMPLATE_NAME);
  appendLog(`已下载 ${LISTING_TEMPLATE_NAME}：在“上架表”里每行填一个商品（参考链接必填，协议价等选填），填好后点“上传表格”`);
}

function handleExport() {
  const chosen = items.filter((i) => i.product && (selected.size === 0 || selected.has(i.id)));
  if (!chosen.length) return appendLog('没有可导出的已采集条目');
  const payload = { app: 'jdmove', version: 1, exportedAt: new Date().toISOString(), items: chosen.map(({ skuId, product, edits }) => ({ skuId, product, edits })) };
  const url = URL.createObjectURL(new Blob([JSON.stringify(payload)], { type: 'application/json' }));
  const a = h('a', { href: url, download: `jdmove-${Date.now()}.json` });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  appendLog(`已导出 ${chosen.length} 条`);
}

function handleExportXlsx() {
  const chosen = visibleItems().filter((item) => selected.has(item.id));
  if (!chosen.length) return appendLog('请先在当前列表勾选要导出为表格的商品');
  const collected = chosen.filter((item) => item.product);
  if (!collected.length) return appendLog('勾选的商品还没有采集数据，请先采集');
  try {
    const name = `采集数据-${Date.now()}.xlsx`;
    downloadBytes(buildXlsx([collectedProductsSheet(collected)]), name);
    const skipped = chosen.length - collected.length;
    appendLog(`已导出 ${collected.length} 条采集数据为表格${skipped ? `，跳过 ${skipped} 条没有采集数据的商品` : ''}`);
  } catch (e) {
    appendLog(`导出采集数据表格失败：${e.message}`);
  }
}

async function handleImport(file) {
  try {
    const data = JSON.parse(await file.text());
    if (data?.app !== 'jdmove' || !Array.isArray(data.items)) throw new Error('不是本插件导出的文件');
    const res = await itemRepo.importItems(data.items);
    appendLog(`导入 ${res.imported} 条，跳过 ${res.skipped} 条无效数据`);
    await reload();
  } catch (e) {
    appendLog(`导入失败：${e.message}`);
  }
}

function bind() {
  $('#btnExport').addEventListener('click', handleExport);
  $('#btnExportXlsx').addEventListener('click', handleExportXlsx);
  $('#btnImport').addEventListener('click', () => $('#importFile').click());
  $('#importFile').addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file) handleImport(file);
  });
  $('#btnAdd').addEventListener('click', handleAdd);
  $('#btnShop').addEventListener('click', handleShop);
  $('#btnUpload').addEventListener('click', () => batchFlow.handleUpload());
  $('#btnSettings').addEventListener('click', handleSettings);
  $('#btnStop').addEventListener('click', () => runner.stop());
  $('#btnClearLog').addEventListener('click', () => {
    logLines = [];
    $('#log').textContent = '';
  });
  $('#filter').addEventListener('change', render);
  $('#btnMaster').addEventListener('click', () => master.click());
  $('#btnListingTemplate').addEventListener('click', handleListingTemplate);
  $('#btnCollect').addEventListener('click', async () => {
    const ids = targetIds((i) => ['pending', 'failed'].includes(i.status) || (!i.product && i.status !== 'collecting'));
    if (!ids.length) return appendLog('没有需要采集的条目（选中或筛选“待采集/失败”）');
    const local = await storage.prepare();
    appendLog(`开始采集 ${ids.length} 条${local ? '（完成后自动保存到本地）' : ''}`);
    runner.collect(ids);
  });
  $('#btnRecollect').addEventListener('click', handleRecollectSelected);
  $('#btnVcImport').addEventListener('click', handleVcImport);
  $('#btnStorage').addEventListener('click', () => storage.choose());
  $('#btnSaveLocal').addEventListener('click', async () => {
    // 勾选了就按勾选的保存（可重新保存）；没勾选时只保存还没存到本地的
    const ids = selected.size ? targetIds((i) => i.product) : targetIds((i) => i.product && !i.local?.dir);
    if (!ids.length) return appendLog('没有需要保存到本地的条目（只能保存已采集的商品；已保存过的可勾选后重新保存）');
    if (!(await storage.prepare({ required: true }))) return;
    appendLog(`开始保存 ${ids.length} 条到本地`);
    runner.saveLocal(ids);
  });
  $('#btnPublish').addEventListener('click', handlePublishSelected);
  $('#btnDelete').addEventListener('click', async () => {
    if (!selected.size) return appendLog('请先勾选要删除的条目');
    await deleteItems([...selected]);
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.items || changes.settings || changes[THROTTLE_KEY] || changes[BATCHES_KEY]) reload();
    if (changes[MASTER_KEY]) master.refreshPending();
  });
  window.addEventListener('beforeunload', (e) => {
    if (runner.getState().running) e.preventDefault();
  });
}

/** 面板刚打开时没有任务在执行：整理上次留下的状态 */
async function tidyOnOpen() {
  // 上次被打断、停在“采集中”的条目改回来（否则上架表批次一直等它们）
  const stuck = await itemRepo.recoverInterrupted();
  if (stuck.length) appendLog(`${stuck.length} 个商品上次采集没有完成（任务面板被关闭或浏览器重启），已改回待采集/已采集`);
  // 旧版本“已发布”页里的商品：现在发布成功的商品写进上架总表，不再留在插件里
  const legacy = await itemRepo.dropLegacyPublished();
  if (legacy.length) appendLog(`已删除旧版本“已发布”页里的 ${legacy.length} 个商品记录（店铺和本地文件夹不受影响）`);
}

bind();
tidyOnOpen()
  .catch((e) => appendLog(`整理任务列表失败：${e.message}`))
  .finally(reload);
storage.init();
master.init();
setInterval(renderState, COOLDOWN_REFRESH_MS);
