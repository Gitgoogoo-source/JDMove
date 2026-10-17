// chrome.* 封装：存储适配器、工作窗口与标签页、页面脚本执行
import { createItemRepository, createSettingsRepository } from '../shared/store.js';

export const chromeStorage = {
  async get(key) {
    const res = await chrome.storage.local.get(key);
    return res[key];
  },
  async set(key, value) {
    await chrome.storage.local.set({ [key]: value });
  },
};

export const itemRepo = createItemRepository(chromeStorage);
export const settingsRepo = createSettingsRepository(chromeStorage);

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const randomBetween = (min, max) => min + Math.random() * Math.max(0, max - min);

const WINDOW_KEYS = { normal: 'workWindowId', incognito: 'collectIncognitoWindowId' };

async function existingWindow(id) {
  if (!id) return null;
  try {
    return await chrome.windows.get(id);
  } catch {
    return null;
  }
}

/**
 * 专用工作窗口：发布在普通窗口（商家登录态）；采集可在无痕窗口（独立 Cookie，可登录消费者账号）。
 * 窗口保持可见（非最小化），页面的动画/弹层才能正常工作。
 */
export async function getWorkWindow({ incognito = false } = {}) {
  const key = incognito ? WINDOW_KEYS.incognito : WINDOW_KEYS.normal;
  const { [key]: id } = await chrome.storage.session.get(key);
  const win = await existingWindow(id);
  if (win) return win;
  if (incognito && !(await chrome.extension.isAllowedIncognitoAccess())) {
    throw new Error('请在 chrome://extensions 中打开本插件的“在无痕模式下启用”，或在设置中关闭“无痕窗口采集”');
  }
  const created = await chrome.windows.create({ url: 'about:blank', focused: false, width: 1366, height: 900, incognito });
  await chrome.storage.session.set({ [key]: created.id });
  return created;
}

export function waitForTabComplete(tabId, timeoutMs = 45000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error('页面加载超时'));
    }, timeoutMs);
    function listener(id, info, tab) {
      if (id === tabId && info.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve(tab);
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId).then((tab) => {
      if (tab.status === 'complete' && tab.url && tab.url !== 'about:blank') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve(tab);
      }
    }, reject);
  });
}

/** 在工作窗口中新开标签页并等待加载完成 */
export async function openWorkTab(url, { incognito = false } = {}) {
  const win = await getWorkWindow({ incognito });
  const tab = await chrome.tabs.create({ windowId: win.id, url, active: true });
  await sleep(300);
  return waitForTabComplete(tab.id);
}

export async function navigateTab(tabId, url) {
  await chrome.tabs.update(tabId, { url });
  await sleep(300);
  return waitForTabComplete(tabId);
}

export async function closeTab(tabId) {
  try {
    await chrome.tabs.remove(tabId);
  } catch {
    /* 标签页可能已被用户关闭 */
  }
}

/**
 * 在页面主世界执行：先注入脚本文件，再调用 func(...args)
 * @returns {Promise<any>}
 */
export async function runInPage(tabId, files, func, args = []) {
  if (files.length) await chrome.scripting.executeScript({ target: { tabId }, files, world: 'MAIN' });
  const [res] = await chrome.scripting.executeScript({ target: { tabId }, func, args, world: 'MAIN' });
  if (res && res.error) throw new Error(res.error.message || String(res.error));
  return res ? res.result : undefined;
}

export const BACKEND_FILES = ['src/inject/backend-core.js', 'src/inject/backend-media.js'];
export const ITEM_FILES = ['src/inject/jd-item-extract.js'];

/** 调用后台桥接 API：window.__JDMOVE__.backend[method](...args) */
export function callBackend(tabId, method, ...args) {
  return runInPage(
    tabId,
    BACKEND_FILES,
    async (name, params) => {
      const api = window.__JDMOVE__ && window.__JDMOVE__.backend;
      if (!api || typeof api[name] !== 'function') return { ok: false, error: `桥接方法不存在：${name}` };
      try {
        return await api[name](...params);
      } catch (e) {
        return { ok: false, error: String((e && e.message) || e) };
      }
    },
    [method, args],
  );
}
