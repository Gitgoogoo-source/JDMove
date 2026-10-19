// 任务面板里的“存储位置”：选择文件夹、申请权限、把商品写到本地
import { chooseStorageRoot, accessStorageRoot } from '../lib/storage-location.js';
import { saveItemToFolder, removeItemFolder } from '../lib/local-store.js';

const UNSET_HINT = '还没有设置存储位置，采集结果只保存在插件里。点击“存储位置”选择一个文件夹后，采集时会自动按“品牌/SKU”保存图片和商品信息。';

/**
 * @param {{onLog: (line: string) => void, onChange: () => void}} hooks
 */
export function createStorageController({ onLog, onChange }) {
  let current = { handle: null, state: 'unset' };
  let hintShown = false;

  const update = (next) => {
    current = next;
    onChange();
  };

  async function refresh(interactive) {
    try {
      update(await accessStorageRoot({ interactive }));
    } catch (e) {
      onLog(`存储位置不可用：${e.message}`);
      update({ handle: current.handle, state: 'denied' });
    }
    return current.state;
  }

  return {
    label() {
      if (current.state === 'unset') return '存储位置：未设置';
      const name = current.handle?.name ?? '';
      return current.state === 'granted' ? `存储位置：${name}` : `存储位置：${name}（需授权）`;
    },
    title: () => (current.state === 'granted' ? '采集结果保存在：所选文件夹/品牌/SKU/' : '点击选择或重新授权存储文件夹'),
    init: () => refresh(false),

    /** 点击“存储位置”：已有文件夹但未授权时先授权，否则重新选择 */
    async choose() {
      if (current.state === 'prompt' && (await refresh(true)) === 'granted') {
        onLog(`已授权存储位置：${current.handle.name}`);
        return;
      }
      try {
        const handle = await chooseStorageRoot();
        if (!handle) return;
        await refresh(true);
        onLog(`存储位置已设为：${handle.name}（商品会保存到 ${handle.name}/品牌/SKU/）`);
      } catch (e) {
        onLog(`选择存储位置失败：${e.message}`);
      }
    },

    /**
     * 在用户点击时调用：需要时申请权限。required=true 时没有存储位置会弹出选择窗口
     * @returns {Promise<boolean>} 是否可以写入本地
     */
    async prepare({ required = false } = {}) {
      if (current.state === 'unset' && required) await this.choose();
      else if (current.state !== 'granted') await refresh(true);
      if (current.state === 'granted') return true;
      if (current.state === 'unset' && !hintShown) {
        hintShown = true;
        onLog(UNSET_HINT);
      } else if (current.state !== 'unset') {
        onLog('没有获得存储文件夹的写入权限，本次不会保存到本地');
      }
      return false;
    },

    /** 在用户点击时调用：已设置存储位置但未授权时申请权限，不弹出选择窗口 */
    async ensureAccess() {
      if (current.state === 'prompt') await refresh(true);
      return current.state === 'granted';
    },
    isSet: () => current.state !== 'unset',

    /** 删除商品的本地文件夹；没有权限时返回 null */
    removeFolder: (item) => (current.state === 'granted' ? removeItemFolder(current.handle, item) : Promise.resolve(null)),

    /** 交给任务执行器使用；没有权限时返回 null（跳过本地保存） */
    save: (item) => (current.state === 'granted' ? saveItemToFolder(current.handle, item) : Promise.resolve(null)),
  };
}
