// 上架表 → 采集 → 发布前检查表 → 上传 → 发布：任务面板上的「上传表格」和上架表批次。
// 上传上架表：加入任务列表、记一个批次、开始采集；这批采集完（onRunEnd）自动生成并下载发布前检查表。
// 上传发布前检查表：读回所有附表、保存修改、发布齐全的商品（和「发布选中」后的发布流程相同）
import { h } from './dom.js';
import { downloadBytes, pickFile, TABLE_ACCEPT } from './download.js';
import { confirmListingUpload, confirmReviewUpload, whereText } from './upload-dialogs.js';
import { readTableBook } from '../shared/table-file.js';
import { listingEdit, parseListingBook } from '../shared/listing-sheet.js';
import { parseReviewBook, publishPlan, templateChangedIds, workbookKind } from '../shared/review-workbook-import.js';
import { reviewFileName, reviewWorkbook } from '../shared/review-workbook.js';
import { planReviewImport } from '../shared/vc-review-sheet.js';
import { buildReview, rebaseEdits, reviewTemplate } from '../shared/vc-review.js';
import { batchesToExport, batchProgress, idsToCollect, newBatch } from '../shared/batch.js';
import { isB2bItemUrl } from '../shared/url-utils.js';
import { buildXlsx } from '../shared/xlsx-write.js';
import { PUBLISH_ACTIONS } from '../shared/settings.js';
import { batchRepo, itemRepo, settingsRepo } from '../lib/chrome-env.js';
import { loadVcCatalog } from '../lib/vc-templates.js';

const REVIEW_DIR = '发布前检查';
const NOT_IN_TASKS = '这个商品不在任务列表里（已发布、已删除或还没采集），这一行没有导入';
const LOG_PROBLEMS = 30;
// 导出时间和批次记录差这么多以上，说明上传的不是最新导出的那份
const STALE_MS = 1000;

/**
 * @param {{runner: object, storage: object, onLog: (line: string) => void, reload: () => Promise<void>, confirmCooldown: () => boolean}} deps
 */
export function createBatchFlow({ runner, storage, onLog, reload, confirmCooldown }) {
  let batches = [];
  // 发布成功过的 SKU（发布成功的商品已移出任务列表，进度条里按它数“已发布”）
  let published = new Set();
  // 生成发布前检查表排队执行（采集结束自动生成和手动点的同时来时都不丢）
  let exportChain = Promise.resolve();
  let exportsPending = 0;

  const refresh = async () => {
    [batches, published] = await Promise.all([batchRepo.list(), itemRepo.publishedSkus()]);
  };

  /** 商品 → 发布前检查表的一行（编辑内容可以用导入后、还没保存的） */
  function reviewRows(ids, items, catalog, settings, drafts = new Map()) {
    const byId = new Map(items.map((i) => [i.id, i]));
    return ids
      .map((id) => byId.get(id))
      .filter((i) => i?.product)
      .map((item) => {
        const edits = drafts.get(item.id) ?? item.edits ?? {};
        const match = reviewTemplate({ product: item.product, edits, settings, catalog });
        return { item, edits, match, review: buildReview({ product: item.product, edits, settings, template: match.template }) };
      });
  }

  /** 下载，并在有存储位置权限时另存一份；返回另存的路径 */
  async function deliver(sheets, name) {
    const bytes = buildXlsx(sheets);
    downloadBytes(bytes, name);
    try {
      return await storage.saveFile(REVIEW_DIR, name, bytes);
    } catch (e) {
      onLog(`发布前检查表没有另存到存储位置：${e.message}`);
      return null;
    }
  }

  function exportBatch(batch, opts = {}) {
    exportsPending++;
    const run = exportChain
      .then(() => runExport(batch, opts))
      .finally(async () => {
        exportsPending--;
        await refresh();
        await reload();
      });
    exportChain = run.catch(() => undefined);
    return run;
  }

  async function runExport(batch, { auto = false } = {}) {
    try {
      // 自动生成：排队期间已经生成过（或被关掉）的不再生成
      const latest = (await batchRepo.list()).find((b) => b.id === batch.id);
      if (auto && (!latest || latest.exportedAt || latest.dismissed)) return;
      const [{ catalog, errors }, items, settings] = await Promise.all([loadVcCatalog(), itemRepo.findAll(), settingsRepo.get()]);
      errors.forEach(onLog);
      const rows = reviewRows(batch.skuIds, items, catalog, settings);
      const now = new Date();
      const name = reviewFileName(batch, now);
      const saved = await deliver(reviewWorkbook({ rows, catalog, items, batch, now }), name);
      await batchRepo.update(batch.id, { exportedAt: now.getTime(), exportName: name });
      const ready = rows.filter((r) => r.review.ready).length;
      onLog(
        `${auto ? `上架表「${batch.fileName}」的商品采集完了，` : ''}已生成发布前检查表 ${name}：${rows.length} 个商品，齐全 ${ready} 个，有缺项 ${rows.length - ready} 个` +
          `${saved ? `（另存到 ${saved}）` : ''}。在 Excel 里核对、补齐后，点“上传表格”上传这个文件就会发布`,
      );
    } catch (e) {
      onLog(`生成发布前检查表失败：${e.message}`);
    }
  }

  /** 每轮采集结束：采集完了、还没生成过检查表的批次自动生成 */
  async function checkBatches() {
    await refresh();
    for (const b of batchesToExport(batches, await itemRepo.findAll())) await exportBatch(b, { auto: true });
  }

  async function uploadListing(fileName, sheets) {
    const parsed = parseListingBook(sheets);
    const choice = await confirmListingUpload({ fileName, parsed, items: await itemRepo.findAll() });
    if (!choice) return onLog('已取消上传上架表');
    const local = await storage.prepare();
    const urls = Object.fromEntries(parsed.links.filter((l) => isB2bItemUrl(l.url)).map((l) => [l.skuId, l.url]));
    const res = await itemRepo.addTasks(parsed.links.map((l) => l.skuId), { urls });
    // 这批要跟进的：现在在任务列表里的（已发布过的 addTasks 跳过了，不在列表里）
    const inList = new Set((await itemRepo.findAll()).map((i) => i.id));
    const tracked = [...new Set(parsed.links.map((l) => l.skuId))].filter((id) => inList.has(id));
    const wanted = new Set(tracked);
    const skipped = res.published.filter((id) => !inList.has(id));
    const changed = await itemRepo.saveEditsMany(parsed.values.filter((v) => wanted.has(v.skuId)).map((v) => ({ id: v.skuId, edit: listingEdit(v.values) })));
    const batch = newBatch({ fileName, links: parsed.links, skuIds: tracked });
    await batchRepo.add(batch);
    const skip = skipped.length ? `，${skipped.length} 个已发布过（跳过）` : '';
    onLog(`上架表 ${fileName}：${parsed.links.length} 个商品链接，新加入 ${res.added.length} 个，已在任务列表 ${tracked.length - res.added.length} 个${skip}`);
    if (changed.length) onLog(`上架表：${changed.length} 个商品的价格 / 协议价 / ERP / 条形码 / 型号已写进「编辑」`);
    parsed.problems.slice(0, LOG_PROBLEMS).forEach((p) => onLog(`上架表${whereText(p)}：${p.text}`));
    await refresh();
    await reload();
    const ids = idsToCollect(tracked, await itemRepo.findAll(), { recollect: choice.recollect });
    if (!ids.length) {
      onLog('这批商品都已采集过，直接生成发布前检查表');
      return exportBatch(batch);
    }
    if (runner.getState().running) return onLog(`有任务正在执行：上架表里的 ${ids.length} 个商品已加入任务列表，等当前任务结束后勾选它们点“采集选中”，采集完会自动生成发布前检查表`);
    onLog(`开始采集上架表里的 ${ids.length} 个商品${local ? '（完成后自动保存到本地）' : ''}；采集完自动生成发布前检查表`);
    runner.collect(ids);
  }

  /** 表格本身的提醒：不是最新导出的那份、导出时有的附表找不到了、有些商品以前发布没成功 */
  function bookNotes(book, pub, items) {
    const notes = book.lost.length ? [`找不到这些附表（改了名字或删掉了）：${book.lost.join('、')}，里面的商品没有导入`] : [];
    const retried = pub.ready.filter((id) => ['need_action', 'failed'].includes(items.find((i) => i.id === id)?.status)).length;
    if (retried) notes.push(`将发布的商品里有 ${retried} 个以前发布过但没成功或停在发布页（需处理/失败），会再填写、发布一次；如果已经在 VC 后台手动发布过它们，请先取消，避免重复商品`);
    const batch = book.meta?.batchId ? batches.find((b) => b.id === book.meta.batchId) : null;
    const exportedAt = Date.parse(book.meta?.exportedAt ?? '');
    if (batch?.exportedAt && exportedAt && batch.exportedAt - exportedAt > STALE_MS) {
      notes.push(`这不是这批商品最新导出的发布前检查表（最新的是 ${batch.exportName}），表里没改的格子按现在的数据检查`);
    }
    return notes;
  }

  async function uploadReview(fileName, sheets) {
    const book = parseReviewBook(sheets);
    if (book.error) return onLog(`上传表格：${fileName}：${book.error}`);
    const [{ catalog, errors }, items, settings] = await Promise.all([loadVcCatalog(), itemRepo.findAll(), settingsRepo.get()]);
    errors.forEach(onLog);
    const candidates = items.filter((i) => i.product);
    const plan = planReviewImport(book.entries, { items: candidates, drafts: new Map(), catalog, settings, missingText: NOT_IN_TASKS, base: book.base });
    const drafts = new Map(plan.updates.map((u) => [u.id, u.edits]));
    const pub = publishPlan({ ids: plan.matched, items, drafts, catalog, settings, held: templateChangedIds(plan.updates) });
    const onDownloadIncomplete = async () => {
      try {
        const rows = reviewRows(pub.incomplete.map((x) => x.id), items, catalog, settings, drafts);
        const name = reviewFileName({ fileName: '还缺项' }, new Date());
        const saved = await deliver(reviewWorkbook({ rows, catalog, items }), name);
        onLog(`已下载还缺项商品的发布前检查表 ${name}${saved ? `（另存到 ${saved}）` : ''}`);
      } catch (e) {
        onLog(`还缺项商品的发布前检查表生成失败：${e.message}`);
      }
    };
    const choice = await confirmReviewUpload({ fileName, book, plan, pub, items, notes: bookNotes(book, pub, items), onDownloadIncomplete });
    if (!choice) return onLog('已取消上传发布前检查表');
    if (plan.updates.length) {
      const before = new Map(items.map((i) => [i.id, i.edits ?? {}]));
      const changed = await itemRepo.saveEditsMany(plan.updates.map((u) => ({ id: u.id, edit: (current) => rebaseEdits(before.get(u.id), u.edits, current) })));
      onLog(`发布前检查表 ${fileName}：已保存 ${changed.length} 个商品的修改`);
    }
    [...book.errors.map((e) => ({ ...e, text: e.message })), ...plan.problems].slice(0, LOG_PROBLEMS).forEach((p) => onLog(`发布前检查表${whereText(p)}：${p.text}`));
    pub.incomplete.slice(0, LOG_PROBLEMS).forEach((x) => onLog(`[${x.id}] 这次不发布：${x.reason}`));
    await reload();
    if (choice !== 'publish') return onLog('只保存了修改，没有发布');
    if (!confirmCooldown()) return;
    if (runner.getState().running) return onLog('有任务正在执行：修改已保存，等当前任务结束后勾选这些商品点“发布选中”');
    onLog(`开始发布 ${pub.ready.length} 条（填写完成后：${PUBLISH_ACTIONS[settings.publish.action] ?? settings.publish.action}）`);
    runner.publish(pub.ready);
  }

  async function handleUpload() {
    const file = await pickFile(TABLE_ACCEPT);
    if (!file) return;
    try {
      const { sheets } = await readTableBook(new Uint8Array(await file.arrayBuffer()));
      sheets.filter((s) => s.error).forEach((s) => onLog(`上传表格：${file.name} 的工作表「${s.name}」没有读：${s.error}`));
      const kind = workbookKind(sheets);
      if (kind.kind === 'listing') return await uploadListing(file.name, sheets);
      if (kind.kind === 'review') return await uploadReview(file.name, sheets);
      onLog(`上传表格：${file.name}：${kind.error}`);
    } catch (e) {
      onLog(`上传表格：${file.name} 处理失败：${e.message}`);
    }
  }

  /** 最近一个没关掉的批次的进度条 */
  function render(bar, items, busy) {
    const batch = batches.find((b) => !b.dismissed);
    bar.hidden = !batch;
    if (!batch) return bar.replaceChildren();
    const p = batchProgress(batch, items, published);
    const parts = [`共 ${p.total} 个`, `已采集 ${p.collected}`, p.waiting ? `待采集 ${p.waiting}` : '', p.failed ? `采集失败 ${p.failed}` : '', p.published ? `已发布 ${p.published}` : ''];
    const state = batch.exportedAt ? `已生成发布前检查表 ${batch.exportName}` : p.done ? '' : '采集完后自动生成发布前检查表';
    const dismiss = async () => {
      await batchRepo.update(batch.id, { dismissed: true });
      await refresh();
      await reload();
    };
    bar.replaceChildren(
      h('span', {}, `上架表「${batch.fileName}」：${parts.filter(Boolean).join(' · ')}${state ? ` · ${state}` : ''}`),
      h('button', { type: 'button', disabled: busy || exportsPending > 0 || !p.collected, onclick: () => exportBatch(batch) }, batch.exportedAt ? '重新生成发布前检查表' : '现在生成发布前检查表'),
      h('button', { type: 'button', class: 'link', onclick: dismiss }, '关闭'),
    );
  }

  return {
    refresh,
    render,
    handleUpload,
    onRunEnd: (info) => {
      if (info.mode === 'collect') checkBatches().catch((e) => onLog(`检查上架表批次失败：${e.message}`));
    },
  };
}
