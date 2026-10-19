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

export const EDITED_NOTE = '已修改，尚未重新发布';
const LAST_RESULT_SEP = '｜上次结果：';
// 这些状态说明发布流程已经跑过：编辑后必须重新发布才会作用到店铺
const PUBLISH_TRIED = new Set(['need_action', 'failed', 'published']);

function lastResult(message) {
  if (!message?.startsWith(EDITED_NOTE)) return message ?? '';
  const at = message.indexOf(LAST_RESULT_SEP);
  return at < 0 ? '' : message.slice(at + LAST_RESULT_SEP.length);
}

/**
 * 编辑只改本地数据，不会动店铺后台：状态保持不变（需处理/失败的条目留在原列表里），
 * 发布过的条目在消息里提示“尚未重新发布”，同时保留上次结果
 * @param {Item} item
 * @param {object} edits
 * @returns {Item}
 */
export function applyEdits(item, edits, now = Date.now()) {
  const pending = Boolean(item.product) && PUBLISH_TRIED.has(item.status);
  const prev = lastResult(item.message);
  const message = pending ? (prev ? `${EDITED_NOTE}${LAST_RESULT_SEP}${prev}` : EDITED_NOTE) : item.message;
  return { ...item, edits, message, updatedAt: Math.max(now, item.updatedAt) };
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

    // 以存储中的最新条目为准，避免面板里的旧快照把状态写回去
    saveEdits: (id, edits) =>
      serial(async () => {
        const items = await load();
        const current = items.find((i) => i.id === String(id));
        if (!current) return null;
        const next = applyEdits(current, edits);
        await persist(items.map((i) => (i === current ? next : i)));
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
