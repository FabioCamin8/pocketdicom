import test from 'node:test';
import assert from 'node:assert/strict';
import { projectVolume, MAX_PROJECTION_SIZE } from '../web/volume-project.js';

function volume(dimensions, spacing = [1, 1, 1], fill = -100) {
  const [nx, ny, nz] = dimensions;
  return {
    dimensions,
    data: new Float32Array(nx * ny * nz).fill(fill),
    spacing,
    extentMm: dimensions.map((n, i) => n * spacing[i]),
    center: 0,
    widthWindow: 200,
    invert: false,
    min: fill,
    max: fill,
  };
}

function gray(pixels, width, x, y) {
  return pixels[(y * width + x) * 4];
}

function bounds(pixels, width, height) {
  let left = width, right = -1, top = height, bottom = -1;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (gray(pixels, width, x, y) > 0) {
      left = Math.min(left, x); right = Math.max(right, x);
      top = Math.min(top, y); bottom = Math.max(bottom, y);
    }
  }
  return right < left ? null : { left, right, top, bottom, width: right - left + 1, height: bottom - top + 1 };
}

test('projects the maximum raw value along each depth ray', () => {
  const v = volume([3, 3, 3]);
  v.data[1 + 3 * (1 + 3 * 0)] = 30;
  v.data[1 + 3 * (1 + 3 * 1)] = 160;
  v.data[1 + 3 * (1 + 3 * 2)] = 90;
  v.center = 100;

  const image = projectVolume(v, { width: 5, height: 5 });
  assert.equal(gray(image, 5, 2, 2), 205); // 160 in a DICOM LINEAR [0, 199] window.
  assert.equal(image[(2 * 5 + 2) * 4 + 3], 255);
  assert.equal(gray(image, 5, 0, 0), 0);
  assert.equal(image[(0 * 5 + 0) * 4 + 3], 255);
});

test('maps increasing X right and increasing Y down at zero rotation', () => {
  const v = volume([3, 3, 3], [1, 1, 1], -10);
  v.data[2 + 3 * (2 + 3 * 0)] = 100;
  v.min = -10;
  const image = projectVolume(v, { width: 7, height: 7, threshold: 0 });
  assert.equal(gray(image, 7, 4, 4), 255);
  assert.equal(gray(image, 7, 2, 2), 0);
});

test('keeps a small bright voxel visible at several view rotations', () => {
  const v = volume([13, 13, 13], [1, 1, 1], -10);
  v.data[2 + 13 * (7 + 13 * 9)] = 100;
  v.min = -10;
  const zeroYaw = projectVolume(v, { width: 72, height: 72, threshold: 0 });
  const quarterTurn = projectVolume(v, { yaw: Math.PI / 2, width: 72, height: 72, threshold: 0 });
  const zeroBox = bounds(zeroYaw, 72, 72), turnBox = bounds(quarterTurn, 72, 72);
  assert.ok((zeroBox.left + zeroBox.right) / 2 < 36);
  assert.ok((turnBox.left + turnBox.right) / 2 > 36);
  for (const [yaw, pitch] of [[Math.PI / 4, 0], [0, Math.PI / 4], [-0.8, 0.55]]) {
    const image = projectVolume(v, { yaw, pitch, width: 72, height: 72, threshold: 0 });
    assert.ok(bounds(image, 72, 72), `bright voxel disappeared at yaw=${yaw}, pitch=${pitch}`);
  }
});

test('preserves a subpixel bright voxel at native resolution through rotation', () => {
  const v = volume([96, 96, 96], [1, 1, 1], -10);
  v.data[12 + 96 * (43 + 96 * 75)] = 100;
  v.min = -10;
  for (const [yaw, pitch] of [[0, 0], [0.8, 0], [0, 0.8], [-0.8, 0.55]]) {
    const image = projectVolume(v, { yaw, pitch, width: 96, height: 96, threshold: 0 });
    assert.ok(bounds(image, 96, 96), `subpixel voxel disappeared at yaw=${yaw}, pitch=${pitch}`);
  }
});

test('uses physical voxel spacing without stretching a rectangular object', () => {
  const v = volume([8, 8, 8], [1, 2, 1], 0);
  for (let z = 0; z < 8; z++) for (let y = 2; y < 6; y++) for (let x = 3; x < 5; x++) {
    v.data[x + 8 * (y + 8 * z)] = 100;
  }
  v.min = 0;
  const image = projectVolume(v, { width: 160, height: 120, threshold: 50 });
  const box = bounds(image, 160, 120);
  assert.ok(box);
  assert.ok(box.height / box.width > 3 && box.height / box.width < 5,
    `expected the 4:1 physical height/width ratio, got ${box.height}:${box.width}`);
});

test('contains the full physical volume at unit zoom on a rectangular canvas', () => {
  const v = volume([7, 7, 7], [0.8, 1.3, 1.7], 100);
  v.min = 100;
  for (const [yaw, pitch] of [[0, 0], [1.1, -0.8], [-2.2, 0.5]]) {
    const image = projectVolume(v, { yaw, pitch, width: 120, height: 80, threshold: 50 });
    const box = bounds(image, 120, 80);
    assert.ok(box);
    assert.ok(box.left > 0 && box.right < 119 && box.top > 0 && box.bottom < 79,
      `volume touched the canvas edge at yaw=${yaw}, pitch=${pitch}`);
  }
});

test('applies threshold to raw values, then windowing and optional display inversion', () => {
  const v = volume([3, 3, 3], [1, 1, 1], 0);
  v.data[1 + 3 * (1 + 3 * 1)] = 100;
  v.data[0 + 3 * (1 + 3 * 1)] = 50;
  v.min = 0;
  v.center = 100;
  v.widthWindow = 200;

  const normal = projectVolume(v, { width: 5, height: 5, threshold: 40 });
  assert.equal(gray(normal, 5, 2, 2), 128);
  assert.equal(gray(normal, 5, 1, 2), 64);
  const inverted = projectVolume({ ...v, invert: true }, { width: 5, height: 5, threshold: 40 });
  assert.equal(gray(inverted, 5, 2, 2), 127);
  assert.equal(gray(inverted, 5, 0, 0), 0); // Inversion does not turn empty background white.
  const raisedThreshold = projectVolume(v, { width: 5, height: 5, threshold: 60 });
  assert.equal(gray(raisedThreshold, 5, 1, 2), 0);
});

test('reuses the requested RGBA output buffer and rejects malformed geometry', () => {
  const v = volume([2, 2, 2]);
  const output = new Uint8ClampedArray(4 * 4 * 3);
  assert.equal(projectVolume(v, { width: 4, height: 3, pixels: output }), output);
  assert.throws(() => projectVolume({ ...v, dimensions: [2, 2, 2], data: new Float32Array(3) }, { width: 4 }), /data/i);
  assert.equal(MAX_PROJECTION_SIZE, 4096);
  assert.throws(() => projectVolume(v, { width: MAX_PROJECTION_SIZE + 1 }), /width/i);
  assert.throws(() => projectVolume(v, { height: MAX_PROJECTION_SIZE + 1 }), /height/i);
  assert.throws(() => projectVolume({ ...v, dimensions: [Number.MAX_SAFE_INTEGER, 2, 2] }, { width: 4 }), /dimensions|addressable/i);
});

test('projects a displayed device-pixel raster larger than the old 512 cap within the documented ceiling', () => {
  const v = volume([1, 1, 1], [1, 1, 1], 100);
  v.min = 100;
  const image = projectVolume(v, { width: MAX_PROJECTION_SIZE, height: 8, threshold: 0 });
  assert.equal(image.length, MAX_PROJECTION_SIZE * 8 * 4);
  assert.equal(gray(image, MAX_PROJECTION_SIZE, MAX_PROJECTION_SIZE / 2, 4), 255);
  assert.equal(gray(image, MAX_PROJECTION_SIZE, 0, 0), 0);
});

test('projects a volume with an axis above the old 192 limit at a 512-pixel raster', () => {
  const v = volume([512, 4, 2], [1, 1, 1], 100);
  v.min = 100;
  const image = projectVolume(v, { width: 512, height: 512, threshold: 50 });
  assert.equal(image.length, 512 * 512 * 4);
  const box = bounds(image, 512, 512);
  assert.ok(box);
  assert.ok(box.left > 0 && box.right < 511 && box.top > 0 && box.bottom < 511);
  assert.equal(gray(image, 512, 256, 256), 255);
});

test('projects in Node without DOM or WebGL globals', () => {
  assert.equal(typeof globalThis.document, 'undefined');
  assert.equal(typeof globalThis.WebGLRenderingContext, 'undefined');
  const v = volume([1, 1, 1], [1, 1, 1], 100);
  assert.deepEqual([...projectVolume(v, { width: 1, height: 1, threshold: 0 })], [255, 255, 255, 255]);
});

test('a width of two uses the same DICOM linear transfer as the slice views', () => {
  const v = volume([1, 1, 1], [1, 1, 1], 10);
  const pixels = projectVolume(v, {width: 1, center: 10, widthWindow: 2});
  assert.equal(pixels[0], 255);
});

test('incremental rows match a one-pass image without touching unfinished rows', () => {
  const v = volume([5, 6, 8], [1, 2, 0.8], 100);
  const options = {width: 21, height: 20, yaw: 0.45, pitch: -0.3};
  const output = new Uint8ClampedArray(21 * 20 * 4).fill(17);
  projectVolume(v, {...options, pixels: output, endRow: 8});
  assert.ok(output.subarray(8 * 21 * 4).every(n => n === 17));
  projectVolume(v, {...options, pixels: output, startRow: 8});
  assert.deepEqual(output, projectVolume(v, options));
});
