// 测试用的最小 chrome.* 替身：模拟标签页导航（loading -> complete）、窗口与脚本注入
const tick = () => new Promise((r) => setTimeout(r, 1));

/**
 * @param {{
 *   resolveUrl?: (url: string) => string | null,  // 返回实际落地地址；返回 null 表示导航被拦截（不发生）
 *   backend?: (method: string, args: any[]) => any, // callBackend 的返回值
 *   currentWindowId?: number,
 *   page?: (call: {tab: object, func: Function, args: any[]}) => any, // 其他页面脚本（runInPage）的返回值
 * }} [opts]
 */
export function installFakeChrome({ resolveUrl = (u) => u, backend = () => undefined, currentWindowId = 7, page = () => undefined } = {}) {
  const listeners = new Set();
  const tabs = new Map();
  const calls = [];
  const sessionStore = {};
  let nextTabId = 100;
  let nextWindowId = 500;

  const emit = (id, info) => {
    const tab = { ...tabs.get(id) };
    for (const l of [...listeners]) l(id, info, tab);
  };

  function startNavigation(id, url) {
    const landed = resolveUrl(url);
    if (landed == null) return;
    setTimeout(async () => {
      tabs.set(id, { ...tabs.get(id), url: landed, status: 'loading' });
      emit(id, { status: 'loading' });
      await tick();
      tabs.set(id, { ...tabs.get(id), status: 'complete' });
      emit(id, { status: 'complete' });
    }, 1);
  }

  const chrome = {
    storage: {
      session: {
        get: async (key) => (key in sessionStore ? { [key]: sessionStore[key] } : {}),
        set: async (obj) => Object.assign(sessionStore, obj),
        remove: async (key) => {
          delete sessionStore[key];
        },
      },
      local: { get: async () => ({}), set: async () => {} },
    },
    extension: { isAllowedIncognitoAccess: async () => true },
    windows: {
      getCurrent: async () => ({ id: currentWindowId, type: 'normal', incognito: false }),
      getLastFocused: async () => ({ id: currentWindowId, type: 'normal', incognito: false }),
      get: async (id) => {
        throw new Error(`No window with id: ${id}`);
      },
      create: async (opts) => {
        const id = nextWindowId++;
        calls.push({ op: 'windows.create', opts });
        return { id, incognito: !!opts.incognito };
      },
    },
    tabs: {
      onUpdated: { addListener: (l) => listeners.add(l), removeListener: (l) => listeners.delete(l) },
      create: async ({ windowId, url, active }) => {
        const id = nextTabId++;
        calls.push({ op: 'tabs.create', windowId, url, active });
        tabs.set(id, { id, windowId, url: 'about:blank', status: 'loading', incognito: false });
        startNavigation(id, url);
        return { ...tabs.get(id) };
      },
      update: async (id, { url }) => {
        calls.push({ op: 'tabs.update', tabId: id, url });
        startNavigation(id, url);
        return { ...tabs.get(id) };
      },
      get: async (id) => {
        if (!tabs.has(id)) throw new Error(`No tab with id: ${id}`);
        return { ...tabs.get(id) };
      },
      remove: async (id) => {
        calls.push({ op: 'tabs.remove', tabId: id });
        tabs.delete(id);
      },
    },
    scripting: {
      executeScript: async ({ target, func, files, args = [] }) => {
        if (files) {
          calls.push({ op: 'inject.files', tabId: target.tabId });
          return [{ result: undefined }];
        }
        calls.push({ op: 'inject.func', tabId: target.tabId, name: func.name, func, args });
        const isBackendCall = typeof args[0] === 'string' && Array.isArray(args[1]);
        const result = isBackendCall ? backend(args[0], args[1]) : await page({ tab: { ...tabs.get(target.tabId) }, func, args });
        return [{ result }];
      },
    },
  };

  globalThis.chrome = chrome;
  return {
    calls,
    tabs,
    ops: () => calls.map((c) => c.op),
    /** 把已有标签页设为某个地址且已加载完成（模拟停留在某页） */
    seedTab: (tab) => tabs.set(tab.id, { status: 'complete', incognito: false, ...tab }),
  };
}
