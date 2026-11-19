// 上架总表的记录（chrome.storage.local）：发布成功就先记在这里，任务结束后再写进总表文件；
// 文件写不进去（没设置位置、没授权、文件被占用）时记录不丢，下次再写
export const MASTER_KEY = 'masterRecords';
// 已写进文件的记录只留最近这么多条（文件才是总表；这里留着方便排查）
export const MASTER_WRITTEN_KEEP = 2000;

/**
 * @param {{get(key: string): Promise<any>, set(key: string, value: any): Promise<void>}} storage
 */
export function createMasterRepository(storage) {
  let chain = Promise.resolve();
  const serial = (fn) => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => undefined);
    return run;
  };
  /** @returns {Promise<import('./master-sheet.js').MasterRecord[]>} */
  const load = async () => (await storage.get(MASTER_KEY)) ?? [];
  const isPending = (r) => !r.writtenAt;

  return {
    list: () => load(),
    pending: async () => (await load()).filter(isPending),

    /** @param {import('./master-sheet.js').MasterRecord[]} records */
    add: (records) =>
      serial(async () => {
        if (!records.length) return;
        const list = await load();
        const ids = new Set(list.map((r) => r.id));
        await storage.set(MASTER_KEY, [...list, ...records.filter((r) => !ids.has(r.id))]);
      }),

    /** 标记已写进文件；只保留最近 MASTER_WRITTEN_KEEP 条已写的记录 */
    markWritten: (ids, now = Date.now()) =>
      serial(async () => {
        const done = new Set(ids);
        const marked = (await load()).map((r) => (done.has(r.id) ? { ...r, writtenAt: now } : r));
        const written = marked.filter((r) => !isPending(r));
        const keep = new Set(written.slice(-MASTER_WRITTEN_KEEP).map((r) => r.id));
        await storage.set(MASTER_KEY, marked.filter((r) => isPending(r) || keep.has(r.id)));
      }),
  };
}
