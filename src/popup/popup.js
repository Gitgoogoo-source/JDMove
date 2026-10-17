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
  const { items = [] } = await chrome.storage.local.get('items');
  const collected = items.filter((i) => i.product).length;
  const published = items.filter((i) => i.status === 'published').length;
  $('stats').textContent = `共 ${items.length} · 已采 ${collected} · 已发 ${published}`;
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
