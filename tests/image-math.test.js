import { test } from 'node:test';
import assert from 'node:assert/strict';
import { squarePlan, detailSlicePlan, isDecorativeImage } from '../src/shared/image-math.js';

test('squarePlan centers landscape image on a square canvas', () => {
  assert.deepEqual(squarePlan(1000, 500), { side: 1000, dx: 0, dy: 250, dw: 1000, dh: 500 });
});

test('squarePlan upscales small images to minimum side', () => {
  const p = squarePlan(400, 400);
  assert.equal(p.side, 800);
  assert.deepEqual([p.dx, p.dy, p.dw, p.dh], [0, 0, 800, 800]);
});

test('squarePlan downscales huge images to max side', () => {
  const p = squarePlan(3000, 1500);
  assert.equal(p.side, 1440);
  assert.deepEqual([p.dx, p.dy, p.dw, p.dh], [0, 360, 1440, 720]);
});

test('detailSlicePlan keeps short images as one slice', () => {
  const p = detailSlicePlan(750, 1000);
  assert.equal(p.outWidth, 750);
  assert.deepEqual(p.slices, [{ sy: 0, sh: 1000, outHeight: 1000 }]);
});

test('detailSlicePlan slices tall images under max height', () => {
  const p = detailSlicePlan(790, 4000, { maxSliceHeight: 1500 });
  assert.equal(p.slices.length, 3);
  assert.ok(p.slices.every((s) => s.outHeight <= 1500));
  assert.equal(p.slices.reduce((n, s) => n + s.sh, 0), 4000);
});

test('detailSlicePlan scales width into allowed range', () => {
  const wide = detailSlicePlan(1580, 1000);
  assert.equal(wide.outWidth, 790);
  assert.equal(wide.slices[0].outHeight, 500);
  const narrow = detailSlicePlan(240, 100);
  assert.equal(narrow.outWidth, 480);
  assert.equal(narrow.slices[0].outHeight, 200);
});

test('isDecorativeImage flags spacers and tiny icons', () => {
  assert.equal(isDecorativeImage(1, 1), true);
  assert.equal(isDecorativeImage(750, 10), true);
  assert.equal(isDecorativeImage(60, 60), true);
  assert.equal(isDecorativeImage(750, 300), false);
});
