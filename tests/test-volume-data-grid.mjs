import assert from 'node:assert/strict';
import test from 'node:test';
import {buildVolume} from '../web/volume-data.js';

const series = count => ({volume: true, spacingZ: 2, orientation: [1, 0, 0, 0, 1, 0],
  frames: Array.from({length: count}, (_, i) => ({id: i, position: [0, 0, 2 * i]}))});
const frame = (value, extra) => ({width: 1, height: 1, type: 'f32', pixels: new Float32Array([value]),
  center: 128, widthWindow: 256, spacing: [1, 1], invert: false, ...extra});

test('capped depth samples near the center of each mm bin, while keeping original window metadata', async () => {
  const reads = [];
  const volume = await buildVolume(series(1000), async index => {
    reads.push(index);
    return frame(index, {center: 128 + index});
  });
  assert.deepEqual(volume.dimensions, [1, 1, 192]);
  assert.ok(Math.abs(volume.extentMm[2] - 2000) < 1e-8);
  assert.deepEqual([volume.data[0], volume.data.at(-1)], [2, 997]);
  assert.deepEqual(reads.slice(0, 2), [0, 2]);
  assert.equal(volume.center, 128);
});

test('validates the first sampled slice even when the frame that supplied window metadata was skipped', async () => {
  await assert.rejects(buildVolume(series(1000), async index => index === 2
    ? frame(index, {width: 2, pixels: new Float32Array(2)})
    : frame(index)), /slice 3.*dimensions/i);
});

test('small IOP rounding errors do not shear the patient transform', async () => {
  const input = series(2);
  input.orientation = [1, 0, 0, 0.006, 0.999982, 0];
  const volume = await buildVolume(input, async z => frame(z));
  const [x, y] = volume.axes;
  assert.ok(Math.abs(x[0] * y[0] + x[1] * y[1] + x[2] * y[2]) < 1e-12);
  assert.equal(y[1], 1);
});

test('missing samples do not invent threshold signal in a negative-valued scan', async () => {
  const volume = await buildVolume(series(2), async z => frame(z === 0 ? NaN : -80));
  assert.ok(Number.isNaN(volume.data[0]));
  assert.deepEqual([volume.min, volume.max], [-80, -80]);
  await assert.rejects(buildVolume(series(2), async () => frame(NaN)), /no finite/i);
  await assert.rejects(buildVolume(series(2), async z => frame(z, {widthWindow: 0})), /window/i);
});

test('cached frame loading yields long enough to process a user cancel', async () => {
  const controller = new AbortController();
  const cancel = setTimeout(() => controller.abort(), 0);
  try {
    await assert.rejects(buildVolume(series(80), async z => frame(z), {signal: controller.signal}), {name: 'AbortError'});
  } finally {
    clearTimeout(cancel);
  }
});

test('fullDepth reads every frame in order while the fast path still skips slices', async () => {
  const count = 240;
  const load = reads => async index => {
    reads.push(index);
    return frame(index * 1000 + 7);
  };

  const fastReads = [];
  const fast = await buildVolume(series(count), load(fastReads));
  assert.deepEqual(fast.dimensions, [1, 1, 192]);
  assert.equal(fastReads.length, 192);
  assert.ok(fastReads.length < count);
  assert.ok(fastReads.includes(0));
  assert.equal(fastReads.at(-1), count - 1);
  assert.deepEqual(fast.data, Float32Array.from(fastReads, index => index * 1000 + 7));

  const fullReads = [];
  const full = await buildVolume(series(count), load(fullReads), {fullDepth: true});
  assert.deepEqual(full.dimensions, [1, 1, count]);
  assert.deepEqual(fullReads, Array.from({length: count}, (_, index) => index));
  assert.deepEqual(full.data, Float32Array.from({length: count}, (_, index) => index * 1000 + 7));
  assert.equal(full.spacing[2], 2);
  assert.ok(Math.abs(full.extentMm[2] - count * 2) < 1e-9);
  assert.deepEqual(full.axes[2], [0, 0, 1]);
});

test('fullDepth keeps every slice and physical Z spacing while shrinking only XY under the cap', async () => {
  const count = 300;
  const width = 400;
  const height = 400;
  const pixels = new Float32Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) pixels[y * width + x] = x + y * 1000;
  }
  const input = {
    volume: true,
    spacingZ: 1.5,
    orientation: [1, 0, 0, 0, 1, 0],
    frames: Array.from({length: count}, (_, index) => ({
      id: index,
      position: [0, 0, 1.5 * (count - 1 - index)],
    })),
  };
  const reads = [];
  const volume = await buildVolume(input, async index => {
    reads.push(index);
    return {width, height, type: 'f32', pixels, center: 10, widthWindow: 20,
      invert: false, spacing: [0.5, 0.8]};
  }, {fullDepth: true});

  const [nx, ny, nz] = volume.dimensions;
  assert.equal(nz, count);
  assert.ok(nx < width && ny < height);
  assert.ok(nx * ny * nz * Float32Array.BYTES_PER_ELEMENT <= 16 * 1024 * 1024);
  assert.deepEqual(reads, Array.from({length: count}, (_, index) => index));
  assert.ok(Math.abs(volume.extentMm[0] - width * 0.8) < 1e-9);
  assert.ok(Math.abs(volume.extentMm[1] - height * 0.5) < 1e-9);
  assert.ok(Math.abs(volume.extentMm[2] - count * 1.5) < 1e-9);
  assert.deepEqual(volume.axes[2], [0, 0, -1]);
  assert.ok(volume.notes.some(note => /all 300 slices were kept/.test(note)));
  assert.ok(volume.notes.some(note => /in-plane detail is reduced/.test(note)));

  const x = index => Math.min(width - 1, Math.floor((index + 0.5) * width / nx));
  const y = index => Math.min(height - 1, Math.floor((index + 0.5) * height / ny));
  assert.equal(volume.data[0], x(0) + y(0) * 1000);
  assert.equal(volume.data[nx * ny - 1], x(nx - 1) + y(ny - 1) * 1000);
  assert.equal(volume.data[(nz - 1) * nx * ny], x(0) + y(0) * 1000);
});

test('fullDepth reports progress and aborts while reading frames sequentially', async () => {
  const count = 40;
  const progress = [];
  const volume = await buildVolume(series(count), async index => frame(index), {
    fullDepth: true,
    onProgress: (done, total) => progress.push([done, total]),
  });
  assert.deepEqual(volume.dimensions, [1, 1, count]);
  assert.deepEqual(progress, [[0, count],
    ...Array.from({length: count}, (_, index) => [index + 1, count])]);

  const controller = new AbortController();
  const abortedProgress = [];
  let calls = 0;
  await assert.rejects(buildVolume(series(count), async index => {
    calls += 1;
    if (index === 5) controller.abort();
    return frame(index);
  }, {fullDepth: true, signal: controller.signal,
    onProgress: (done, total) => abortedProgress.push([done, total])}), {name: 'AbortError'});
  assert.equal(calls, 6);
  assert.deepEqual(abortedProgress.at(-1), [5, count]);
});

test('fullDepth rejects a slice count that cannot fit even the minimum in-plane grid', async () => {
  const tooMany = Math.floor(16 * 1024 * 1024 / Float32Array.BYTES_PER_ELEMENT) + 1;
  const frames = new Array(tooMany);
  frames[0] = {id: 0};
  await assert.rejects(buildVolume({volume: true, spacingZ: 1, frames},
    async () => frame(1), {fullDepth: true}),
  /full-depth volume.*memory limit.*smallest in-plane/i);
});
