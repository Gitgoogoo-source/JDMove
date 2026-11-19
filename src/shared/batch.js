// 上架表批次：上传一张上架表就记一个批次（这张表的商品），用来判断这批商品采集完了没有、
// 采集完自动生成「发布前检查」表、在任务面板上显示进度。存储后端通过 adapter 注入，方便测试
export const BATCHES_KEY = 'listingBatches';
export const MAX_BATCHES = 20;
const WAITING = new Set(['pending', 'collecting']);

/**
 * @typedef {{id: string, fileName: string, createdAt: number, links: import('./listing-sheet.js').ListingLink[], skuIds: string[],
 *   exportedAt?: number, exportName?: string, dismissed?: boolean}} Batch
 *   skuIds：这批要跟进的商品（上架表里加入任务列表的商品）；exportedAt/exportName：最近一次生成发布前检查表；
 *   dismissed：在任务面板上关掉了进度条
 */

/** @returns {Batch} */
export function newBatch({ fileName, links, skuIds, now = Date.now() }) {
  return { id: `b${now}`, fileName: String(fileName ?? ''), createdAt: now, links: links ?? [], skuIds: [...new Set((skuIds ?? []).map(String))] };
}

/**
 * 批次进度。done：没有待采集/采集中的商品了（采集失败也算结束，失败原因写在发布前检查表的汇总里）
 * @param {Batch} batch
 * @param {object[]} items 任务条目
 * @param {Set<string>} [published] 发布成功过的 SKU（发布成功的商品已移出任务列表）
 * @returns {{total: number, collected: number, failed: number, waiting: number, published: number, removed: number, done: boolean}}
 *   published：发布成功、已移出任务列表的；removed：从任务列表删掉的
 */
export function batchProgress(batch, items, published = new Set()) {
  const byId = new Map(items.map((i) => [i.id, i]));
  const tally = { total: batch.skuIds.length, collected: 0, failed: 0, waiting: 0, published: 0, removed: 0 };
  for (const id of batch.skuIds) {
    const item = byId.get(id);
    const key = !item ? (published.has(id) ? 'published' : 'removed') : WAITING.has(item.status) ? 'waiting' : item.product ? 'collected' : 'failed';
    tally[key]++;
  }
  return { ...tally, done: tally.waiting === 0 };
}

/**
 * 上传上架表后要采集哪些：任务列表里还没采集到数据的（勾选“重新采集”时已采集的也采），正在采集的不动
 * @param {string[]} ids 这批的商品
 * @param {object[]} items 任务条目
 * @param {{recollect?: boolean}} [opts]
 * @returns {string[]}
 */
export function idsToCollect(ids, items, { recollect = false } = {}) {
  const byId = new Map(items.map((i) => [i.id, i]));
  return ids.filter((id) => {
    const item = byId.get(id);
    return Boolean(item) && item.status !== 'collecting' && (recollect || !item.product);
  });
}

/**
 * 一轮采集结束后要自动生成发布前检查表的批次：采集完了、还没生成过、没被关掉的
 * @param {Batch[]} batches
 * @param {object[]} items
 * @returns {Batch[]}
 */
export function batchesToExport(batches, items) {
  return batches.filter((b) => !b.exportedAt && !b.dismissed && batchProgress(b, items).done);
}

export function createBatchRepository(storage) {
  let chain = Promise.resolve();
  const serial = (fn) => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => undefined);
    return run;
  };
  const load = async () => (await storage.get(BATCHES_KEY)) ?? [];
  return {
    /** 最近的在前 */
    list: () => load(),
    add: (batch) => serial(async () => storage.set(BATCHES_KEY, [batch, ...(await load()).filter((b) => b.id !== batch.id)].slice(0, MAX_BATCHES))),
    update: (id, patch) =>
      serial(async () => {
        const list = await load();
        const current = list.find((b) => b.id === id);
        if (!current) return null;
        const next = { ...current, ...patch };
        await storage.set(BATCHES_KEY, list.map((b) => (b === current ? next : b)));
        return next;
      }),
  };
}
