// 把待写入的总表记录追加到 <总表文件夹>/上架总表.xlsx：先读出文件里原有的工作表，原样保留，再在总表后面加新行
import { readXlsxSheets } from '../shared/xlsx-read.js';
import { buildXlsx } from '../shared/xlsx-write.js';
import { MASTER_FILE_NAME, mergeMasterRows, masterSheetSpec, pickMasterSheet } from '../shared/master-sheet.js';

/** 读出总表文件的全部工作表；文件还不存在时返回 [] */
async function readExisting(dir) {
  let handle;
  try {
    handle = await dir.getFileHandle(MASTER_FILE_NAME);
  } catch (e) {
    if (e?.name === 'NotFoundError') return [];
    throw e;
  }
  const bytes = new Uint8Array(await (await handle.getFile()).arrayBuffer());
  if (!bytes.length) return [];
  try {
    return await readXlsxSheets(bytes);
  } catch (e) {
    // 读不了时不能覆盖：否则原来的总表就没了
    throw new Error(`${MASTER_FILE_NAME} 读不出来（${e.message}），没有写入，请检查这个文件是不是损坏了`);
  }
}

async function writeFile(dir, data) {
  const file = await dir.getFileHandle(MASTER_FILE_NAME, { create: true });
  const writable = await file.createWritable();
  try {
    await writable.write(data);
  } finally {
    await writable.close();
  }
}

/**
 * @param {FileSystemDirectoryHandle} dir 总表所在的文件夹
 * @param {import('../shared/master-sheet.js').MasterRecord[]} records 待写入的记录
 * @returns {Promise<{added: string[], duplicate: string[], file: string, rows: number}>} rows：写完后总表的商品行数
 */
export async function appendMasterFile(dir, records) {
  const sheets = await readExisting(dir);
  const unreadable = sheets.find((s) => s.error);
  if (unreadable) throw new Error(`${MASTER_FILE_NAME} 的工作表「${unreadable.name}」读不出来（${unreadable.error}），没有写入`);
  const master = pickMasterSheet(sheets);
  const merged = mergeMasterRows(master?.rows ?? [], records);
  const spec = masterSheetSpec(merged.header, merged.body);
  // 其他工作表（用户自己加的）原样写回；总表放回原来的位置
  const others = sheets.map((s) => (s === master ? spec : { name: s.name, rows: s.rows, hidden: s.hidden }));
  const book = master ? others : [spec, ...others];
  await writeFile(dir, buildXlsx(book));
  return { added: merged.added, duplicate: merged.duplicate, file: `${dir.name}/${MASTER_FILE_NAME}`, rows: merged.body.length };
}
