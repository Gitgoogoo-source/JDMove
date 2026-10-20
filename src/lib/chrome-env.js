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

const SW_SLEEP_MAX_MS = 20000;
const timerSleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pageHidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';

/**
 * 任务面板切到后台超过 5 分钟后，Chrome 会把连续的定时器限流到约每分钟一次，批量任务看起来就像卡住了。
 * 面板在后台时改由 Service Worker 计时：每次唤醒都是一条扩展消息，不受这种限流。
 */
export async function sleep(ms) {
  if (!pageHidden()) return timerSleep(ms);
  for (let left = ms; left > 0; left -= SW_SLEEP_MAX_MS) {
    const chunk = Math.min(left, SW_SLEEP_MAX_MS);
    try {
      await chrome.runtime.sendMessage({ type: 'sleep', ms: chunk });
    } catch {
      await timerSleep(chunk);
    }
  }
}
export const randomBetween = (min, max) => min + Math.random() * Math.max(0, max - min);

const INCOGNITO_WINDOW_KEY = 'collectIncognitoWindowId';
const NAV_START_TIMEOUT_MS = 8000;
const NAV_LOAD_TIMEOUT_MS = 45000;
export const NAV_BLOCKED_MSG = '页面没有跳转（可能被“离开此网站？”拦截），请关闭该提示后重试';

async function existingWindow(id) {
  if (!id) return null;
  try {
    return await chrome.windows.get(id);
  } catch {
    return null;
  }
}

/** 任务面板所在的浏览器窗口；取不到时退回最近使用的普通窗口 */
async function currentNormalWindow() {
  try {
    const win = await chrome.windows.getCurrent();
    if (win && win.type === 'normal' && !win.incognito) return win;
  } catch {
    /* 非页面环境没有“当前窗口” */
  }
  return chrome.windows.getLastFocused({ windowTypes: ['normal'] });
}

/**
 * 工作窗口：发布/普通采集直接用当前浏览器窗口（新开标签页）；
 * 无痕采集需要独立的无痕窗口（独立 Cookie，可登录消费者账号）。
 */
export async function getWorkWindow({ incognito = false } = {}) {
  if (!incognito) return currentNormalWindow();
  const { [INCOGNITO_WINDOW_KEY]: id } = await chrome.storage.session.get(INCOGNITO_WINDOW_KEY);
  const win = await existingWindow(id);
  if (win) return win;
  if (!(await chrome.extension.isAllowedIncognitoAccess())) {
    throw new Error('请在 chrome://extensions 中打开本插件的“在无痕模式下启用”，或在设置中关闭“无痕窗口采集”');
  }
  const created = await chrome.windows.create({ url: 'about:blank', focused: false, width: 1366, height: 900, incognito });
  await chrome.storage.session.set({ [INCOGNITO_WINDOW_KEY]: created.id });
  return created;
}

export function waitForTabComplete(tabId, timeoutMs = NAV_LOAD_TIMEOUT_MS) {
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

/**
 * 等待一次新的导航：必须先进入 loading 再 complete。
 * 页面拦截跳转时不会进入 loading，此时报错，而不是把旧页面当成新页面继续执行。
 */
function waitForNavigation(tabId, { startTimeoutMs = NAV_START_TIMEOUT_MS, timeoutMs = NAV_LOAD_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    let started = false;
    const startTimer = setTimeout(() => started || finish(new Error(NAV_BLOCKED_MSG)), startTimeoutMs);
    const loadTimer = setTimeout(() => finish(new Error('页面加载超时')), timeoutMs);
    function finish(err, tab) {
      clearTimeout(startTimer);
      clearTimeout(loadTimer);
      chrome.tabs.onUpdated.removeListener(listener);
      if (err) reject(err);
      else resolve(tab);
    }
    function listener(id, info, tab) {
      if (id !== tabId) return;
      if (info.status === 'loading') started = true;
      else if (info.status === 'complete' && started) finish(null, tab);
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

/**
 * 屏蔽页面的“离开此网站？”确认：工作标签页由插件驱动，跳转/关闭时不需要确认，
 * 否则 Chrome 弹窗会挡住跳转，任务一直卡住。
 */
export async function disarmBeforeUnload(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: function disarmBeforeUnloadInPage() {
        window.onbeforeunload = null;
        if (window.__JDMOVE_UNLOAD_DISARMED__) return;
        window.__JDMOVE_UNLOAD_DISARMED__ = true;
        // 京麦发布页（micro-app）的监听会先于我们追加的监听执行，抢顺序拦不住；
        // 直接让页面里的 preventDefault / returnValue 对 beforeunload 失效，Chrome 就不会弹确认框
        const proto = BeforeUnloadEvent.prototype;
        Object.defineProperty(proto, 'returnValue', { configurable: true, get: () => '', set: () => {} });
        Object.defineProperty(proto, 'preventDefault', { configurable: true, writable: true, value: () => {} });
        Object.defineProperty(window, 'onbeforeunload', { configurable: true, get: () => null, set: () => {} });
      },
    });
  } catch {
    /* about:blank、无权限页面或已关闭的标签页：没有需要屏蔽的提示 */
  }
}

/** 在工作窗口中新开标签页（保持激活，页面动画/弹层才能正常工作）并等待加载完成 */
export async function openWorkTab(url, { incognito = false } = {}) {
  const win = await getWorkWindow({ incognito });
  const tab = await chrome.tabs.create({ windowId: win.id, url, active: true });
  await sleep(300);
  return waitForTabComplete(tab.id);
}

/**
 * 激活标签页并把它所在的窗口切到前台（最小化的先恢复）。
 * 窗口被遮挡或最小化时 Chrome 不渲染页面，京东商品页的详情区（视口内才加载）就不会加载。
 * @returns {Promise<boolean>} 是否切换成功；标签页/窗口已关闭时为 false
 */
export async function bringTabToFront(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    await chrome.tabs.update(tabId, { active: true });
    const win = await chrome.windows.get(tab.windowId);
    await chrome.windows.update(win.id, win.state === 'minimized' ? { state: 'normal', focused: true } : { focused: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * 在已有标签页中跳转并等待新页面加载完成
 * @param {{startTimeoutMs?: number, timeoutMs?: number}} [opts]
 */
export async function navigateTab(tabId, url, opts) {
  await disarmBeforeUnload(tabId);
  const navigated = waitForNavigation(tabId, opts);
  try {
    await chrome.tabs.update(tabId, { url });
  } catch (e) {
    navigated.catch(() => undefined);
    throw e;
  }
  return navigated;
}

/**
 * 等标签页落到符合 pattern 的地址（页面自己跳转，如提交后跳到成功页）
 * @returns {Promise<string>} 落地地址；超时或标签页已关闭时返回 ''
 */
export async function waitForTabUrl(tabId, pattern, timeoutMs = 5000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    let tab;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch {
      return '';
    }
    if (tab.url && pattern.test(tab.url)) return tab.url;
    if (Date.now() >= end) return '';
    await timerSleep(200);
  }
}

export async function closeTab(tabId) {
  await disarmBeforeUnload(tabId);
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
export const ITEM_FILES = ['src/inject/jd-price.js', 'src/inject/jd-detail.js', 'src/inject/jd-item-extract.js'];
export const SHOP_FILES = ['src/inject/jd-shop-list.js'];

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
