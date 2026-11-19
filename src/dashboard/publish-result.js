// 每轮发布结束后的「发布结果」弹窗：哪些成功（已记入上架总表）、哪些失败（带原因）；
// 有失败的商品时自动生成并下载「失败表格」（设置了存储位置时另存到 存储位置/发布结果/）
import { h, openDialog } from './dom.js';
import { downloadBytes } from './download.js';
import { failureFileName, failureSheet, publishReport } from '../shared/publish-report.js';
import { buildXlsx } from '../shared/xlsx-write.js';
import { itemRepo } from '../lib/chrome-env.js';

const RESULT_DIR = '发布结果';
const LIST_MAX = 200;
const TITLE_MAX = 36;
// 成功的商品不多时直接展开列表
const OPEN_SUCCESS_MAX = 10;

const short = (s) => (s.length > TITLE_MAX ? `${s.slice(0, TITLE_MAX)}…` : s);

function runNote({ paused, stopped, aborted, pauseReason }) {
  if (aborted) return '任务异常中止，后面的商品没有发布。';
  if (paused) return `任务已暂停：${pauseReason || '需要人工处理'}，后面的商品没有发布。`;
  if (stopped) return '任务被停止，后面的商品没有发布。';
  return '';
}

function listBlock(entries, line, cls) {
  const shown = entries.slice(0, LIST_MAX);
  return [
    h('ul', { class: 'import-problems' }, ...shown.map((e) => h('li', { class: cls }, line(e)))),
    entries.length > shown.length ? h('small', { class: 'muted' }, `只显示前 ${shown.length} 个，全部见失败表格`) : null,
  ];
}

function failedBox(report, file, actions) {
  if (!report.failed.length) return null;
  const where = file.saved ? `（另存到 ${file.saved}）` : '';
  return h(
    'div',
    {},
    h('strong', {}, `失败 ${report.failed.length} 个（留在任务列表）`),
    ...listBlock(report.failed, (e) => `SKU ${e.id} ${short(e.title)}【${e.statusText}】${e.reason}`, 'error'),
    h('p', {}, file.error ? h('span', { class: 'import-error' }, `失败表格生成失败：${file.error}`) : `失败表格已下载：${file.name}${where}`),
    h(
      'div',
      { class: 'result-actions' },
      file.error ? null : h('button', { type: 'button', onclick: actions.redownload }, '再下载一次失败表格'),
      h('button', { type: 'button', onclick: actions.exportReview }, `下载这 ${report.failed.length} 个商品的发布前检查表`),
    ),
    h('small', { class: 'muted' }, '发布前检查表改好后点“上传表格”上传，会再发布一次。'),
  );
}

function succeededBox(report) {
  if (!report.succeeded.length) return null;
  const line = (e) => `SKU ${e.id} → 京东商品编码 ${e.skus.length ? e.skus.join('、') : '（没拿到）'}  ${short(e.name || e.title)}`;
  return h(
    'details',
    { open: report.succeeded.length <= OPEN_SUCCESS_MAX },
    h('summary', {}, `成功 ${report.succeeded.length} 个（已记入上架总表，已移出任务列表）`),
    ...listBlock(report.succeeded, line, ''),
  );
}

/**
 * @param {{report: import('../shared/publish-report.js').PublishReport, info: object, master: {state: string, text: string}|null,
 *   file: {name?: string, saved?: string|null, error?: string}, actions: {redownload: () => void, exportReview: () => void}}} input
 */
function showResultDialog({ report, info, master, file, actions }) {
  const note = runNote(info);
  const masterLine = master && master.state !== 'none' ? h('p', { class: master.state === 'written' ? '' : 'import-error' }, master.text) : null;
  const dialog = h(
    'dialog',
    { class: 'wide' },
    h(
      'form',
      { method: 'dialog' },
      h('div', { class: 'dlg-head' }, '发布结果'),
      h(
        'div',
        { class: 'dlg-body' },
        h('p', { class: 'import-summary' }, `本次发布 ${report.total} 个商品：成功 ${report.succeeded.length} 个，失败 ${report.failed.length} 个`),
        note ? h('p', { class: 'import-error' }, note) : null,
        masterLine,
        failedBox(report, file, actions),
        succeededBox(report),
      ),
      h('div', { class: 'dlg-foot' }, h('button', { value: 'close', class: 'primary' }, '知道了')),
    ),
  );
  return openDialog(dialog);
}

/**
 * @param {{storage: {saveFile: (dir: string, name: string, data: Uint8Array) => Promise<string|null>},
 *   onLog: (line: string) => void, exportReview: (ids: string[], label: string) => Promise<void>}} deps
 *   exportReview：给这些商品生成发布前检查表（batch-flow 提供）
 */
export function createPublishResult({ storage, onLog, exportReview }) {
  /** 生成并下载失败表格；有存储位置时另存一份 */
  async function deliverFailures(failed, now) {
    const name = failureFileName(now);
    const bytes = buildXlsx([failureSheet(failed, now)]);
    downloadBytes(bytes, name);
    let saved = null;
    try {
      saved = await storage.saveFile(RESULT_DIR, name, bytes);
    } catch (e) {
      onLog(`失败表格没有另存到存储位置：${e.message}`);
    }
    onLog(`已生成失败表格 ${name}：${failed.length} 个商品${saved ? `（另存到 ${saved}）` : ''}`);
    return { name, saved, bytes };
  }

  /**
   * 每轮发布结束：等上架总表写完，汇总结果、下载失败表格、弹出结果
   * @param {import('../lib/queue.js').RunEndInfo} info
   * @param {Promise<{state: string, text: string}|null>} masterWrite 上架总表的写入结果
   */
  async function onRunEnd(info, masterWrite) {
    if (info.mode !== 'publish') return;
    const [master, items] = await Promise.all([masterWrite, itemRepo.findAll()]);
    const report = publishReport({ ...info, items });
    if (!report.total) return;
    onLog(`本次发布 ${report.total} 个商品：成功 ${report.succeeded.length} 个，失败 ${report.failed.length} 个`);
    let file = {};
    if (report.failed.length) {
      try {
        file = await deliverFailures(report.failed, new Date());
      } catch (e) {
        onLog(`失败表格生成失败：${e.message}`);
        file = { error: e.message };
      }
    }
    const actions = {
      redownload: () => file.bytes && downloadBytes(file.bytes, file.name),
      exportReview: () => exportReview(report.failed.map((e) => e.id), '发布失败').catch((e) => onLog(`发布前检查表生成失败：${e.message}`)),
    };
    await showResultDialog({ report, info, master, file, actions });
  }

  return {
    onRunEnd: (info, masterWrite) => onRunEnd(info, masterWrite).catch((e) => onLog(`发布结果汇总失败：${e.message}`)),
  };
}
