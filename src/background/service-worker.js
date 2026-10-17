// 后台：处理弹窗/页面按钮发来的单次操作；批量任务在任务面板页面中执行
import { itemRepo, settingsRepo } from '../lib/chrome-env.js';
import { collectFromTab, extractListSkus } from '../lib/collector.js';

const DASHBOARD_URL = chrome.runtime.getURL('src/dashboard/dashboard.html');

async function openDashboard() {
  const [existing] = await chrome.tabs.query({ url: DASHBOARD_URL });
  if (existing) {
    await chrome.tabs.update(existing.id, { active: true });
    await chrome.windows.update(existing.windowId, { focused: true });
    return existing.id;
  }
  const tab = await chrome.tabs.create({ url: DASHBOARD_URL });
  return tab.id;
}

async function handleCollectTab(tabId) {
  const settings = await settingsRepo.get();
  const res = await collectFromTab(tabId, settings.collect);
  if (res.status !== 'ok') return { ok: false, error: res.message };
  const item = await itemRepo.saveCollected(res.product);
  return { ok: true, title: res.product.title, warnings: res.warnings, id: item.id };
}

async function handleExtractList(tabId) {
  const skus = (await extractListSkus(tabId)) ?? [];
  const added = await itemRepo.addSkus(skus);
  return { ok: true, found: skus.length, added: added.length };
}

const MAX_SLEEP_MS = 20000;

const handlers = {
  // 任务面板在后台时借用这里计时（见 chrome-env.js 的 sleep）
  sleep: (msg) =>
    new Promise((resolve) => setTimeout(() => resolve({ ok: true }), Math.min(Math.max(Number(msg.ms) || 0, 0), MAX_SLEEP_MS))),
  'collect-tab': (msg, sender) => handleCollectTab(msg.tabId ?? sender.tab?.id),
  'extract-list': (msg, sender) => handleExtractList(msg.tabId ?? sender.tab?.id),
  'add-skus': async (msg) => ({ ok: true, added: (await itemRepo.addSkus(msg.skus ?? [])).length }),
  'open-dashboard': async () => ({ ok: true, tabId: await openDashboard() }),
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handler = handlers[msg?.type];
  if (!handler) return false;
  Promise.resolve()
    .then(() => handler(msg, sender))
    .then(sendResponse, (e) => sendResponse({ ok: false, error: String(e?.message ?? e) }));
  return true;
});
