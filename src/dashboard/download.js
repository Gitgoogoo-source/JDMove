// 任务面板里的文件下载 / 选择
import { h } from './dom.js';

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export const TABLE_ACCEPT = '.xlsx,.csv,.tsv,.txt,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv';
const REVOKE_AFTER_MS = 5000;

/** 把内容下载成文件（浏览器的下载栏里能看到） */
export function downloadBytes(bytes, name, type = XLSX_MIME) {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  h('a', { href: url, download: name }).click();
  setTimeout(() => URL.revokeObjectURL(url), REVOKE_AFTER_MS);
}

/**
 * 弹出选择文件窗口；取消时返回 null
 * @param {string} accept
 * @returns {Promise<File|null>}
 */
export function pickFile(accept) {
  const input = h('input', { type: 'file', accept, hidden: true });
  document.body.append(input);
  return new Promise((resolve) => {
    const done = (file) => {
      input.remove();
      resolve(file);
    };
    input.addEventListener('change', () => done(input.files?.[0] ?? null), { once: true });
    input.addEventListener('cancel', () => done(null), { once: true });
    input.click();
  });
}
