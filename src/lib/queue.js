// 批量任务执行器：在任务面板页面中运行（页面保持打开即可持续执行）
import { validateSettings } from '../shared/settings.js';
import { publishResultPatch } from '../shared/store.js';
import { itemRepo, settingsRepo, sleep, randomBetween } from './chrome-env.js';
import { collectUrl, closeCollectTab } from './collector.js';
import { publishItem } from './publisher.js';
import { crawlShop } from './shop-crawler.js';

const MAX_LOG_LINES = 60;

/**
 * @param {{onChange: () => void, onLog: (line: string) => void,
 *   saveLocal?: (item: object) => Promise<{dir: string, saved: number, failed: string[]}|null>}} hooks
 *   saveLocal 把商品写到本地存储位置；未设置存储位置时返回 null
 */
export function createQueueRunner({ onChange, onLog, saveLocal = async () => null }) {
  let state = { running: false, mode: null, currentId: null, stopRequested: false, pauseReason: '', pausedMode: null };
  const setState = (patch) => {
    state = { ...state, ...patch };
    onChange();
  };

  const itemLogger = (id) => {
    let lines = [];
    return {
      log: (msg) => {
        const line = `${new Date().toLocaleTimeString()} ${msg}`;
        lines = [...lines, line].slice(-MAX_LOG_LINES);
        onLog(`[${id}] ${msg}`);
        itemRepo.update(id, { log: lines });
      },
    };
  };

  async function waitDelay(seconds) {
    const end = Date.now() + seconds * 1000;
    while (Date.now() < end && !state.stopRequested) await sleep(250);
  }

  async function saveLocalOne(item) {
    try {
      const res = await saveLocal(item);
      if (!res) return 'skip';
      await itemRepo.update(item.id, { local: { dir: res.dir, savedAt: Date.now(), failed: res.failed.length } });
      const miss = res.failed.length ? `，${res.failed.length} 张下载失败：${res.failed.join('、')}` : '';
      onLog(`[${item.id}] 已保存到本地：${res.dir}（图片 ${res.saved} 张${miss}）`);
      return 'ok';
    } catch (e) {
      await itemRepo.update(item.id, { local: { ...(item.local ?? {}), error: e.message } });
      onLog(`[${item.id}] 保存到本地失败：${e.message}`);
      return 'fail';
    }
  }

  async function collectOne(item, settings) {
    await itemRepo.update(item.id, { status: 'collecting', message: '' });
    const res = await collectUrl(item.url, settings.collect);
    if (res.status === 'ok') {
      const saved = await itemRepo.saveCollected(res.product, item.id);
      const msg = res.warnings.length ? `采集完成，但${res.warnings.join('、')}` : '采集完成';
      await itemRepo.update(saved.id, { message: msg });
      onLog(`[${item.id}] ${msg}：${res.product.title}`);
      await saveLocalOne(saved);
      return 'ok';
    }
    if (['throttle', 'login', 'setup'].includes(res.status)) {
      await itemRepo.update(item.id, { status: 'pending', message: res.message });
      setState({ pauseReason: res.message, pausedMode: 'collect' });
      return 'pause';
    }
    await itemRepo.update(item.id, { status: 'failed', message: res.message });
    onLog(`[${item.id}] 采集失败：${res.message}`);
    return 'fail';
  }

  async function publishOne(item, settings) {
    await itemRepo.update(item.id, { status: 'publishing', message: '' });
    const { log } = itemLogger(item.id);
    const res = await publishItem(item, settings, log);
    const patch = publishResultPatch(item, res);
    await itemRepo.update(item.id, patch);
    log(`结果：${res.message}${patch.publishedAt ? '（已移到“已发布”）' : ''}`);
    return res.message?.includes('重新登录') ? 'pause' : 'ok';
  }

  async function run(mode, ids) {
    if (state.running) return;
    const { value: settings } = validateSettings(await settingsRepo.get());
    setState({ running: true, mode, stopRequested: false, pauseReason: '', pausedMode: null });
    let paused = false;
    try {
      for (const [idx, id] of ids.entries()) {
        if (state.stopRequested) break;
        const item = await itemRepo.findById(id);
        if (!item) continue;
        setState({ currentId: id });
        const outcome =
          mode === 'collect' ? await collectOne(item, settings) : mode === 'save' ? await saveLocalOne(item) : await publishOne(item, settings);
        if (outcome === 'pause') {
          paused = true;
          onLog(`已暂停：${state.pauseReason || '需要人工处理'}`);
          break;
        }
        if (idx < ids.length - 1 && mode !== 'save') {
          const wait =
            mode === 'collect'
              ? randomBetween(settings.collect.minDelaySec, settings.collect.maxDelaySec)
              : settings.publish.delaySec;
          await waitDelay(wait);
        }
      }
    } catch (e) {
      onLog(`任务异常中止：${e.message}`);
    } finally {
      // 暂停时保留采集页：频控/验证需要用户在该页面手动处理
      if (mode === 'collect' && !paused) await closeCollectTab().catch((e) => onLog(`关闭采集标签页失败：${e.message}`));
      setState({ running: false, currentId: null, mode: null });
    }
  }

  const pageLabel = (s) => `${s.label ? `${s.label} ` : ''}第 ${s.pageNo}${s.pageCount ? `/${s.pageCount}` : ''} 页`;

  /** 每抓完一页就加入任务列表；已发布过的商品默认跳过，返回本页跳过的数量 */
  async function addShopPage(s, includePublished) {
    const { added, published } = await itemRepo.addTasks(s.added, { includePublished });
    setState({ currentId: pageLabel(s) });
    const listTotal = s.total != null ? `，本列表共 ${s.total} 件` : '';
    const skip = published.length ? `，跳过已发布 ${published.length} 个` : '';
    onLog(`店铺${pageLabel(s)}：新找到 ${s.added.length} 个商品，新增任务 ${added.length} 个${skip}（累计 ${s.skus.length}${listTotal}）`);
    return published.length;
  }

  // 抓取店铺全部商品链接：每抓完一页就加入任务列表，中途暂停/停止也不会丢失已抓到的商品
  async function runShop(input, { includePublished = false } = {}) {
    if (state.running) return;
    const { value: settings } = validateSettings(await settingsRepo.get());
    setState({ running: true, mode: 'shop', currentId: null, stopRequested: false, pauseReason: '', pausedMode: null });
    let paused = false;
    let skipped = 0;
    try {
      const res = await crawlShop(input, {
        useIncognito: settings.collect.useIncognito,
        shouldStop: () => state.stopRequested,
        onPage: async (s) => {
          skipped += await addShopPage(s, includePublished);
        },
      });
      const found = res.state.skus.length;
      const kept = skipped ? `已加入任务列表，其中 ${skipped} 个已发布过，已跳过` : '已加入任务列表';
      const skipNote = skipped ? `，其中 ${skipped} 个已发布过，未加入任务列表` : '';
      if (['throttle', 'login', 'setup'].includes(res.status)) {
        paused = true;
        setState({ pauseReason: res.message, pausedMode: 'shop' });
        onLog(`抓取店铺已暂停：${res.message}（已抓到的 ${found} 个商品${kept}）`);
      } else if (res.status === 'error') {
        onLog(`抓取店铺失败：${res.message}${found ? `（已抓到的 ${found} 个商品${kept}）` : ''}`);
      } else {
        onLog(res.status === 'stopped' ? `抓取店铺已停止：共找到 ${found} 个商品${skipNote}` : `抓取店铺完成：${res.message}${skipNote}`);
      }
    } catch (e) {
      onLog(`抓取店铺异常中止：${e.message}`);
    } finally {
      // 暂停时保留店铺页：频控/验证需要用户在该页面手动处理
      if (!paused) await closeCollectTab().catch((e) => onLog(`关闭采集标签页失败：${e.message}`));
      setState({ running: false, currentId: null, mode: null });
    }
  }

  return {
    getState: () => state,
    crawlShop: runShop,
    collect: (ids) => run('collect', ids),
    publish: (ids) => run('publish', ids),
    saveLocal: (ids) => run('save', ids),
    stop: () => setState({ stopRequested: true }),
  };
}
