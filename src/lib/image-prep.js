// 发布用图片的提前处理：打开发布页之前就开始下载/压缩，和打开页面、选类目、填属性同时进行，
// 填到主图那一步时图片通常已经处理好，不用再等
import { mapPool } from '../shared/async-pool.js';
import { makeMainImage, makeDetailImages, makeTransparentImage } from './images.js';

export const IMAGE_CONCURRENCY = 4;
export const MAX_DETAIL_SLICES = 40;

/** 并发处理，结果按原顺序展开；单张失败只记日志 */
async function processImages(urls, maker, log, signal) {
  const made = await mapPool(
    urls,
    IMAGE_CONCURRENCY,
    async (url, i) => {
      try {
        return await maker(url, i);
      } catch (e) {
        log(`图片处理失败：${e.message}`);
        return [];
      }
    },
    { signal },
  );
  return made.flatMap((m) => (m == null ? [] : m));
}

/**
 * @param {{sku: string, mainImageUrls: string[], detailImageUrls: string[], reuploadDetail: boolean, transparentUrl?: string|null}} input
 *   transparentUrl：VC 发布页的透图用哪张图生成（PNG）
 * @param {{log: (msg: string) => void, timer?: {record: (label: string, ms: number) => void},
 *   makers?: {main?: Function, detail?: Function, transparent?: Function}, now?: () => number}} deps
 * @returns {{main: Promise<object[]>, detail: Promise<object[]>, transparent: Promise<object|null>, cancel: () => void}}
 *   cancel 之后不再开始新的图片（已经开始的会处理完）
 */
export function startImagePrep({ sku, mainImageUrls, detailImageUrls, reuploadDetail, transparentUrl = null }, { log, timer, makers = {}, now = Date.now }) {
  const { main: makeMain = makeMainImage, detail: makeDetail = makeDetailImages, transparent: makeTransparent = makeTransparentImage } = makers;
  const controller = new AbortController();
  const timed = async (label, count, work) => {
    const t0 = now();
    const out = await work();
    timer?.record(`后台${label} ${count} 张`, now() - t0);
    return out;
  };

  const main = timed('主图处理', mainImageUrls.length, () =>
    processImages(mainImageUrls, (u, i) => makeMain(u, `jdmove_${sku}_m${i}.jpg`), log, controller.signal),
  );
  const stamp = now() % 1e6;
  // 详情图排在主图之后，不和主图抢带宽
  const detail =
    reuploadDetail && detailImageUrls.length
      ? main.then(() =>
          timed('详情图处理', detailImageUrls.length, async () =>
            (await processImages(detailImageUrls, (u, i) => makeDetail(u, `jdmove_${sku}_d${i}_${stamp}`), log, controller.signal)).slice(
              0,
              MAX_DETAIL_SLICES,
            ),
          ),
        )
      : Promise.resolve([]);
  // 透图和主图同时处理（只有一张）；失败时为 null，由发布流程决定怎么提示
  const transparent = transparentUrl
    ? timed('透图处理', 1, () => makeTransparent(transparentUrl, `jdmove_${sku}_t.png`)).catch((e) => {
        log(`透图生成失败：${e.message}`);
        return null;
      })
    : Promise.resolve(null);
  // 提前结束（需处理/失败）时没人 await 这两个 Promise：先标记为已处理，避免出现未处理的 rejection
  main.catch(() => undefined);
  detail.catch(() => undefined);
  return { main, detail, transparent, cancel: () => controller.abort() };
}
