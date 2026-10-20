// 批量任务执行器：在任务面板页面中运行（页面保持打开即可持续执行）
import { validateSettings } from '../shared/settings.js';
import { collectFailurePatch, publishResultPatch } from '../shared/store.js';
import { priceCheckPatch, priceStatus, repricePatch } from '../shared/price-watch.js';
import { itemRepo, settingsRepo, sleep, randomBetween } from './chrome-env.js';
import { collectUrl, checkPriceUrl, closeCollectTab } from './collector.js';
import { publishItem } from './publisher.js';
import { repriceItem } from './repricer.js';
import { crawlShop } from './shop-crawler.js';

const MAX_LOG_LINES = 60;
const PAUSE_STATUSES = ['throttle', 'login', 'setup'];
// 这些模式在采集窗口里打开京东商品页：结束时关闭采集标签页
const COLLECT_TAB_MODES = new Set(['collect', 'pricecheck']);

/** 价格检查结果的日志：今日价、售价和是否倒挂 */
function priceCheckLine(check, st) {
  const today = `京东今日价 ¥${check.price}${check.label ? `（${check.label}）` : ''}，售价 ¥${st.sale ?? '—'}`;
  if (st.inverted) return `${today}：价格倒挂，卖出一单亏 ¥${-st.profit}`;
  if (st.alert) return `${today}：利润仅 ¥${st.profit}，低于预警线`;
  return st.profit == null ? today : `${today}：正常（差价 ¥${st.profit}）`;
}

const SUMMARIES = {
  pricecheck: (t) =>
    `京东今日价检查结束：成功 ${(t.ok ?? 0) + (t.alert ?? 0)} 个，价格倒挂/预警 ${t.alert ?? 0} 个，失败 ${t.fail ?? 0} 个` +
    (t.alert ? '（已列在“已发布 → 价格倒挂”中，可勾选后“批量改价”）' : ''),
  reprice: (t) => `批量改价结束：成功 ${t.ok ?? 0} 个，未完成 ${t.fail ?? 0} 个${t.fail ? '（原因见各商品的状态和日志，需要处理的编辑页已保留）' : ''}`,
};

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
    const patch = collectFailurePatch(item, res);
    await itemRepo.update(item.id, patch);
    if (PAUSE_STATUSES.includes(res.status)) {
      setState({ pauseReason: res.message, pausedMode: 'collect' });
      return 'pause';
    }
    onLog(`[${item.id}] ${item.product ? patch.message : `采集失败：${res.message}`}`);
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

  // 只读取京东商品页当前显示的价格，和店铺售价对比；频控/验证/登录时整体暂停
  async function priceCheckOne(item, settings) {
    const res = await checkPriceUrl(item.url, { useIncognito: settings.collect.useIncognito });
    if (PAUSE_STATUSES.includes(res.status)) {
      setState({ pauseReason: res.message, pausedMode: 'pricecheck' });
      return 'pause';
    }
    const patch = priceCheckPatch(res, Date.now(), item.priceCheck);
    await itemRepo.update(item.id, patch);
    if (res.status !== 'ok') {
      const kept = patch.priceCheck.price > 0 ? `（保留上次的价格 ¥${patch.priceCheck.price}）` : '';
      onLog(`[${item.id}] 京东今日价获取失败：${res.message}${kept}`);
      return 'fail';
    }
    const st = priceStatus({ ...item, ...patch }, settings);
    onLog(`[${item.id}] ${priceCheckLine(patch.priceCheck, st)}`);
    return st.alert ? 'alert' : 'ok';
  }

  async function repriceOne(item, settings, price, verify) {
    const { log } = itemLogger(item.id);
    const res = await repriceItem(item, price, settings, log, { verify });
    if (res.status === 'login') {
      setState({ pauseReason: res.message, pausedMode: 'reprice' });
      return 'pause';
    }
    await itemRepo.update(item.id, repricePatch(item, { ...res, price }));
    const done = res.status === 'ok' && !res.draft;
    log(done ? `改价完成：¥${price}` : res.draft ? `新价格 ¥${price} 已保存为草稿` : `改价未完成：${res.message}`);
    return done ? 'ok' : 'fail';
  }

  /** 每种批量任务：单条处理函数 + 两条之间的间隔（秒） */
  function modeRunner(mode, settings, { prices = {}, verify = true } = {}) {
    const pw = settings.priceWatch;
    const runners = {
      collect: [(item) => collectOne(item, settings), () => randomBetween(settings.collect.minDelaySec, settings.collect.maxDelaySec)],
      publish: [(item) => publishOne(item, settings), () => settings.publish.delaySec],
      save: [(item) => saveLocalOne(item), () => 0],
      pricecheck: [(item) => priceCheckOne(item, settings), () => randomBetween(pw.minDelaySec, pw.maxDelaySec)],
      reprice: [(item) => repriceOne(item, settings, prices[item.id], verify), () => settings.publish.delaySec],
    };
    const [handle, delay] = runners[mode];
    return { handle, delay };
  }

  async function run(mode, ids, opts) {
    if (state.running) return;
    const { value: settings } = validateSettings(await settingsRepo.get());
    const { handle, delay } = modeRunner(mode, settings, opts);
    setState({ running: true, mode, stopRequested: false, pauseReason: '', pausedMode: null });
    let paused = false;
    let aborted = false;
    let tally = {};
    try {
      for (const [idx, id] of ids.entries()) {
        if (state.stopRequested) break;
        const item = await itemRepo.findById(id);
        if (!item) continue;
        setState({ currentId: id });
        const outcome = await handle(item);
        tally = { ...tally, [outcome]: (tally[outcome] ?? 0) + 1 };
        if (outcome === 'pause') {
          paused = true;
          onLog(`已暂停：${state.pauseReason || '需要人工处理'}`);
          break;
        }
        const wait = delay();
        if (idx < ids.length - 1 && wait > 0) await waitDelay(wait);
      }
    } catch (e) {
      aborted = true;
      onLog(`任务异常中止：${e.message}`);
    } finally {
      // 暂停时保留采集页：频控/验证需要用户在该页面手动处理
      if (COLLECT_TAB_MODES.has(mode) && !paused) await closeCollectTab().catch((e) => onLog(`关闭采集标签页失败：${e.message}`));
      if (SUMMARIES[mode] && !aborted) onLog(SUMMARIES[mode](tally));
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
      if (PAUSE_STATUSES.includes(res.status)) {
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
    checkPrices: (ids) => run('pricecheck', ids),
    /**
     * @param {{id: string, price: number}[]} plan 每个商品的新售价
     * @param {{verify?: boolean}} [opts] verify：改价前核对编辑页上的原价与记录的售价一致
     */
    reprice: (plan, { verify = true } = {}) =>
      run('reprice', plan.map((p) => p.id), { prices: Object.fromEntries(plan.map((p) => [p.id, p.price])), verify }),
    stop: () => setState({ stopRequested: true }),
  };
}
