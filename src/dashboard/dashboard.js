// 任务面板入口：列表展示、批量采集/发布、设置与编辑
import { h, $, openDialog } from './dom.js';
import { renderRow } from './rows.js';
import { renderFolders, renderCrumb } from './archive-view.js';
import { editItem } from './editor.js';
import { editSettings } from './settings-dialog.js';
import { createStorageController } from './storage-ui.js';
import { extractSkuIds } from '../shared/url-utils.js';
import { parseShopInput } from '../shared/shop-url.js';
import { itemRepo, settingsRepo } from '../lib/chrome-env.js';
import { EDITED_NOTE } from '../shared/store.js';
import { groupPublishedByBrand, filterFolders, isArchived, taskItems } from '../shared/brand-folders.js';
import { createQueueRunner } from '../lib/queue.js';

const MAX_LOG = 400;
let items = [];
let settings = null;
let selected = new Set();
let logLines = [];
let lastShopUrl = '';
// 'tasks'：任务列表；'archive'：已发布按品牌归档，folderKey 为空时显示文件夹列表
let view = { mode: 'tasks', folderKey: null };

const MODE_LABELS = { collect: '采集', publish: '发布', shop: '抓取店铺', save: '保存到本地' };
const RESUME_HINTS = {
  collect: '处理完成后重新点击“采集选中/发布选中”即可继续。',
  shop: '处理完成后重新点击“抓取店铺”即可（已加入的商品不会重复添加）。',
};

function appendLog(line) {
  logLines = [...logLines, `${new Date().toLocaleTimeString()} ${line}`].slice(-MAX_LOG);
  const el = $('#log');
  el.textContent = logLines.join('\n');
  el.scrollTop = el.scrollHeight;
}

const storage = createStorageController({ onLog: appendLog, onChange: () => renderState() });
const runner = createQueueRunner({ onChange: renderState, onLog: appendLog, saveLocal: (item) => storage.save(item) });

const TASKS_EMPTY_TEXT = $('#empty').textContent;
const TASKS_DONE_TEXT = '没有待处理的任务。发布成功的商品已移到“已发布”页，点击上方“已发布”查看。';

function currentFolder() {
  if (view.mode !== 'archive' || !view.folderKey) return null;
  return groupPublishedByBrand(items).find((f) => f.key === view.folderKey) ?? null;
}

function setView(next) {
  view = next;
  selected = new Set();
  $('#folderSearch').value = '';
  render();
  window.scrollTo(0, 0);
}

function visibleItems() {
  if (view.mode === 'archive') return currentFolder()?.items ?? [];
  // 发布成功的商品只在“已发布”页显示，任务列表里不再出现
  const tasks = taskItems(items);
  const filter = $('#filter').value;
  return filter === 'all' ? tasks : tasks.filter((i) => i.status === filter);
}

function renderState() {
  const st = runner.getState();
  const el = $('#runState');
  el.textContent = st.running ? `${MODE_LABELS[st.mode] ?? ''}中：${st.currentId ?? ''}${st.stopRequested ? '（正在停止）' : ''}` : '空闲';
  el.classList.toggle('busy', st.running);
  for (const id of ['btnCollect', 'btnPublish', 'btnDelete', 'btnAdd', 'btnShop', 'btnSettings', 'btnImport', 'btnSaveLocal', 'btnStorage']) $(`#${id}`).disabled = st.running;
  $('#btnStorage').textContent = storage.label();
  $('#btnStorage').title = storage.title();
  $('#btnStop').disabled = !st.running;
  const banner = $('#pauseBanner');
  banner.hidden = !st.pauseReason;
  banner.textContent = st.pauseReason ? `任务已暂停：${st.pauseReason}。${RESUME_HINTS[st.pausedMode] ?? RESUME_HINTS.collect}` : '';
}

function renderArchive() {
  const archive = view.mode === 'archive';
  const folder = currentFolder();
  const folders = archive ? groupPublishedByBrand(items) : [];
  const showFolders = archive && !folder;
  const shown = showFolders ? filterFolders(folders, $('#folderSearch').value) : [];
  $('#btnArchive').setAttribute('aria-pressed', String(archive));
  $('#filter').disabled = archive;
  $('#archiveBar').hidden = !archive;
  $('#folderSearch').hidden = !showFolders;
  $('#archiveCrumb').replaceChildren(
    ...(archive
      ? renderCrumb({
          folders,
          folder,
          onHome: () => setView({ mode: 'archive', folderKey: null }),
          onExit: () => setView({ mode: 'tasks', folderKey: null }),
        })
      : []),
  );
  $('#folders').hidden = !showFolders;
  $('#folders').replaceChildren(...renderFolders(shown, { onOpen: (key) => setView({ mode: 'archive', folderKey: key }) }));
  $('#itemsTable').hidden = showFolders;
  const tasks = archive ? [] : taskItems(items);
  const emptyText = !archive ? (tasks.length < items.length ? TASKS_DONE_TEXT : TASKS_EMPTY_TEXT) : folders.length ? '没有匹配的品牌' : '还没有发布成功的商品。发布成功后会自动按品牌归到这里。';
  $('#empty').textContent = emptyText;
  return archive ? (showFolders ? shown.length > 0 : true) : tasks.length > 0;
}

function render() {
  const busy = runner.getState().running;
  const list = visibleItems();
  $('#rows').replaceChildren(
    ...list.map((item) =>
      renderRow(item, {
        settings,
        busy,
        checked: selected.has(item.id),
        onCheck: (id, on) => {
          selected = new Set(selected);
          if (on) selected.add(id);
          else selected.delete(id);
        },
        onEdit: handleEdit,
        onRemove: (id) => deleteItems([id]),
        onRetry: (id) => {
          const item = items.find((i) => i.id === id);
          return item?.product ? runner.publish([id]) : runner.collect([id]);
        },
      }),
    ),
  );
  $('#empty').hidden = renderArchive();
  const tasks = taskItems(items);
  const archived = items.length - tasks.length;
  const count = (s) => tasks.filter((i) => i.status === s).length;
  $('#summary').textContent = `任务 ${tasks.length} · 待采集 ${count('pending')} · 已采集 ${count('collected')} · 需处理 ${count('need_action')} · 失败 ${count('failed')} · 已发布 ${archived}`;
  $('#btnArchive').textContent = archived ? `已发布（${archived}）` : '已发布';
  $('#checkAll').checked = list.length > 0 && list.every((i) => selected.has(i.id));
  renderState();
}

async function reload() {
  [items, settings] = await Promise.all([itemRepo.findAll(), settingsRepo.get()]);
  // 发布成功的商品会移出任务列表：同时取消它的勾选，避免“删除选中”等操作作用到看不见的条目
  const visible = new Set(visibleItems().map((i) => i.id));
  selected = new Set([...selected].filter((id) => visible.has(id)));
  render();
}

function targetIds(predicate) {
  const visible = visibleItems();
  const chosen = visible.filter((i) => selected.has(i.id));
  const pool = chosen.length ? chosen : visible;
  return pool.filter(predicate).map((i) => i.id);
}

// 已发布过的商品默认不再加入任务列表；勾选后才会重新采集（例如店铺里的商品已被删掉需要重新铺货）
function includePublishedBox() {
  const box = h('input', { type: 'checkbox' });
  return { box, node: h('label', { class: 'check' }, box, '包含已发布过的商品（默认跳过，不再重复采集）') };
}

/** 添加结果日志：识别数量、新增数量，以及跳过的已发布/已在列表的数量 */
function addSummary(total, { added, published, existing }) {
  const notes = [
    published.length ? `${published.length} 个已发布过，已跳过（在“已发布”页或曾经发布）` : '',
    existing.length ? `${existing.length} 个已在任务列表` : '',
  ].filter(Boolean);
  return `识别到 ${total} 个 SKU，新增 ${added.length} 个${notes.length ? `（${notes.join('；')}）` : ''}`;
}

async function handleAdd() {
  const include = includePublishedBox();
  const area = h('textarea', { rows: 10, placeholder: '粘贴京东商品链接或 SKU，每行一个；也可以直接粘贴整段文本' });
  const dialog = h(
    'dialog',
    {},
    h(
      'form',
      { method: 'dialog' },
      h('div', { class: 'dlg-head' }, '添加商品链接'),
      h('div', { class: 'dlg-body' }, h('label', { class: 'field' }, area), include.node),
      h('div', { class: 'dlg-foot' }, h('button', { value: 'cancel' }, '取消'), h('button', { value: 'ok', class: 'primary' }, '添加')),
    ),
  );
  if ((await openDialog(dialog)) !== 'ok') return;
  const skus = extractSkuIds(area.value);
  const res = await itemRepo.addTasks(skus, { includePublished: include.box.checked });
  appendLog(addSummary(skus.length, res));
  await reload();
}

async function handleShop() {
  const include = includePublishedBox();
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
        h('p', { class: 'muted' }, '填写店铺“全部商品”页或店铺首页的链接；“全部商品”页里选了分类时，只抓这个分类。抓到的商品会直接加入任务列表（已有的不会重复，已发布过的会跳过）。'),
        include.node,
      ),
      h('div', { class: 'dlg-foot' }, h('button', { value: 'cancel', formnovalidate: true }, '取消'), h('button', { value: 'ok', class: 'primary' }, '开始抓取')),
    ),
  );
  if ((await openDialog(dialog)) !== 'ok') return;
  const url = input.value.trim();
  if (!parseShopInput(url)) return appendLog('不是京东店铺链接，请填写店铺首页或“全部商品”页的链接');
  lastShopUrl = url;
  appendLog(`开始抓取店铺：${url}`);
  await runner.crawlShop(url, { includePublished: include.box.checked });
}

async function handleEdit(id) {
  const item = items.find((i) => i.id === id);
  if (!item) return;
  const res = await editItem(item, { onLog: appendLog });
  if (!res) return;
  const saved = await itemRepo.saveEdits(id, res.edits);
  if (!saved) return appendLog(`[${id}] 条目已不存在，修改未保存`);
  if (saved.message.startsWith(EDITED_NOTE)) appendLog(`[${id}] 修改已保存，需点“重新发布”或“发布选中”才会提交到店铺`);
  if (res.mapping) {
    const others = settings.categoryMap.filter((m) => m.source !== res.mapping.source);
    await settingsRepo.save({ ...settings, categoryMap: [...others, res.mapping] });
    appendLog(`已记住类目映射：${res.mapping.source} => ${res.mapping.name}`);
  }
  await reload();
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
  const publishedNote = targets.some(isArchived) ? '\n已发布的商品删除后仍会记住，重新添加链接或抓取店铺时会自动跳过。' : '';
  if (!confirm(`${head}${localNote}${publishedNote}\n（不会影响店铺后台）`)) return;
  const withFolder = access ? targets.filter((i) => i.product || i.local?.dir) : [];
  const cleared = new Set(await removeLocalFolders(withFolder));
  const keep = new Set(withFolder.filter((i) => !cleared.has(i.id)).map((i) => i.id));
  const dropIds = targets.map((i) => i.id).filter((id) => !keep.has(id));
  await itemRepo.remove(dropIds);
  selected = new Set([...selected].filter((id) => !dropIds.includes(id)));
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
  $('#btnImport').addEventListener('click', () => $('#importFile').click());
  $('#importFile').addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file) handleImport(file);
  });
  $('#btnAdd').addEventListener('click', handleAdd);
  $('#btnShop').addEventListener('click', handleShop);
  $('#btnSettings').addEventListener('click', handleSettings);
  $('#btnStop').addEventListener('click', () => runner.stop());
  $('#btnClearLog').addEventListener('click', () => {
    logLines = [];
    $('#log').textContent = '';
  });
  $('#filter').addEventListener('change', render);
  $('#btnArchive').addEventListener('click', () => setView({ mode: view.mode === 'archive' ? 'tasks' : 'archive', folderKey: null }));
  $('#folderSearch').addEventListener('input', render);
  $('#checkAll').addEventListener('change', (e) => {
    selected = e.target.checked ? new Set(visibleItems().map((i) => i.id)) : new Set();
    render();
  });
  $('#btnCollect').addEventListener('click', async () => {
    const ids = targetIds((i) => ['pending', 'failed'].includes(i.status) || (!i.product && i.status !== 'collecting'));
    if (!ids.length) return appendLog('没有需要采集的条目（选中或筛选“待采集/失败”）');
    const local = await storage.prepare();
    appendLog(`开始采集 ${ids.length} 条${local ? '（完成后自动保存到本地）' : ''}`);
    runner.collect(ids);
  });
  $('#btnStorage').addEventListener('click', () => storage.choose());
  $('#btnSaveLocal').addEventListener('click', async () => {
    // 勾选了就按勾选的保存（可重新保存）；没勾选时只保存还没存到本地的
    const ids = selected.size ? targetIds((i) => i.product) : targetIds((i) => i.product && !i.local?.dir);
    if (!ids.length) return appendLog('没有需要保存到本地的条目（只能保存已采集的商品；已保存过的可勾选后重新保存）');
    if (!(await storage.prepare({ required: true }))) return;
    appendLog(`开始保存 ${ids.length} 条到本地`);
    runner.saveLocal(ids);
  });
  $('#btnPublish').addEventListener('click', () => {
    const ids = targetIds((i) => i.product && ['collected', 'failed', 'need_action'].includes(i.status));
    if (!ids.length) return appendLog('没有可发布的条目（需先采集；已发布的商品在“已发布”页，需要时可用行内“重新发布”）');
    appendLog(`开始发布 ${ids.length} 条（动作：${settings.publish.action}）`);
    runner.publish(ids);
  });
  $('#btnDelete').addEventListener('click', async () => {
    if (!selected.size) return appendLog('请先勾选要删除的条目');
    await deleteItems([...selected]);
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (changes.items || changes.settings)) reload();
  });
  window.addEventListener('beforeunload', (e) => {
    if (runner.getState().running) e.preventDefault();
  });
}

bind();
reload();
storage.init();
