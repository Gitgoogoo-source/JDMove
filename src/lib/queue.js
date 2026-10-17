// 批量任务执行器：在任务面板页面中运行（页面保持打开即可持续执行）
import { validateSettings } from '../shared/settings.js';
import { itemRepo, settingsRepo, sleep, randomBetween } from './chrome-env.js';
import { collectUrl, closeCollectTab } from './collector.js';
import { publishItem } from './publisher.js';
import { crawlShop } from './shop-crawler.js';

const MAX_LOG_LINES = 60;

/**
 * @param {{onChange: () => void, onLog: (line: string) => void}} hooks
 */
export function createQueueRunner({ onChange, onLog }) {
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

  async function collectOne(item, settings) {
    await itemRepo.update(item.id, { status: 'collecting', message: '' });
    const res = await collectUrl(item.url, settings.collect);
    if (res.status === 'ok') {
      const saved = await itemRepo.saveCollected(res.product);
      const msg = res.warnings.length ? `采集完成，但${res.warnings.join('、')}` : '采集完成';
      await itemRepo.update(saved.id, { message: msg });
      onLog(`[${item.id}] ${msg}：${res.product.title}`);
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
    const status = res.status === 'filled' ? 'need_action' : res.status;
    await itemRepo.update(item.id, { status, message: res.message, target: res.target ?? item.target });
    log(`结果：${res.message}`);
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
        const outcome = mode === 'collect' ? await collectOne(item, settings) : await publishOne(item, settings);
        if (outcome === 'pause') {
          paused = true;
          onLog(`已暂停：${state.pauseReason || '需要人工处理'}`);
          break;
        }
        if (idx < ids.length - 1) {
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

  const pageLabel = (s) => `第 ${s.pageNo}${s.pageCount ? `/${s.pageCount}` : ''} 页`;

  async function addShopPage(s) {
    const fresh = await itemRepo.addSkus(s.added);
    setState({ currentId: pageLabel(s) });
    const sofar = s.total != null ? `${s.skus.length}/${s.total}` : `${s.skus.length}`;
    onLog(`店铺${pageLabel(s)}：找到 ${s.added.length} 个商品，新增任务 ${fresh.length} 个（累计 ${sofar}）`);
  }

  // 抓取店铺全部商品链接：每抓完一页就加入任务列表，中途暂停/停止也不会丢失已抓到的商品
  async function runShop(input) {
    if (state.running) return;
    const { value: settings } = validateSettings(await settingsRepo.get());
    setState({ running: true, mode: 'shop', currentId: null, stopRequested: false, pauseReason: '', pausedMode: null });
    let paused = false;
    try {
      const res = await crawlShop(input, {
        useIncognito: settings.collect.useIncognito,
        shouldStop: () => state.stopRequested,
        onPage: addShopPage,
      });
      const found = res.state.skus.length;
      if (['throttle', 'login', 'setup'].includes(res.status)) {
        paused = true;
        setState({ pauseReason: res.message, pausedMode: 'shop' });
        onLog(`抓取店铺已暂停：${res.message}（已抓到的 ${found} 个商品已加入任务列表）`);
      } else if (res.status === 'error') {
        onLog(`抓取店铺失败：${res.message}${found ? `（已抓到的 ${found} 个商品已加入任务列表）` : ''}`);
      } else {
        onLog(`抓取店铺${res.status === 'stopped' ? '已停止' : `完成（${res.message}）`}：共找到 ${found} 个商品`);
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
    stop: () => setState({ stopRequested: true }),
  };
}
