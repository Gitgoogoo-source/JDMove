// 生成插件图标（红底白色“箱子+箭头”），无第三方依赖
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

function pixel(x, y, s) {
  const u = x / s;
  const v = y / s;
  const r = 0.22;
  const dx = Math.max(r - u, 0, u - (1 - r));
  const dy = Math.max(r - v, 0, v - (1 - r));
  if (dx * dx + dy * dy > r * r) return [0, 0, 0, 0];
  const white = [255, 255, 255, 255];
  const box = u > 0.22 && u < 0.78 && v > 0.48 && v < 0.8 && !(u > 0.3 && u < 0.7 && v > 0.56 && v < 0.72);
  const shaft = u > 0.45 && u < 0.55 && v > 0.2 && v < 0.44;
  const head = v > 0.14 && v < 0.3 && Math.abs(u - 0.5) < (v - 0.14) * 1.1;
  return box || shaft || head ? white : [225, 37, 27, 255];
}

function png(size) {
  const rows = [];
  for (let y = 0; y < size; y += 1) {
    rows.push(Buffer.from([0]));
    for (let x = 0; x < size; x += 1) rows.push(Buffer.from(pixel(x + 0.5, y + 0.5, size)));
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync(new URL('../icons/', import.meta.url), { recursive: true });
for (const size of [16, 32, 48, 128]) writeFileSync(new URL(`../icons/icon${size}.png`, import.meta.url), png(size));
