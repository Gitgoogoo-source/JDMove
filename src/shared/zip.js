// 最小 ZIP 读写（纯函数 + 浏览器自带的 DecompressionStream）：
// 读 Excel/WPS 保存的 .xlsx（deflate 压缩），写导出的模板（不压缩，Excel 照样能打开）。不支持 ZIP64 和加密

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_END = 0x06054b50;
const LOCAL_HEADER = 30;
const CENTRAL_HEADER = 46;
const END_RECORD = 22;
const MAX_COMMENT = 0xffff;
const ZIP64_MARK = 0xffffffff;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;
const VERSION = 20;
const FLAG_UTF8 = 0x0800;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** @param {Uint8Array} bytes */
export function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const viewOf = (bytes) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

function findEndRecord(view) {
  const stop = Math.max(0, view.byteLength - END_RECORD - MAX_COMMENT);
  for (let i = view.byteLength - END_RECORD; i >= stop; i--) {
    if (view.getUint32(i, true) === SIG_END) return i;
  }
  return -1;
}

function corrupt(what) {
  return new Error(`表格文件已损坏或不是 .xlsx（${what}）`);
}

/** 中央目录里的一条：定位到本地文件头后面的压缩数据 */
function readCentralEntry(bytes, view, p, decoder) {
  if (p + CENTRAL_HEADER > bytes.length || view.getUint32(p, true) !== SIG_CENTRAL) throw corrupt('目录');
  const method = view.getUint16(p + 10, true);
  const compressedSize = view.getUint32(p + 20, true);
  const size = view.getUint32(p + 24, true);
  const nameLen = view.getUint16(p + 28, true);
  const skip = nameLen + view.getUint16(p + 30, true) + view.getUint16(p + 32, true);
  const local = view.getUint32(p + 42, true);
  if ([compressedSize, size, local].includes(ZIP64_MARK)) throw new Error('表格文件太大，请删掉多余的工作表或行后再导入');
  const name = decoder.decode(bytes.subarray(p + CENTRAL_HEADER, p + CENTRAL_HEADER + nameLen));
  if (local + LOCAL_HEADER > bytes.length || view.getUint32(local, true) !== SIG_LOCAL) throw corrupt(name);
  const start = local + LOCAL_HEADER + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
  if (start + compressedSize > bytes.length) throw corrupt(name);
  return { entry: { name, method, size, data: bytes.subarray(start, start + compressedSize) }, next: p + CENTRAL_HEADER + skip };
}

/**
 * 读 ZIP 目录：文件名 → 压缩数据（不解压）
 * @param {Uint8Array} bytes
 * @returns {Map<string, {name: string, method: number, size: number, data: Uint8Array}>} size：解压后的大小
 */
export function readZipEntries(bytes) {
  const view = viewOf(bytes);
  const end = findEndRecord(view);
  if (end < 0) throw corrupt('找不到目录');
  const count = view.getUint16(end + 10, true);
  const decoder = new TextDecoder();
  const entries = new Map();
  let p = view.getUint32(end + 16, true);
  for (let i = 0; i < count; i++) {
    const { entry, next } = readCentralEntry(bytes, view, p, decoder);
    entries.set(entry.name, entry);
    p = next;
  }
  return entries;
}

/** 浏览器 / Node 自带的 raw deflate 解压 */
export async function inflateRaw(data) {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * @param {{name: string, method: number, data: Uint8Array}} entry
 * @param {(data: Uint8Array) => Promise<Uint8Array>} [inflate]
 */
export async function unzipEntry(entry, inflate = inflateRaw) {
  if (entry.method === METHOD_STORE) return entry.data;
  if (entry.method === METHOD_DEFLATE) return inflate(entry.data);
  throw new Error(`表格文件里的 ${entry.name} 用了不支持的压缩方式（${entry.method}），请用 Excel/WPS 另存为 .xlsx 后再导入`);
}

function dosDateTime(d) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const date = ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

/** 本地文件头和中央目录共用的字段（从“版本”到“文件名长度”） */
function writeCommon(view, at, f, stamp) {
  view.setUint16(at, VERSION, true);
  view.setUint16(at + 2, FLAG_UTF8, true);
  view.setUint16(at + 4, f.method, true);
  view.setUint16(at + 6, stamp.time, true);
  view.setUint16(at + 8, stamp.date, true);
  view.setUint32(at + 10, f.crc, true);
  view.setUint32(at + 14, f.data.length, true);
  view.setUint32(at + 18, f.size, true);
  view.setUint16(at + 22, f.name.length, true);
}

function localHeader(f, stamp) {
  const out = new Uint8Array(LOCAL_HEADER + f.name.length);
  const view = viewOf(out);
  view.setUint32(0, SIG_LOCAL, true);
  writeCommon(view, 4, f, stamp);
  out.set(f.name, LOCAL_HEADER);
  return out;
}

function centralHeader(f, stamp, offset) {
  const out = new Uint8Array(CENTRAL_HEADER + f.name.length);
  const view = viewOf(out);
  view.setUint32(0, SIG_CENTRAL, true);
  view.setUint16(4, VERSION, true);
  writeCommon(view, 6, f, stamp);
  view.setUint32(42, offset, true);
  out.set(f.name, CENTRAL_HEADER);
  return out;
}

function endRecord(count, centralSize, centralOffset) {
  const out = new Uint8Array(END_RECORD);
  const view = viewOf(out);
  view.setUint32(0, SIG_END, true);
  view.setUint16(8, count, true);
  view.setUint16(10, count, true);
  view.setUint32(12, centralSize, true);
  view.setUint32(16, centralOffset, true);
  return out;
}

function concat(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  parts.reduce((at, p) => (out.set(p, at), at + p.length), 0);
  return out;
}

/**
 * 打包成 ZIP。默认不压缩；传 deflate（同步 raw deflate）时按 deflate 压缩（测试用来模拟 Excel 保存的文件）
 * @param {{name: string, data: Uint8Array}[]} files
 * @param {{now?: Date, deflate?: (data: Uint8Array) => Uint8Array}} [opts]
 * @returns {Uint8Array}
 */
export function buildZip(files, { now = new Date(), deflate } = {}) {
  const encoder = new TextEncoder();
  const stamp = dosDateTime(now);
  const prepared = files.map((f) => ({
    name: encoder.encode(f.name),
    crc: crc32(f.data),
    size: f.data.length,
    method: deflate ? METHOD_DEFLATE : METHOD_STORE,
    data: deflate ? new Uint8Array(deflate(f.data)) : f.data,
  }));
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const f of prepared) {
    const head = localHeader(f, stamp);
    centrals.push(centralHeader(f, stamp, offset));
    locals.push(head, f.data);
    offset += head.length + f.data.length;
  }
  const centralSize = centrals.reduce((n, c) => n + c.length, 0);
  return concat([...locals, ...centrals, endRecord(prepared.length, centralSize, offset)]);
}
