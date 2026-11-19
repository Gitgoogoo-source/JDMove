// 任务面板里的“上架总表”：选总表所在的文件夹（一般是项目根目录）、授权、把发布成功的商品写进 上架总表.xlsx
import { chooseMasterDir, accessMasterDir } from '../lib/storage-location.js';
import { appendMasterFile } from '../lib/master-file.js';
import { MASTER_FILE_NAME } from '../shared/master-sheet.js';

const UNSET_HINT = `还没有设置上架总表的位置：点“上架总表”选择项目根目录，发布成功的商品会写进 ${MASTER_FILE_NAME}`;

/**
 * @param {{masterRepo: ReturnType<typeof import('../shared/master-store.js').createMasterRepository>,
 *   onLog: (line: string) => void, onChange: () => void}} deps
 */
export function createMasterController({ masterRepo, onLog, onChange }) {
  let current = { handle: null, state: 'unset' };
  let pending = 0;
  let writing = false;

  async function refresh(interactive = false) {
    try {
      current = await accessMasterDir({ interactive });
    } catch (e) {
      onLog(`上架总表的文件夹不可用：${e.message}`);
      current = { handle: current.handle, state: 'denied' };
    }
    pending = (await masterRepo.pending()).length;
    onChange();
    return current.state;
  }

  /** 把待写入的记录写进文件；没有权限时只提示（任务结束时不能弹授权窗口，要等用户点击） */
  async function flush() {
    const records = await masterRepo.pending();
    pending = records.length;
    if (!records.length || writing) return onChange();
    if (current.state !== 'granted') {
      onLog(current.state === 'unset' ? `${records.length} 个商品待写入上架总表。${UNSET_HINT}` : `${records.length} 个商品待写入上架总表：请点“上架总表”授权写入 ${current.handle?.name ?? ''}/${MASTER_FILE_NAME}`);
      return onChange();
    }
    writing = true;
    try {
      const res = await appendMasterFile(current.handle, records);
      await masterRepo.markWritten([...res.added, ...res.duplicate]);
      const dup = res.duplicate.length ? `，${res.duplicate.length} 个商品编码已在总表里（没有重复写）` : '';
      onLog(`已写入上架总表 ${res.file}：新增 ${res.added.length} 行${dup}，总表共 ${res.rows} 行`);
    } catch (e) {
      onLog(`写入上架总表失败（记录还在，下次任务结束或点“上架总表”时再写）：${e.message}`);
    } finally {
      writing = false;
      pending = (await masterRepo.pending()).length;
      onChange();
    }
  }

  return {
    init: () => refresh(false),
    label() {
      const wait = pending ? `（待写入 ${pending}）` : '';
      if (current.state === 'unset') return `上架总表：未设置${wait}`;
      const name = current.handle?.name ?? '';
      return current.state === 'granted' ? `上架总表：${name}${wait}` : `上架总表：${name}（需授权）${wait}`;
    },
    title: () =>
      current.state === 'unset'
        ? `选择项目根目录：发布成功的商品写进这个文件夹里的 ${MASTER_FILE_NAME}`
        : `发布成功的商品写进 ${current.handle?.name ?? ''}/${MASTER_FILE_NAME}；点击授权并写入待写入的商品，没有待写入的时可以更换文件夹`,

    /** 点击“上架总表”：未设置时选文件夹；需授权时授权；有待写入的就写；都写完了时可以换文件夹 */
    async click() {
      if (current.state === 'prompt' || current.state === 'denied') await refresh(true);
      const choose = current.state === 'unset' || (current.state === 'granted' && !pending && confirm(`没有待写入的商品。要更换上架总表所在的文件夹吗？（现在是 ${current.handle?.name}）`));
      if (choose) {
        try {
          const handle = await chooseMasterDir();
          if (!handle) return;
          await refresh(true);
          onLog(`上架总表位置已设为：${handle.name}/${MASTER_FILE_NAME}`);
        } catch (e) {
          return onLog(`选择上架总表的文件夹失败：${e.message}`);
        }
      }
      await flush();
    },

    /** 每轮发布结束后写文件 */
    onRunEnd(info) {
      if (info.mode === 'publish') flush().catch((e) => onLog(`写入上架总表失败：${e.message}`));
    },

    /** 有新记录时更新按钮上的待写入数量 */
    refreshPending: async () => {
      pending = (await masterRepo.pending()).length;
      onChange();
    },
  };
}
