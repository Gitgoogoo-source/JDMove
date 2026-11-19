// 本地存储位置：用户在任务面板里选择的文件夹（FileSystemDirectoryHandle 存在 IndexedDB 里，下次打开面板继续使用）。
// 两个文件夹：存储位置（采集的图片和商品信息）、上架总表所在的文件夹（一般选项目根目录，用户自己提交到 GitHub）
const DB_NAME = 'jdmove';
const STORE = 'handles';
const ROOT_KEY = 'storageRoot';
const PICKER_ID = 'jdmove-storage';
const MASTER_KEY = 'masterDir';
const MASTER_PICKER_ID = 'jdmove-master';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore(mode, fn) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

/** @returns {Promise<FileSystemDirectoryHandle|null>} */
const getHandle = async (key) => (await withStore('readonly', (s) => s.get(key))) ?? null;

/**
 * 弹出系统的“选择文件夹”窗口（必须由用户点击触发）
 * @returns {Promise<FileSystemDirectoryHandle|null>} 用户取消时返回 null
 */
async function chooseHandle(key, pickerId) {
  if (typeof window.showDirectoryPicker !== 'function') throw new Error('当前浏览器不支持选择本地文件夹，请使用最新版 Chrome');
  try {
    const handle = await window.showDirectoryPicker({ id: pickerId, mode: 'readwrite' });
    await withStore('readwrite', (s) => s.put(handle, key));
    return handle;
  } catch (e) {
    if (e?.name === 'AbortError') return null;
    throw e;
  }
}

/**
 * 检查（interactive=true 时申请）读写权限。Chrome 重启后通常需要在用户点击时重新授权一次。
 * @returns {Promise<{handle: FileSystemDirectoryHandle|null, state: 'unset'|'granted'|'prompt'|'denied'}>}
 */
async function accessHandle(key, { interactive = false } = {}) {
  const handle = await getHandle(key);
  if (!handle) return { handle: null, state: 'unset' };
  const opts = { mode: 'readwrite' };
  let state = await handle.queryPermission(opts);
  if (state === 'prompt' && interactive) state = await handle.requestPermission(opts);
  return { handle, state };
}

export const getStorageRoot = () => getHandle(ROOT_KEY);
export const chooseStorageRoot = () => chooseHandle(ROOT_KEY, PICKER_ID);
export const accessStorageRoot = (opts) => accessHandle(ROOT_KEY, opts);

/** 上架总表所在的文件夹（上架总表.xlsx 写在这个文件夹里） */
export const chooseMasterDir = () => chooseHandle(MASTER_KEY, MASTER_PICKER_ID);
export const accessMasterDir = (opts) => accessHandle(MASTER_KEY, opts);
