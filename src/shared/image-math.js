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
