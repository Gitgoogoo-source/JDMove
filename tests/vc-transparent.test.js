// 透图：主图边缘连通的近白色背景变透明，商品内部的白色保留
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clearBackground } from '../src/shared/image-math.js';

const WHITE = [255, 255, 255, 255];
const RED = [200, 0, 0, 255];

/** rows：每行一个字符串，W=白、R=红、w=接近白（240） */
function image(rows) {
  const height = rows.length;
  const width = rows[0].length;
  const data = new Uint8ClampedArray(width * height * 4);
  rows.join('').split('').forEach((ch, i) => {
    const px = ch === 'R' ? RED : ch === 'w' ? [240, 241, 242, 255] : WHITE;
    data.set(px, i * 4);
  });
  return { data, width, height };
}

const alphas = (data) => Array.from({ length: data.length / 4 }, (_, i) => data[i * 4 + 3]);

test('clearBackground: 与边缘连通的白色变透明，商品保留', () => {
  const img = image(['WWWW', 'WRRW', 'WRRW', 'WWWW']);
  const out = clearBackground(img.data, img.width, img.height);
  assert.deepEqual(alphas(out), [0, 0, 0, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 0, 0, 0]);
});

test('clearBackground: 被商品包住的白色（如包装上的白字）不动', () => {
  const img = image(['WWWWW', 'WRRRW', 'WRWRW', 'WRRRW', 'WWWWW']);
  const out = clearBackground(img.data, img.width, img.height);
  assert.equal(out[(2 * 5 + 2) * 4 + 3], 255);
});

test('clearBackground: 接近白色的背景（JPEG 压缩后的 240）也算背景；不改原数组', () => {
  const img = image(['www', 'wRw', 'www']);
  const out = clearBackground(img.data, img.width, img.height);
  assert.deepEqual(alphas(out), [0, 0, 0, 0, 255, 0, 0, 0, 0]);
  assert.deepEqual(alphas(img.data), [255, 255, 255, 255, 255, 255, 255, 255, 255]);
});

test('clearBackground: 阈值可调，背景不够白时不清除', () => {
  const img = image(['www', 'wRw', 'www']);
  const out = clearBackground(img.data, img.width, img.height, { threshold: 250 });
  assert.ok(alphas(out).every((a) => a === 255));
});

test('opaqueRatio: 去背景后剩下的不透明比例（全白图片去完几乎全透明）', async () => {
  const { opaqueRatio } = await import('../src/shared/image-math.js');
  const white = image(['WWW', 'WWW', 'WWW']);
  assert.equal(opaqueRatio(clearBackground(white.data, 3, 3)), 0);
  const product = image(['WWWW', 'WRRW', 'WRRW', 'WWWW']);
  assert.equal(opaqueRatio(clearBackground(product.data, 4, 4)), 0.25);
  assert.equal(opaqueRatio(new Uint8ClampedArray(0)), 0);
});
