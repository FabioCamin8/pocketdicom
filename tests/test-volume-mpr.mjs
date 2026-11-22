import assert from 'node:assert/strict';
import test from 'node:test';
import {
  mprPlanes, mprCrosshair, moveMprCrosshair, mprSliceIndex, setMprSlice, renderMpr,
} from '../web/volume-mpr.js';

const identity = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];

function phantom({dimensions = [3, 3, 3], spacing = [1, 2, 4], axes = identity,
  invert = false, sample = (x, y, z) => x + 3 * y + 9 * z} = {}) {
  const data = [];
  for (let z = 0; z < dimensions[2]; z++) {
    for (let y = 0; y < dimensions[1]; y++) {
      for (let x = 0; x < dimensions[0]; x++) data.push(sample(x, y, z));
    }
  }
  return {
    dimensions, spacing, axes, calibrated: true,
    extentMm: dimensions.map((n, i) => n * spacing[i]),
    data: new Float32Array(data), center: 128, widthWindow: 256, invert,
  };
}

function geometry({dimensions, spacing = [1, 1, 1], axes = identity, sourceDimensions}) {
  return {
    dimensions,
    ...(sourceDimensions ? {sourceDimensions} : {}),
    spacing,
    axes,
    calibrated: true,
    extentMm: dimensions.map((n, i) => n * spacing[i]),
  };
}

function gray(volume, plane, cursor, options) {
  return [...renderMpr(volume, plane, cursor, options)].filter((_, i) => i % 4 === 0);
}

test('patient planes have radiological edges, correct mm aspect and registered signals', () => {
  const volume = phantom();
  const [axial, coronal, sagittal] = mprPlanes(volume);
  assert.deepEqual([axial.name, coronal.name, sagittal.name], ['Axial', 'Coronal', 'Sagittal']);
  assert.deepEqual(axial.edges, ['R', 'L', 'A', 'P']);
  assert.deepEqual(coronal.edges, ['R', 'L', 'S', 'I']);
  assert.deepEqual(sagittal.edges, ['A', 'P', 'S', 'I']);
  assert.deepEqual([axial.aspect, coronal.aspect, sagittal.aspect], [0.5, 0.25, 0.5]);
  assert.deepEqual(gray(volume, axial, [0, 0, 0]), [9, 10, 11, 12, 13, 14, 15, 16, 17]);
  assert.deepEqual(gray(volume, coronal, [0, 0, 0]), [21, 22, 23, 12, 13, 14, 3, 4, 5]);
  assert.deepEqual(gray(volume, sagittal, [0, 0, 0]), [19, 22, 25, 10, 13, 16, 1, 4, 7]);
});

test('patient axes, not storage order, set display sides and slice order', () => {
  const volume = phantom({axes: [[0, 1, 0], [-1, 0, 0], [0, 0, -1]]});
  const [axial, coronal] = mprPlanes(volume);
  const cursor = setMprSlice(axial, [0, 0, 0], 0);
  assert.deepEqual(gray(volume, axial, cursor), [24, 21, 18, 25, 22, 19, 26, 23, 20]);
  assert.equal(gray(volume, coronal, [0, 0, 0])[1], 4); // superior = first stored frame
});

test('oblique axial is a patient-space reslice, with masked corners and interpolated center', () => {
  const q = Math.SQRT1_2;
  const volume = phantom({dimensions: [4, 4, 4], spacing: [1, 1, 1],
    axes: [[1, 0, 0], [0, q, q], [0, -q, q]], invert: true,
    sample: (_x, y, z) => 20 + 20 * y + 40 * z});
  const [axial] = mprPlanes(volume);
  const raster = gray(volume, axial, [0, 0, 2]);
  assert.deepEqual([axial.width, axial.height], [4, 6]);
  assert.equal(raster[0], 0); // Outside the rotated volume, even with inversion
  assert.equal(raster.at(-1), 0);
  assert.equal(raster[2 * axial.width + 2], 63);
});

test('linked crosshairs select orthogonal coordinates without changing the displayed slice', () => {
  const [axial, coronal, sagittal] = mprPlanes(phantom());
  const cursor = moveMprCrosshair(coronal, [0, -2, 0], 0.9, 0.1);
  assert.deepEqual([mprSliceIndex(axial, cursor), mprSliceIndex(coronal, cursor),
    mprSliceIndex(sagittal, cursor)], [2, 0, 2]);
  assert.deepEqual(mprCrosshair(sagittal, cursor).map(n => n.toFixed(3)), ['0.167', '0.167']);
  assert.equal(mprSliceIndex(axial, setMprSlice(axial, cursor, -10)), 0);
});

test('missing orientation or size metadata never implies anatomical planes', () => {
  const volume = phantom({axes: null});
  const [first] = mprPlanes(volume);
  assert.equal(first.name, 'Acquisition');
  assert.deepEqual(first.edges, []);
  assert.deepEqual(gray(volume, first, [0, 0, 0]), [9, 10, 11, 12, 13, 14, 15, 16, 17]);
  assert.deepEqual(mprPlanes({...phantom(), calibrated: false})[0].edges, []);
});

test('invalid voxels stay black without masking an adjacent valid voxel center', () => {
  const volume = phantom({dimensions: [3, 1, 2], invert: true,
    sample: (x, _y, z) => x === 1 && z === 0 ? NaN : 50 + x});
  const [axial] = mprPlanes(volume);
  assert.deepEqual(gray(volume, axial, setMprSlice(axial, [0, 0, 0], 0)), [205, 0, 203]);
});

test('a width of two follows the DICOM linear window used in the 2D viewer', () => {
  const volume = phantom({dimensions: [3, 1, 2], sample: x => 9 + x});
  const [axial] = mprPlanes(volume);
  assert.deepEqual(gray(volume, axial, [0, 0, 0], {center: 10, widthWindow: 2}), [0, 255, 255]);
});

test('supports an exact 512 by 512 axial raster without crossing the axis bound', () => {
  const volume = phantom({dimensions: [512, 512, 2], spacing: [1, 1, 1], sample: () => 50});
  const [axial, coronal] = mprPlanes(volume);
  assert.deepEqual([axial.width, axial.height, axial.slices], [512, 512, 2]);
  assert.deepEqual([coronal.width, coronal.height], [512, 2]);
  const pixels = renderMpr(volume, axial, [0, 0, 0]);
  assert.equal(pixels.length, 512 * 512 * 4);
  assert.equal(pixels[(256 * 512 + 256) * 4], 50);
});

test('native sections keep physical axis counts above 1024 while sampled sections stay bounded', () => {
  const native = geometry({dimensions: [1500, 1200, 3], sourceDimensions: [1500, 1200, 3]});
  const [axial, coronal, sagittal] = mprPlanes(native);
  assert.deepEqual([axial.width, axial.height, axial.slices], [1500, 1200, 3]);
  assert.deepEqual([coronal.width, coronal.height, coronal.slices], [1500, 3, 1200]);
  assert.deepEqual([sagittal.width, sagittal.height, sagittal.slices], [1200, 3, 1500]);
  assert.equal(axial.aspect, 1500 / 1200);
  assert.equal(axial.note, undefined);

  const sampled = geometry({dimensions: [1500, 1200, 3], sourceDimensions: [3000, 2400, 6]});
  const [sampledAxial] = mprPlanes(sampled);
  assert.deepEqual([sampledAxial.width, sampledAxial.height], [1024, 1024]);
  assert.equal(sampledAxial.slices, 3);
  assert.equal(sampledAxial.aspect, 1500 / 1200);
  assert.equal(sampledAxial.note, undefined);
});

test('pathological native rasters are bounded proportionally without losing physical slices or aspect', () => {
  const volume = geometry({dimensions: [4096, 2048, 5], spacing: [1, 1, 2],
    sourceDimensions: [4096, 2048, 5]});
  const planes = mprPlanes(volume);
  const [axial] = planes;
  assert.deepEqual(axial.counts, [4096, 2048, 5]);
  assert.ok(axial.width * axial.height <= 4_000_000);
  assert.ok(axial.width < 4096 && axial.height < 2048);
  assert.equal(axial.aspect, 2);
  assert.equal(axial.slices, 5);
  assert.equal(mprSliceIndex(axial, setMprSlice(axial, [0, 0, 0], 4)), 4);
  assert.match(axial.note, /raster reduced/);
  assert.equal(axial.resampled, true);
  assert.equal(planes[1].note, undefined); // Narrow planes need no reduction.
});
