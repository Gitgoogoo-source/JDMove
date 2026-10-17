// 批量任务执行器：在任务面板页面中运行（页面保持打开即可持续执行）
import { validateSettings } from '../shared/settings.js';
import { itemRepo, settingsRepo, sleep, randomBetween } from './chrome-env.js';
import { collectUrl } from './collector.js';
import { publishItem } from './publisher.js';

const MAX_LOG_LINES = 60;

/**
 * @param {{onChange: () => void, onLog: (line: string) => void}} hooks
 */
export function createQueueRunner({ onChange, onLog }) {
  let state = { running: false, mode: null, currentId: null, stopRequested: false, pauseReason: '' };
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
      setState({ pauseReason: res.message });
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
    setState({ running: true, mode, stopRequested: false, pauseReason: '' });
    try {
      for (const [idx, id] of ids.entries()) {
        if (state.stopRequested) break;
        const item = await itemRepo.findById(id);
        if (!item) continue;
        setState({ currentId: id });
        const outcome = mode === 'collect' ? await collectOne(item, settings) : await publishOne(item, settings);
        if (outcome === 'pause') {
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
      setState({ running: false, currentId: null, mode: null });
    }
  }

  return {
    getState: () => state,
    collect: (ids) => run('collect', ids),
    publish: (ids) => run('publish', ids),
    stop: () => setState({ stopRequested: true }),
  };
}
