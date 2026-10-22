// 数据仓储：任务条目 + 设置。存储后端通过 adapter 注入，方便测试。
import { buildItemUrl } from './url-utils.js';
import { mergeSettings } from './settings.js';
import { isArchived } from './brand-folders.js';
import { normalizeWareId } from './price-watch.js';

const ITEMS_KEY = 'items';
const SETTINGS_KEY = 'settings';
// 发布成功过的 SKU（skuId → 发布时间）：任务删除后仍保留，重新添加链接/抓取店铺时据此去重
const PUBLISHED_KEY = 'publishedSkus';
// 最近一次京麦提交接口限流（被拒时间、建议冷却到的时间）
export const THROTTLE_KEY = 'publishThrottle';

/**
 * @typedef {'pending'|'collecting'|'collected'|'publishing'|'published'|'failed'|'need_action'} ItemStatus
 * @typedef {{id: string, skuId: string, url: string, status: ItemStatus, product: object|null,
 *   edits: object, target: object|null, message: string, log: string[], createdAt: number, updatedAt: number,
 *   publishedAt?: number, salePrice?: number, shopWareId?: string, priceCheck?: object, reprice?: object}} Item
 *   publishedAt：最近一次发布成功的时间，有值的条目显示在“已发布”页；salePrice：店铺里的售价（发布/改价时记录）；
 *   shopWareId：店铺商品编号（改价时打开编辑页用）；priceCheck：最近一次京东今日价检查；reprice：最近一次改价结果
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

const canonical = (v) => {
  if (Array.isArray(v)) return v.map(canonical);
  if (!v || typeof v !== 'object') return v;
  const entries = Object.keys(v)
    .sort()
    .map((k) => [k, canonical(v[k])])
    .filter(([, x]) => x !== undefined);
  return entries.length ? Object.fromEntries(entries) : undefined;
};

/** 两份编辑内容是否相同：忽略键顺序、未填写的项和空的属性覆盖 */
export const editsEqual = (a, b) => JSON.stringify(canonical(a ?? {}) ?? {}) === JSON.stringify(canonical(b ?? {}) ?? {});

/**
 * 发布结果写回条目的字段：发布成功时记下 publishedAt，条目随之移到“已发布”页；
 * 同时记下店铺里的售价和商品编号（以后检查价格倒挂、改价用）。重新发布会生成新商品，
 * 没拿到新编号时清掉旧编号，避免改价改到旧商品上
 * @param {Item} item
 * @param {{status: string, message: string, target?: object, price?: number, wareId?: string}} res publishItem 的结果
 */
export function publishResultPatch(item, res, now = Date.now()) {
  // 京麦限流时没有提交成功：回到“已采集”，冷却后点“发布选中”会重新发布；
  // “已发布”页里重新发布的商品按失败处理，仍留在“已发布”页
  const throttled = isArchived(item) ? 'failed' : 'collected';
  const status = { filled: 'need_action', throttle: throttled }[res.status] ?? res.status;
  const patch = { status, message: res.message, target: res.target ?? item.target };
  if (status !== 'published') return patch;
  const price = res.price > 0 ? { salePrice: res.price } : {};
  return { ...patch, publishedAt: now, ...price, shopWareId: normalizeWareId(res.wareId) };
}

export const RETURNED_NOTE = '已从“已发布”退回任务列表（店铺里的商品不受影响）';
// 店铺里那件商品的记录：退回任务列表后不再对应任何店铺商品，重新发布会生成新商品
const SHOP_FIELDS = ['publishedAt', 'salePrice', 'shopWareId', 'priceCheck', 'reprice'];

/**
 * 已发布商品退回任务列表的“已采集”：保留商品数据、编辑和本地保存记录，清掉店铺售价/编号/价格检查
 * @param {Item} item
 * @returns {Item}
 */
export function returnToTasksPatch(item, now = Date.now()) {
  const rest = Object.fromEntries(Object.entries(item).filter(([k]) => !SHOP_FIELDS.includes(k)));
  return { ...rest, status: 'collected', message: RETURNED_NOTE, updatedAt: Math.max(now, item.updatedAt) };
}

const RECOLLECT_BLOCKED = new Set(['collecting', 'publishing']);

/** 任务列表里采集过的商品可以重新采集（覆盖商品数据，编辑保留）；已发布的要先退回任务列表 */
export const canRecollect = (item) => Boolean(item?.product) && !isArchived(item) && !RECOLLECT_BLOCKED.has(item.status);

/**
 * 批量重新采集：只取勾选里可以重新采集的商品；没勾选时不默认全部（重新采集很慢，还会覆盖数据）
 * @param {Item[]} items
 * @param {Set<string>} selectedIds
 * @returns {{ids: string[], skipped: number}}
 */
export function pickRecollect(items, selectedIds) {
  const chosen = items.filter((i) => selectedIds.has(i.id));
  const ids = chosen.filter(canRecollect).map((i) => i.id);
  return { ids, skipped: chosen.length - ids.length };
}

// 首次采集遇到频控/验证/登录时回到“待采集”，处理后点“采集选中”继续
const PAUSE_COLLECT_STATUSES = new Set(['throttle', 'login', 'setup']);

/**
 * 采集没成功时写回条目的字段。重新采集（已有商品数据）时保留原状态和上次采集的数据，
 * 不把能发布的商品变成“失败/待采集”
 * @param {Item} item 采集前的条目
 * @param {{status: string, message: string}} res collectUrl 的结果
 */
export function collectFailurePatch(item, res) {
  if (item.product) {
    const status = item.status === 'collecting' ? 'collected' : item.status;
    return { status, message: `重新采集失败：${res.message}（保留上次采集的数据）` };
  }
  return { status: PAUSE_COLLECT_STATUSES.has(res.status) ? 'pending' : 'failed', message: res.message };
}

/** 已发布条目对应的全部 SKU：条目本身 + 一起发布的规格 SKU（同一商品换个颜色的链接也算已发布） */
function archivedSkuIds(item) {
  if (!isArchived(item)) return [];
  const variants = (item.product?.variants ?? []).map((v) => String(v?.skuId ?? ''));
  return [...new Set([item.id, String(item.product?.skuId ?? ''), ...variants])].filter(Boolean);
}

/**
 * 已发布过的 SKU：记录表 + 当前列表里的已发布条目（兼容加记录表之前发布的商品）
 * @param {object[]} items
 * @param {Record<string, number>} [registry]
 * @returns {Set<string>}
 */
export function publishedSkuSet(items, registry = {}) {
  return new Set([...Object.keys(registry ?? {}), ...items.flatMap(archivedSkuIds)]);
}

/**
 * 新链接分组：新增 / 已发布过（跳过）/ 已在列表里
 * @param {string[]} skuIds
 * @param {object[]} items
 * @param {Set<string>} published
 * @param {{includePublished?: boolean}} [opts] includePublished=true 时已发布过的也重新加入任务
 */
export function planNewSkus(skuIds, items, published, { includePublished = false } = {}) {
  const known = new Set(items.map((i) => i.id));
  const unique = [...new Set(skuIds.map(String))];
  const isPublished = (id) => !includePublished && published.has(id);
  return {
    fresh: unique.filter((id) => !known.has(id) && !isPublished(id)),
    published: unique.filter((id) => isPublished(id)),
    existing: unique.filter((id) => known.has(id) && !isPublished(id)),
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
  const loadPublished = async () => (await storage.get(PUBLISHED_KEY)) ?? {};
  // 记进已发布记录（已有的保留原来的时间）：条目离开“已发布”页后，重新添加同一商品仍会被跳过
  const rememberPublished = async (skuIds) => {
    if (!skuIds.length) return;
    const registry = await loadPublished();
    const now = Date.now();
    const fresh = Object.fromEntries(skuIds.filter((id) => !(id in registry)).map((id) => [id, now]));
    await storage.set(PUBLISHED_KEY, { ...registry, ...fresh });
  };

  /**
   * 批量加入任务：已在列表里的不重复添加，已发布过的商品默认跳过
   * @returns {Promise<{added: Item[], published: string[], existing: string[]}>}
   */
  const addTasks = (skuIds, opts = {}) =>
    serial(async () => {
      const [items, registry] = await Promise.all([load(), loadPublished()]);
      const plan = planNewSkus(skuIds, items, publishedSkuSet(items, registry), opts);
      const added = plan.fresh.map((id) => newItem(id));
      if (added.length) await persist([...items, ...added]);
      return { added, published: plan.published, existing: plan.existing };
    });

  return {
    findAll: () => load(),
    findById: async (id) => (await load()).find((i) => i.id === String(id)) ?? null,

    addTasks,
    addSkus: async (skuIds) => (await addTasks(skuIds)).added,

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

    // taskId：任务自己的 SKU（链接里的编码）；页面报告的 SKU 不同时也写回原任务，不会多出一条
    saveCollected: (product, taskId = product.skuId) =>
      serial(async () => {
        const items = await load();
        const id = String(taskId);
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

    // 删除已发布的条目时把它的 SKU 记进已发布记录，之后重新添加同一商品仍会被跳过
    remove: (ids) =>
      serial(async () => {
        const drop = new Set(ids.map(String));
        const items = await load();
        await rememberPublished(items.filter((i) => drop.has(i.id)).flatMap(archivedSkuIds));
        await persist(items.filter((i) => !drop.has(i.id)));
      }),

    /**
     * 已发布商品退回任务列表的“已采集”状态；不是已发布（或没有商品数据）的条目跳过
     * @returns {Promise<{returned: string[], skipped: string[]}>}
     */
    returnToTasks: (ids) =>
      serial(async () => {
        const wanted = new Set(ids.map(String));
        const items = await load();
        const targets = items.filter((i) => wanted.has(i.id) && isArchived(i) && i.product);
        const hit = new Set(targets.map((i) => i.id));
        await rememberPublished(targets.flatMap(archivedSkuIds));
        if (targets.length) await persist(items.map((i) => (hit.has(i.id) ? returnToTasksPatch(i) : i)));
        return { returned: [...hit], skipped: [...wanted].filter((id) => !hit.has(id)) };
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

/**
 * 京麦提交接口限流的记录（throttleRecord）：冷却期内发布前提醒，之后发布成功时清除
 * @returns {{get: () => Promise<{at: number, until: number, message: string} | null>, set: (record: object) => Promise<void>,
 *   clear: () => Promise<void>}}
 */
export function createThrottleRepository(storage) {
  return {
    get: async () => (await storage.get(THROTTLE_KEY)) ?? null,
    set: (record) => storage.set(THROTTLE_KEY, record),
    clear: () => storage.set(THROTTLE_KEY, null),
  };
}
