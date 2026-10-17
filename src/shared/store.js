// 数据仓储：任务条目 + 设置。存储后端通过 adapter 注入，方便测试。
import { buildItemUrl } from './url-utils.js';
import { mergeSettings } from './settings.js';

const ITEMS_KEY = 'items';
const SETTINGS_KEY = 'settings';

/**
 * @typedef {'pending'|'collecting'|'collected'|'publishing'|'published'|'failed'|'need_action'} ItemStatus
 * @typedef {{id: string, skuId: string, url: string, status: ItemStatus, product: object|null,
 *   edits: object, target: object|null, message: string, log: string[], createdAt: number, updatedAt: number}} Item
 */

/** @returns {Item} */
export function newItem(skuId, now = Date.now()) {
  return {
    id: String(skuId),
    skuId: String(skuId),
    url: buildItemUrl(skuId),
    status: 'pending',
    product: null,
    edits: {},
    target: null,
    message: '',
    log: [],
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * @param {{get(key: string): Promise<any>, set(key: string, value: any): Promise<void>}} storage
 */
export function createItemRepository(storage) {
  // 串行化写操作，避免并发读改写丢数据
  let chain = Promise.resolve();
  const serial = (fn) => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => undefined);
    return run;
  };
  const load = async () => (await storage.get(ITEMS_KEY)) ?? [];
  const persist = (items) => storage.set(ITEMS_KEY, items);

  return {
    findAll: () => load(),
    findById: async (id) => (await load()).find((i) => i.id === String(id)) ?? null,

    addSkus: (skuIds) =>
      serial(async () => {
        const items = await load();
        const known = new Set(items.map((i) => i.id));
        const fresh = [...new Set(skuIds.map(String))].filter((id) => !known.has(id)).map((id) => newItem(id));
        await persist([...items, ...fresh]);
        return fresh;
      }),

    update: (id, patch) =>
      serial(async () => {
        const items = await load();
        const idx = items.findIndex((i) => i.id === String(id));
        if (idx < 0) return null;
        const next = { ...items[idx], ...patch, updatedAt: Math.max(Date.now(), items[idx].updatedAt) };
        await persist(items.map((it, i) => (i === idx ? next : it)));
        return next;
      }),

    saveCollected: (product) =>
      serial(async () => {
        const items = await load();
        const id = String(product.skuId);
        const existing = items.find((i) => i.id === id);
        const next = { ...(existing ?? newItem(id)), product, status: 'collected', message: '', updatedAt: Date.now() };
        await persist(existing ? items.map((i) => (i.id === id ? next : i)) : [...items, next]);
        return next;
      }),

    // 导入其他浏览器/用户导出的采集结果：只接受带商品数据的条目，状态统一回到“已采集”
    importItems: (list) =>
      serial(async () => {
        const valid = (Array.isArray(list) ? list : []).filter(
          (x) => x && /^\d{6,}$/.test(String(x.skuId ?? '')) && x.product && typeof x.product === 'object',
        );
        const byId = new Map((await load()).map((i) => [i.id, i]));
        for (const x of valid) {
          const id = String(x.skuId);
          const base = byId.get(id) ?? newItem(id);
          byId.set(id, { ...base, product: x.product, edits: x.edits ?? base.edits, status: 'collected', message: '导入', updatedAt: Date.now() });
        }
        await persist([...byId.values()]);
        return { imported: valid.length, skipped: (Array.isArray(list) ? list.length : 0) - valid.length };
      }),

    remove: (ids) =>
      serial(async () => {
        const drop = new Set(ids.map(String));
        await persist((await load()).filter((i) => !drop.has(i.id)));
      }),
  };
}

export function createSettingsRepository(storage) {
  return {
    get: async () => mergeSettings(await storage.get(SETTINGS_KEY)),
    save: async (settings) => {
      const merged = mergeSettings(settings);
      await storage.set(SETTINGS_KEY, merged);
      return merged;
    },
  };
}
