// 图片尺寸计算（纯函数）。京东要求：主图 1:1、边长>480，推荐 1440；
// 详情图宽 ≥480、高 ≤1500、单张 ≤3MB。

export const MAIN_MIN_SIDE = 800;
export const MAIN_MAX_SIDE = 1440;
export const DETAIL_MIN_WIDTH = 480;
export const DETAIL_MAX_WIDTH = 790;
export const DETAIL_MAX_HEIGHT = 1500;

/**
 * 把任意尺寸图片等比放入白底正方形画布
 * @returns {{side: number, dx: number, dy: number, dw: number, dh: number}}
 */
export function squarePlan(width, height, { minSide = MAIN_MIN_SIDE, maxSide = MAIN_MAX_SIDE } = {}) {
  const longest = Math.max(width, height);
  const side = Math.min(maxSide, Math.max(minSide, longest));
  const scale = side / longest;
  const dw = Math.round(width * scale);
  const dh = Math.round(height * scale);
  return { side, dx: Math.round((side - dw) / 2), dy: Math.round((side - dh) / 2), dw, dh };
}

/**
 * 详情图缩放 + 纵向切片计划（sy/sh 为源图坐标）
 */
export function detailSlicePlan(
  width,
  height,
  { minWidth = DETAIL_MIN_WIDTH, maxWidth = DETAIL_MAX_WIDTH, maxSliceHeight = DETAIL_MAX_HEIGHT } = {},
) {
  const outWidth = Math.min(maxWidth, Math.max(minWidth, width));
  const scale = outWidth / width;
  const srcSliceHeight = Math.max(1, Math.floor(maxSliceHeight / scale));
  const slices = [];
  for (let sy = 0; sy < height; sy += srcSliceHeight) {
    const sh = Math.min(srcSliceHeight, height - sy);
    slices.push({ sy, sh, outHeight: Math.min(maxSliceHeight, Math.round(sh * scale)) });
  }
  return { outWidth, scale, slices };
}

export function isDecorativeImage(width, height) {
  return width < 100 || height < 20;
}

// 透图：近白色的阈值（JPEG 压缩后的白底通常在 240 以上）
export const BACKGROUND_THRESHOLD = 235;

/**
 * 把与图片边缘连通的近白色像素变成透明（白底主图 → 透明底，用于 VC 发布页的“透图”）。
 * 只清除从边缘能走到的白色，商品包装上被包住的白色区域保留。返回新的像素数组，不改原数组
 * @param {Uint8ClampedArray} data RGBA 像素
 * @param {number} width
 * @param {number} height
 * @param {{threshold?: number}} [opts]
 * @returns {Uint8ClampedArray}
 */
export function clearBackground(data, width, height, { threshold = BACKGROUND_THRESHOLD } = {}) {
  const out = new Uint8ClampedArray(data);
  const isBackground = (p) => out[p * 4] >= threshold && out[p * 4 + 1] >= threshold && out[p * 4 + 2] >= threshold;
  const seen = new Uint8Array(width * height);
  const queue = new Int32Array(width * height);
  let head = 0;
  let tail = 0;
  const push = (x, y) => {
    const p = y * width + x;
    if (seen[p] || !isBackground(p)) return;
    seen[p] = 1;
    queue[tail++] = p;
  };
  for (let x = 0; x < width; x += 1) {
    push(x, 0);
    push(x, height - 1);
  }
  for (let y = 0; y < height; y += 1) {
    push(0, y);
    push(width - 1, y);
  }
  while (head < tail) {
    const p = queue[head++];
    out[p * 4 + 3] = 0;
    const x = p % width;
    const y = (p - x) / width;
    if (x > 0) push(x - 1, y);
    if (x < width - 1) push(x + 1, y);
    if (y > 0) push(x, y - 1);
    if (y < height - 1) push(x, y + 1);
  }
  return out;
}

/**
 * 不透明像素的比例（透图去背景后检查：几乎全透明说明主图是白色商品或纯白图，不能当透图用）
 * @param {Uint8ClampedArray} data RGBA 像素
 * @returns {number} 0~1
 */
export function opaqueRatio(data) {
  const pixels = data.length / 4;
  if (!pixels) return 0;
  let opaque = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i] > 0) opaque += 1;
  return opaque / pixels;
}
