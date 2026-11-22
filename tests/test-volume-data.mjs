import test from 'node:test';
import assert from 'node:assert/strict';
import { buildVolume } from '../web/volume-data.js';

const makeSeries = (count, overrides = {}) => ({
  id: 'synthetic-series',
  label: 'synthetic',
  modality: 'CT',
  details: {},
  frames: Array.from({ length: count }, (_, i) => ({
    id: `slice-${i}`,
    label: `slice ${i}`,
    instance: i + 1,
  })),
  volume: true,
  spacingZ: 1,
  orientation: [1, 0, 0, 0, 1, 0],
  ...overrides,
});

const makeFrame = (pixels, overrides = {}) => ({
  width: 2,
  height: 2,
  type: 'f32',
  pixels: pixels instanceof Float32Array ? pixels : Float32Array.from(pixels),
  center: 40,
  widthWindow: 350,
  invert: false,
  spacing: [2, 0.5],
  ...overrides,
});

const loadFrames = (frames) => async (id) => frames[Number(id.slice('slice-'.length))];

test('builds an x-contiguous phantom with calibrated anisotropic geometry and first-frame display values', async () => {
  const series = makeSeries(2, {
    spacingZ: 3,
    frames: [
      { id: 'slice-0', label: 'slice 0', instance: 1, position: [0, 0, 0] },
      { id: 'slice-1', label: 'slice 1', instance: 2, position: [0, 0, 3] },
    ],
  });
  const progress = [];
  const volume = await buildVolume(series, loadFrames([
    makeFrame([1, 2, 3, 4], { center: 35, widthWindow: 180 }),
    makeFrame([5, 6, 7, 8], { center: 90, widthWindow: 400 }),
  ]), { onProgress: (done, total) => progress.push([done, total]) });

  assert.deepEqual(volume.dimensions, [2, 2, 2]);
  assert.deepEqual(volume.sourceDimensions, [2, 2, 2]);
  assert.deepEqual([...volume.data], [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(volume.spacing, [0.5, 2, 3]);
  assert.deepEqual(volume.extentMm, [1, 4, 6]);
  assert.deepEqual(volume.axes, [[1, 0, 0], [0, 1, 0], [0, 0, 1]]);
  assert.equal(volume.calibrated, true);
  assert.equal(volume.center, 35);
  assert.equal(volume.widthWindow, 180);
  assert.equal(volume.invert, false);
  assert.equal(volume.min, 1);
  assert.equal(volume.max, 8);
  assert.deepEqual(volume.notes, []);
  assert.deepEqual(progress, [[0, 2], [1, 2], [2, 2]]);
});

test('uses the actual descending and oblique slice direction for the z axis', async () => {
  const descending = makeSeries(2, {
    spacingZ: undefined,
    frames: [
      { id: 'slice-0', position: [0, 0, 6] },
      { id: 'slice-1', position: [0, 0, 3] },
    ],
  });
  const first = await buildVolume(descending, loadFrames([
    makeFrame([0, 0, 0, 0]), makeFrame([1, 1, 1, 1]),
  ]));
  assert.deepEqual(first.axes, [[1, 0, 0], [0, 1, 0], [0, 0, -1]]);
  assert.deepEqual(first.spacing, [0.5, 2, 3]);

  const oblique = makeSeries(2, {
    spacingZ: undefined,
    orientation: [0, 1, 0, 0, 0, 1],
    frames: [
      { id: 'slice-0', position: [0, 0, 0] },
      { id: 'slice-1', position: [2, 0, 0] },
    ],
  });
  const second = await buildVolume(oblique, loadFrames([
    makeFrame([0, 0, 0, 0]), makeFrame([1, 1, 1, 1]),
  ]));
  assert.deepEqual(second.axes, [[0, 1, 0], [0, 0, 1], [1, 0, 0]]);
  assert.deepEqual(second.spacing, [0.5, 2, 2]);
});

test('does not guess an axis sign or physical scale when geometry is unknown', async () => {
  const series = makeSeries(2, { spacingZ: undefined });
  const volume = await buildVolume(series, async () => makeFrame([1, 2, 3, 4], { spacing: null }));

  assert.equal(volume.axes, null);
  assert.equal(volume.calibrated, false);
  assert.deepEqual(volume.spacing, [1, 1, 1]);
  assert.deepEqual(volume.extentMm, [2, 2, 2]);
  assert.ok(volume.notes.some((note) => /unknown|display only/i.test(note)));
});

test('rejects a one-slice series and a series marked as non-volumetric', async () => {
  await assert.rejects(
    buildVolume(makeSeries(1), async () => makeFrame([1, 2, 3, 4])),
    /at least two slices|too small/i,
  );
  await assert.rejects(
    buildVolume(makeSeries(2, { volume: false, volumeReason: 'one slice only' }), async () => makeFrame([1, 2, 3, 4])),
    /one slice only|not suitable/i,
  );
});

test('rejects duplicate, non-uniform, interleaved, or laterally shifted slice positions', async (t) => {
  const cases = [
    ['duplicate positions', [[0, 0, 0], [0, 0, 0]], /duplicate|spacing|position/i],
    ['non-uniform spacing', [[0, 0, 0], [0, 0, 1], [0, 0, 2.4]], /non-uniform|spacing/i],
    ['interleaved order', [[0, 0, 0], [0, 0, 2], [0, 0, 1]], /order|interleav|monotonic/i],
    ['lateral drift', [[0, 0, 0], [0.2, 0, 1], [0.4, 0, 2]], /lateral|tilt|drift/i],
  ];
  for (const [name, positions, message] of cases) {
    await t.test(name, async () => {
      const series = makeSeries(positions.length, {
        frames: positions.map((position, i) => ({ id: `slice-${i}`, position })),
      });
      await assert.rejects(
        buildVolume(series, async () => makeFrame([1, 2, 3, 4])),
        message,
      );
    });
  }
});

test('rejects incomplete or conflicting spatial calibration', async () => {
  const declaredMismatch = makeSeries(2, {
    spacingZ: 4,
    frames: [
      { id: 'slice-0', position: [0, 0, 0] },
      { id: 'slice-1', position: [0, 0, 3] },
    ],
  });
  await assert.rejects(buildVolume(declaredMismatch, async () => makeFrame([1, 2, 3, 4])), /declared slice spacing/i);

  const partialPositions = makeSeries(2, {
    frames: [
      { id: 'slice-0', position: [0, 0, 0] },
      { id: 'slice-1' },
    ],
  });
  await assert.rejects(buildVolume(partialPositions, async () => makeFrame([1, 2, 3, 4])), /positions are incomplete/i);

  await assert.rejects(
    buildVolume(makeSeries(2, { orientation: [2, 0, 0, 0, 1, 0] }), async () => makeFrame([1, 2, 3, 4])),
    /orientation metadata/i,
  );
});

test('rejects malformed, RGB, dimension-mismatched, spacing-mismatched, and photometrically mixed frames', async (t) => {
  const series = makeSeries(2);
  const first = makeFrame([1, 2, 3, 4]);
  const cases = [
    ['RGB pixels', [first, makeFrame([1, 2, 3, 4], { type: 'rgb', pixels: new Uint8Array(12) })], /RGB|scalar|f32/i],
    ['truncated pixels', [first, makeFrame([1, 2, 3])], /pixel|length|malformed/i],
    ['changed dimensions', [first, makeFrame([1, 2, 3, 4], { width: 1, height: 4 })], /dimension|size/i],
    ['changed spacing', [first, makeFrame([1, 2, 3, 4], { spacing: [1, 0.5] })], /spacing/i],
    ['changed photometric polarity', [first, makeFrame([1, 2, 3, 4], { invert: true })], /invert|photometric/i],
    ['invalid window width', [first, makeFrame([1, 2, 3, 4], { widthWindow: 0 })], /window|metadata/i],
  ];
  for (const [name, frames, message] of cases) {
    await t.test(name, async () => {
      await assert.rejects(buildVolume(series, loadFrames(frames)), message);
    });
  }
});

test('preserves non-finite voxels as NaN and computes min/max only from finite values', async () => {
  const volume = await buildVolume(makeSeries(2), loadFrames([
    makeFrame([NaN, -4, Infinity, 4]),
    makeFrame([-Infinity, 6, 7, 8]),
  ]));

  assert.ok(Number.isNaN(volume.data[0]));
  assert.equal(volume.data[1], -4);
  assert.ok(Number.isNaN(volume.data[2]));
  assert.equal(volume.data[3], 4);
  assert.ok(Number.isNaN(volume.data[4]));
  assert.deepEqual([...volume.data.slice(5)], [6, 7, 8]);
  assert.equal(volume.min, -4);
  assert.equal(volume.max, 8);
  assert.ok(volume.notes.some((note) => /non-finite|missing/i.test(note)));
  await assert.rejects(
    buildVolume(makeSeries(2), async () => makeFrame([NaN, Infinity, -Infinity, NaN])),
    /no finite/i,
  );
});

test('caps the output grid and memory while preserving display extent and sampling endpoint slices', async () => {
  const count = 200;
  const width = 200;
  const height = 200;
  const series = makeSeries(count, {
    spacingZ: 2,
    orientation: undefined,
    frames: Array.from({ length: count }, (_, i) => ({ id: `slice-${i}`, instance: i + 1 })),
  });
  const loaded = [];
  const volume = await buildVolume(series, async (id) => {
    const z = Number(id.slice('slice-'.length));
    loaded.push(z);
    return makeFrame(new Float32Array(width * height).fill(z), {
      width,
      height,
      spacing: [1, 1],
      center: 22,
      widthWindow: 90,
    });
  });

  const [nx, ny, nz] = volume.dimensions;
  assert.deepEqual(volume.sourceDimensions, [200, 200, 200]);
  assert.ok(volume.dimensions.every((size) => size <= 192));
  assert.ok(volume.data.length * Float32Array.BYTES_PER_ELEMENT <= 16 * 1024 * 1024);
  assert.ok(volume.extentMm.every((size, axis) => Math.abs(size - [200, 200, 400][axis]) < 1e-9));
  assert.equal(loaded.length, nz);
  assert.equal(loaded[0], 0);
  assert.equal(loaded.at(-1), count - 1);
  assert.equal(volume.data[0], 0);
  assert.equal(volume.data[(nz - 1) * nx * ny], count - 1);
  assert.equal(volume.center, 22);
  assert.ok(volume.notes.some((note) => /reduc|mobile|memory/i.test(note)));
});

test('uses uniform center-aligned pixel representatives when an axis is capped', async () => {
  const row = Float32Array.from({ length: 400 }, (_, x) => x);
  const series = makeSeries(2, {
    frames: [{ id: 'slice-0' }, { id: 'slice-1' }],
  });
  const volume = await buildVolume(series, async () => makeFrame(row, {
    width: 400,
    height: 1,
    spacing: [1, 1],
  }));

  assert.deepEqual(volume.dimensions, [192, 1, 2]);
  assert.equal(volume.data[0], 1);
  assert.equal(volume.data[191], 398);
  assert.ok(Math.abs(volume.extentMm[0] - 400) < 1e-9);
});

test('center-samples a reduced slice axis while keeping window values from the original first frame', async () => {
  const count = 400;
  const loaded = [];
  const progress = [];
  const volume = await buildVolume(makeSeries(count, {
    orientation: undefined,
    frames: Array.from({ length: count }, (_, i) => ({ id: `slice-${i}` })),
  }), async (id) => {
    const z = Number(id.slice('slice-'.length));
    loaded.push(z);
    return makeFrame([z], {
      width: 1,
      height: 1,
      center: z === 0 ? 77 : z,
      spacing: [1, 1],
    });
  }, { onProgress: (done, total) => progress.push([done, total]) });

  assert.deepEqual(volume.dimensions, [1, 1, 192]);
  assert.equal(loaded[0], 0);
  assert.equal(loaded[1], 1);
  assert.equal(loaded.length, 193);
  assert.equal(volume.data[0], 1);
  assert.equal(volume.center, 77);
  assert.deepEqual(progress[0], [0, 192]);
  assert.deepEqual(progress.at(-1), [192, 192]);
});

test('keeps frame-load failures local and does not expose loader details in the UI message', async () => {
  await assert.rejects(
    buildVolume(makeSeries(2), async () => { throw new Error('Patient Alice Example /private/dicom/series'); }),
    (error) => error.message.includes('slice 1') && !error.message.includes('Alice') && !error.message.includes('/private'),
  );
});

test('passes the signal to the loader, reports progress, and rejects an abort before or after decoding', async () => {
  const before = new AbortController();
  before.abort();
  let calls = 0;
  await assert.rejects(
    buildVolume(makeSeries(2), async () => { calls += 1; return makeFrame([1, 2, 3, 4]); }, { signal: before.signal }),
    { name: 'AbortError' },
  );
  assert.equal(calls, 0);

  const during = new AbortController();
  const seenSignals = [];
  await assert.rejects(
    buildVolume(makeSeries(2), async (_id, signal) => {
      seenSignals.push(signal);
      during.abort();
      return makeFrame([1, 2, 3, 4]);
    }, { signal: during.signal }),
    { name: 'AbortError' },
  );
  assert.deepEqual(seenSignals, [during.signal]);
});

test('nativeResolution keeps exactly the 512 by 512 source grid and source voxel order', async () => {
  const width = 512;
  const height = 512;
  const depth = 4;
  const series = makeSeries(depth, {
    spacingZ: 2.5,
    frames: Array.from({ length: depth }, (_, z) => ({
      id: `slice-${z}`, instance: z + 1, position: [0, 0, 2.5 * z],
    })),
  });
  const loaded = [];
  const progress = [];
  const valueAt = (x, y, z) => z * 1000000 + y * width + x;
  const volume = await buildVolume(series, async (id) => {
    const z = Number(id.slice('slice-'.length));
    loaded.push(z);
    const pixels = new Float32Array(width * height);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) pixels[y * width + x] = valueAt(x, y, z);
    }
    return makeFrame(pixels, { width, height, spacing: [0.8, 0.5] });
  }, { nativeResolution: true, onProgress: (done, total) => progress.push([done, total]) });

  assert.deepEqual(volume.dimensions, [width, height, depth]);
  assert.deepEqual(volume.sourceDimensions, [width, height, depth]);
  assert.equal(volume.data.length, width * height * depth);
  assert.deepEqual(volume.extentMm, [width * 0.5, height * 0.8, depth * 2.5]);
  assert.equal(volume.data[0], 0);
  assert.equal(volume.data[width * height - 1], valueAt(width - 1, height - 1, 0));
  assert.equal(volume.data[width * height], valueAt(0, 0, 1));
  assert.equal(volume.data.at(-1), valueAt(width - 1, height - 1, depth - 1));
  assert.equal(volume.min, 0);
  assert.equal(volume.max, valueAt(width - 1, height - 1, depth - 1));
  assert.deepEqual(loaded, [0, 1, 2, 3]);
  assert.deepEqual(progress, [[0, depth], [1, depth], [2, depth], [3, depth], [4, depth]]);
  assert.deepEqual(volume.notes, []);
});

test('nativeResolution rejects an over-budget grid before loading the remaining frames', async () => {
  const depth = 257; // 512 * 512 * 257 exceeds the 256 MiB Float32 budget.
  const series = makeSeries(depth, {
    frames: Array.from({ length: depth }, (_, z) => ({ id: `slice-${z}`, position: [0, 0, z] })),
  });
  let calls = 0;
  await assert.rejects(
    buildVolume(series, async () => {
      calls += 1;
      return makeFrame(new Float32Array(512 * 512).fill(1), { width: 512, height: 512, spacing: [1, 1] });
    }, { nativeResolution: true }),
    (error) => error.code === 'VOLUME_NATIVE_LIMIT' && /256 MiB.*never decimated/i.test(error.message),
  );
  assert.equal(calls, 1);
});

test('nativeResolution keeps source axes beyond the MPR display cap instead of downsampling them', async () => {
  const width = 1500;
  const height = 3;
  const depth = 2;
  const series = makeSeries(depth, {
    frames: [
      { id: 'slice-0', position: [0, 0, 0] },
      { id: 'slice-1', position: [0, 0, 1] },
    ],
  });
  const volume = await buildVolume(series, async (_id) => makeFrame(
    new Float32Array(width * height).fill(7),
    { width, height, spacing: [1, 1] },
  ), { nativeResolution: true });

  assert.deepEqual(volume.dimensions, [width, height, depth]);
  assert.deepEqual(volume.sourceDimensions, [width, height, depth]);
  assert.equal(volume.data.length, width * height * depth);
  assert.ok(!volume.notes.some((note) => /reduced|downsampl/i.test(note)),
    'Native source axes above the MPR display cap must still be loaded exactly.');
});
