// 图片下载与处理（扩展页面 / Service Worker 中运行，使用 OffscreenCanvas）
import { squarePlan, detailSlicePlan, isDecorativeImage } from '../shared/image-math.js';

const MAX_BYTES = 2.8 * 1024 * 1024;

async function fetchBitmap(url) {
  const res = await fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer' });
  if (!res.ok) throw new Error(`图片下载失败 ${res.status}: ${url}`);
  const blob = await res.blob();
  return createImageBitmap(blob);
}

async function encodeJpeg(canvas) {
  for (const quality of [0.92, 0.85, 0.75, 0.65]) {
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
    if (blob.size <= MAX_BYTES) return blob;
  }
  throw new Error('图片压缩后仍超过 3MB');
}

async function blobToBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(bin);
}

function whiteCanvas(w, h) {
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  return { canvas, ctx };
}

/**
 * 主图：白底补成正方形（800~1440），JPEG
 * @returns {Promise<{name: string, mime: string, b64: string}>}
 */
export async function makeMainImage(url, name) {
  const bmp = await fetchBitmap(url);
  const p = squarePlan(bmp.width, bmp.height);
  const { canvas, ctx } = whiteCanvas(p.side, p.side);
  ctx.drawImage(bmp, p.dx, p.dy, p.dw, p.dh);
  bmp.close();
  return { name, mime: 'image/jpeg', b64: await blobToBase64(await encodeJpeg(canvas)) };
}

/**
 * 详情图：宽度规范到 480~790，按 1500 高切片
 * @returns {Promise<Array<{name: string, mime: string, b64: string}>>}
 */
export async function makeDetailImages(url, baseName) {
  const bmp = await fetchBitmap(url);
  if (isDecorativeImage(bmp.width, bmp.height)) {
    bmp.close();
    return [];
  }
  const plan = detailSlicePlan(bmp.width, bmp.height);
  const out = [];
  for (const [i, s] of plan.slices.entries()) {
    const { canvas, ctx } = whiteCanvas(plan.outWidth, s.outHeight);
    ctx.drawImage(bmp, 0, s.sy, bmp.width, s.sh, 0, 0, plan.outWidth, s.outHeight);
    const name = plan.slices.length > 1 ? `${baseName}_${i + 1}.jpg` : `${baseName}.jpg`;
    out.push({ name, mime: 'image/jpeg', b64: await blobToBase64(await encodeJpeg(canvas)) });
  }
  bmp.close();
  return out;
}
