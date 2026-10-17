// 任务面板入口：列表展示、批量采集/发布、设置与编辑
import { h, $, openDialog } from './dom.js';
import { renderRow } from './rows.js';
import { editItem } from './editor.js';
import { editSettings } from './settings-dialog.js';
import { extractSkuIds } from '../shared/url-utils.js';
import { parseShopInput } from '../shared/shop-url.js';
import { itemRepo, settingsRepo } from '../lib/chrome-env.js';
import { createQueueRunner } from '../lib/queue.js';

const MAX_LOG = 400;
let items = [];
let settings = null;
let selected = new Set();
let logLines = [];
let lastShopUrl = '';

const MODE_LABELS = { collect: '采集', publish: '发布', shop: '抓取店铺' };
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

const runner = createQueueRunner({ onChange: renderState, onLog: appendLog });

function visibleItems() {
  const filter = $('#filter').value;
  return filter === 'all' ? items : items.filter((i) => i.status === filter);
}

function renderState() {
  const st = runner.getState();
  const el = $('#runState');
  el.textContent = st.running ? `${MODE_LABELS[st.mode] ?? ''}中：${st.currentId ?? ''}${st.stopRequested ? '（正在停止）' : ''}` : '空闲';
  el.classList.toggle('busy', st.running);
  for (const id of ['btnCollect', 'btnPublish', 'btnDelete', 'btnAdd', 'btnShop', 'btnSettings', 'btnImport']) $(`#${id}`).disabled = st.running;
  $('#btnStop').disabled = !st.running;
  const banner = $('#pauseBanner');
  banner.hidden = !st.pauseReason;
  banner.textContent = st.pauseReason ? `任务已暂停：${st.pauseReason}。${RESUME_HINTS[st.pausedMode] ?? RESUME_HINTS.collect}` : '';
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
        onRemove: async (id) => {
          await itemRepo.remove([id]);
          await reload();
        },
        onRetry: (id) => {
          const item = items.find((i) => i.id === id);
          return item?.product ? runner.publish([id]) : runner.collect([id]);
        },
      }),
    ),
  );
  $('#empty').hidden = items.length > 0;
  const count = (s) => items.filter((i) => i.status === s).length;
  $('#summary').textContent = `共 ${items.length} · 待采集 ${count('pending')} · 已采集 ${count('collected')} · 需处理 ${count('need_action')} · 失败 ${count('failed')} · 已发布 ${count('published')}`;
  $('#checkAll').checked = list.length > 0 && list.every((i) => selected.has(i.id));
  renderState();
}

async function reload() {
  [items, settings] = await Promise.all([itemRepo.findAll(), settingsRepo.get()]);
  selected = new Set([...selected].filter((id) => items.some((i) => i.id === id)));
  render();
}

function targetIds(predicate) {
  const chosen = items.filter((i) => selected.has(i.id));
  const pool = chosen.length ? chosen : visibleItems();
  return pool.filter(predicate).map((i) => i.id);
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
  const added = await itemRepo.addSkus(skus);
  appendLog(`识别到 ${skus.length} 个 SKU，新增 ${added.length} 个`);
  await reload();
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
        h('p', { class: 'muted' }, '填写店铺“全部商品”页或店铺首页的链接；“全部商品”页里选了分类时，只抓这个分类。抓到的商品会直接加入任务列表（已有的不会重复）。'),
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
  const res = await editItem(item, { onLog: appendLog });
  if (!res) return;
  const nextStatus = item.status === 'need_action' || item.status === 'failed' ? (item.product ? 'collected' : 'pending') : item.status;
  await itemRepo.update(id, { edits: res.edits, status: nextStatus });
  if (res.mapping) {
    const others = settings.categoryMap.filter((m) => m.source !== res.mapping.source);
    await settingsRepo.save({ ...settings, categoryMap: [...others, res.mapping] });
    appendLog(`已记住类目映射：${res.mapping.source} => ${res.mapping.name}`);
  }
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
  $('#checkAll').addEventListener('change', (e) => {
    selected = e.target.checked ? new Set(visibleItems().map((i) => i.id)) : new Set();
    render();
  });
  $('#btnCollect').addEventListener('click', () => {
    const ids = targetIds((i) => ['pending', 'failed'].includes(i.status) || (!i.product && i.status !== 'collecting'));
    if (!ids.length) return appendLog('没有需要采集的条目（选中或筛选“待采集/失败”）');
    appendLog(`开始采集 ${ids.length} 条`);
    runner.collect(ids);
  });
  $('#btnPublish').addEventListener('click', () => {
    const ids = targetIds((i) => i.product && ['collected', 'failed', 'need_action'].includes(i.status));
    if (!ids.length) return appendLog('没有可发布的条目（需先采集；已发布的不会重复发布，可用行内“重新发布”）');
    appendLog(`开始发布 ${ids.length} 条（动作：${settings.publish.action}）`);
    runner.publish(ids);
  });
  $('#btnDelete').addEventListener('click', async () => {
    if (!selected.size) return appendLog('请先勾选要删除的条目');
    if (!confirm(`确定删除选中的 ${selected.size} 条任务？（不会影响店铺后台）`)) return;
    await itemRepo.remove([...selected]);
    selected = new Set();
    await reload();
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
