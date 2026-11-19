// 数据仓储：任务条目 + 设置。存储后端通过 adapter 注入，方便测试。
import { buildItemUrl, isB2bItemUrl } from './url-utils.js';
import { mergeSettings } from './settings.js';

const ITEMS_KEY = 'items';
const SETTINGS_KEY = 'settings';
// 发布成功过的 SKU（skuId → 发布时间）：只用来在上架表批次进度里数“已发布”；不拿来去重——
// 同一个参考链接会上架多次（常规价、促销价各一个），重新添加/上传总是加入任务列表（用户 2026-11-20 要求）
const PUBLISHED_KEY = 'publishedSkus';
// 最近一次保存接口限流（被拒时间、建议冷却到的时间）
export const THROTTLE_KEY = 'publishThrottle';

/**
 * 发布成功的商品写进上架总表（master-sheet.js）后移出任务列表，所以列表里没有“已发布”的条目
 * @typedef {'pending'|'collecting'|'collected'|'publishing'|'failed'|'need_action'} ItemStatus
 * @typedef {{id: string, skuId: string, url: string, status: ItemStatus, product: object|null,
 *   edits: object, target: object|null, message: string, log: string[], createdAt: number, updatedAt: number}} Item
 */

/** @returns {Item} */
export function newItem(skuId, now = Date.now(), url = buildItemUrl(skuId)) {
  return {
    id: String(skuId),
    skuId: String(skuId),
    url,
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

// 任务链接跟着实际采集的页面走（价格检查、重新采集都打开它）：万商和 item.jd.com 是两个价格体系
function sourceUrlPatch(skuId, product) {
  if (!product?.url) return {};
  return { url: isB2bItemUrl(product.url) ? product.url : buildItemUrl(skuId) };
}

export const EDITED_NOTE = '已修改，尚未重新发布';
export const INTERRUPTED_NOTE = '上次采集没有完成（任务面板被关闭或浏览器重启），请重新采集';
const LAST_RESULT_SEP = '｜上次结果：';
// 这些状态说明发布流程已经跑过：编辑后必须重新发布才会作用到店铺
const PUBLISH_TRIED = new Set(['need_action', 'failed']);

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
 * 发布没成功时写回条目的字段（发布成功的条目移出任务列表，不走这里）：
 * 限流时没有保存成功，回到“已采集”，冷却后点“发布选中”会重新发布；停在发布页等人工处理的记作“需处理”
 * @param {Item} item
 * @param {{status: string, message: string, target?: object}} res publishVcItem 的结果
 */
export function publishResultPatch(item, res) {
  const status = { filled: 'need_action', throttle: 'collected' }[res.status] ?? res.status;
  return { status, message: res.message, target: res.target ?? item.target };
}

const RECOLLECT_BLOCKED = new Set(['collecting', 'publishing']);

/** 任务列表里采集过的商品可以重新采集（覆盖商品数据，编辑保留） */
export const canRecollect = (item) => Boolean(item?.product) && !RECOLLECT_BLOCKED.has(item.status);

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

/** 发布成功的条目对应的全部 SKU：条目本身 + 一起发布的规格 SKU（同一商品换个颜色的链接也算已发布） */
function publishedSkuIds(item) {
  const variants = (item.product?.variants ?? []).map((v) => String(v?.skuId ?? ''));
  return [...new Set([item.id, String(item.product?.skuId ?? ''), ...variants])].filter(Boolean);
}

/**
 * 已发布过的 SKU（记录表）
 * @param {Record<string, number>} [registry]
 * @returns {Set<string>}
 */
export const publishedSkuSet = (registry = {}) => new Set(Object.keys(registry ?? {}));

/** 旧版本“已发布”页里的条目：发布成功后留在列表里（现在发布成功就移出任务列表） */
const isLegacyPublished = (item) => item.status === 'published' || item.publishedAt > 0;

/**
 * 新链接分组：新增 / 已在列表里。以前发布过的商品也算新增（同一商品会以不同售价多次上架）
 * @param {string[]} skuIds
 * @param {object[]} items
 * @returns {{fresh: string[], existing: string[]}}
 */
export function planNewSkus(skuIds, items) {
  const known = new Set(items.map((i) => i.id));
  const unique = [...new Set(skuIds.map(String))];
  return {
    fresh: unique.filter((id) => !known.has(id)),
    existing: unique.filter((id) => known.has(id)),
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
  // 记进已发布记录（已有的保留原来的时间）：上架表批次进度按它数“已发布”
  const rememberPublished = async (skuIds) => {
    if (!skuIds.length) return;
    const registry = await loadPublished();
    const now = Date.now();
    const fresh = Object.fromEntries(skuIds.filter((id) => !(id in registry)).map((id) => [id, now]));
    await storage.set(PUBLISHED_KEY, { ...registry, ...fresh });
  };

  /**
   * 批量加入任务：已在列表里的不重复添加；以前发布过的商品照样加入（不去重）。
   * opts.urls（SKU → 链接）指定采集用的链接（京东万商），已在列表里的商品也改用这个链接
   * @returns {Promise<{added: Item[], existing: string[]}>}
   */
  const addTasks = (skuIds, { urls = {} } = {}) =>
    serial(async () => {
      const items = await load();
      const plan = planNewSkus(skuIds, items);
      const added = plan.fresh.map((id) => newItem(id, Date.now(), urls[id]));
      const retargeted = items.map((i) => (plan.existing.includes(i.id) && urls[i.id] ? { ...i, url: urls[i.id] } : i));
      if (added.length || plan.existing.some((id) => urls[id])) await persist([...retargeted, ...added]);
      return { added, existing: plan.existing };
    });

  return {
    findAll: () => load(),
    /** 发布成功过的 SKU（上架表批次进度里数“已发布”用） */
    publishedSkus: async () => publishedSkuSet(await loadPublished()),
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

    /**
     * 批量修改编辑内容（表格导入）：每条用 edit(当前编辑内容) 算出新的编辑内容，以存储里的最新条目为准，只写一次。
     * 编辑内容没有变化的条目不动
     * @param {{id: string, edit: (edits: object, item: Item) => object}[]} changes edit 返回原编辑内容（或相同内容）表示不改
     * @returns {Promise<string[]>} 实际修改了的条目 id
     */
    saveEditsMany: (changes) =>
      serial(async () => {
        const byId = new Map(changes.map((c) => [String(c.id), c.edit]));
        const items = await load();
        const changed = [];
        const next = items.map((item) => {
          const edit = byId.get(item.id);
          if (!edit) return item;
          const edits = edit(item.edits ?? {}, item);
          if (editsEqual(item.edits, edits)) return item;
          changed.push(item.id);
          return applyEdits(item, edits);
        });
        if (changed.length) await persist(next);
        return changed;
      }),

    // taskId：任务自己的 SKU（链接里的编码）；页面报告的 SKU 不同时也写回原任务，不会多出一条
    saveCollected: (product, taskId = product.skuId) =>
      serial(async () => {
        const items = await load();
        const id = String(taskId);
        const existing = items.find((i) => i.id === id);
        const next = { ...(existing ?? newItem(id)), ...sourceUrlPatch(id, product), product, status: 'collected', message: '', updatedAt: Date.now() };
        await persist(existing ? items.map((i) => (i.id === id ? next : i)) : [...items, next]);
        return next;
      }),

    /**
     * 任务在任务面板里执行：面板被关掉、浏览器重启时正在采集的条目会一直停在“采集中”（之后的采集、上架表批次都会跳过/等着它）。
     * 打开面板时（这时没有任务在执行）改回：有数据的回到“已采集”，没有的回到“待采集”
     * @returns {Promise<string[]>} 改回的条目
     */
    recoverInterrupted: () =>
      serial(async () => {
        const items = await load();
        const stuck = items.filter((i) => i.status === 'collecting').map((i) => i.id);
        if (stuck.length) {
          await persist(items.map((i) => (i.status === 'collecting' ? { ...i, status: i.product ? 'collected' : 'pending', message: INTERRUPTED_NOTE } : i)));
        }
        return stuck;
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
          byId.set(id, { ...base, ...sourceUrlPatch(id, x.product), product: x.product, edits: x.edits ?? base.edits, status: 'collected', message: '导入', updatedAt: Date.now() });
        }
        await persist([...byId.values()]);
        return { imported: valid.length, skipped: (Array.isArray(list) ? list.length : 0) - valid.length };
      }),

    remove: (ids) =>
      serial(async () => {
        const drop = new Set(ids.map(String));
        await persist((await load()).filter((i) => !drop.has(i.id)));
      }),

    /**
     * 发布成功：记进已发布记录（批次进度用），移出任务列表（商品已写进上架总表）；之后可以再次添加同一商品重新上架
     * @returns {Promise<Item|null>} 移出的条目
     */
    finishPublished: (id) =>
      serial(async () => {
        const items = await load();
        const item = items.find((i) => i.id === String(id));
        if (!item) return null;
        await rememberPublished(publishedSkuIds(item));
        await persist(items.filter((i) => i !== item));
        return item;
      }),

    /**
     * 删掉旧版本“已发布”页里的条目（用户 2026-11-20 确认可以删）：只删任务记录，不动店铺和本地文件夹
     * @returns {Promise<string[]>} 删掉的条目
     */
    dropLegacyPublished: () =>
      serial(async () => {
        const items = await load();
        const legacy = items.filter(isLegacyPublished).map((i) => i.id);
        if (legacy.length) await persist(items.filter((i) => !isLegacyPublished(i)));
        return legacy;
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
