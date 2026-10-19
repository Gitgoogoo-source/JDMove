// 限制并发数的异步 map（纯函数，不依赖浏览器环境）

/**
 * 最多同时执行 limit 个 fn，结果按输入顺序返回。
 * 任一任务出错时整体失败，并且不再启动新任务；signal 取消后同样不再启动新任务，未启动的项结果为 undefined
 * @template T, R
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T, index: number) => Promise<R>} fn
 * @param {{signal?: AbortSignal}} [opts]
 * @returns {Promise<Array<R|undefined>>}
 */
export async function mapPool(items, limit, fn, { signal } = {}) {
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError(`并发数必须是正整数：${limit}`);
  const results = new Array(items.length).fill(undefined);
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (next < items.length && !failed && !signal?.aborted) {
      const index = next++;
      try {
        results[index] = await fn(items[index], index);
      } catch (e) {
        failed = true;
        throw e;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
