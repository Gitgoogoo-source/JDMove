import { classifyPageUrl } from '../shared/url-utils.js';

const $ = (id) => document.getElementById(id);

function showResult(text, isError = false) {
  const el = $('result');
  el.textContent = text;
  el.classList.toggle('error', isError);
  el.hidden = false;
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function refreshStats() {
  // 发布成功的商品移出任务列表、写进上架总表：已发 = 上架总表里的记录数（含还没写进文件的）
  const { items = [], masterRecords = [] } = await chrome.storage.local.get(['items', 'masterRecords']);
  const collected = items.filter((i) => i.product).length;
  $('stats').textContent = `任务 ${items.length} · 已采 ${collected} · 已发 ${masterRecords.length}`;
}

async function send(type, extra = {}) {
  return chrome.runtime.sendMessage({ type, ...extra });
}

async function init() {
  const tab = await activeTab();
  const kind = classifyPageUrl(tab?.url ?? '');
  $('collect').disabled = kind !== 'item';
  $('extract').disabled = !/\.jd\.com\//.test(tab?.url ?? '');
  await refreshStats();

  $('collect').addEventListener('click', async () => {
    $('collect').disabled = true;
    showResult('采集中，请稍候…');
    const res = await send('collect-tab', { tabId: tab.id });
    if (res?.ok) showResult(`已采集：${res.title}${res.warnings?.length ? `（${res.warnings.join('、')}）` : ''}`);
    else showResult(`采集失败：${res?.error ?? '未知错误'}`, true);
    $('collect').disabled = false;
    refreshStats();
  });

  $('extract').addEventListener('click', async () => {
    const res = await send('extract-list', { tabId: tab.id });
    if (res?.ok) showResult(`找到 ${res.found} 个商品，新增 ${res.added} 个到任务列表`);
    else showResult(`提取失败：${res?.error ?? '未知错误'}`, true);
    refreshStats();
  });

  $('dashboard').addEventListener('click', async () => {
    await send('open-dashboard');
    window.close();
  });
}

init().catch((e) => showResult(e.message, true));
