import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createExportCanvas,
  createRaster,
  drawFrame,
  makeTransform,
  measureAnnotation,
} from '../web/slice-render.js';

function makeCanvas() {
  const calls = [];
  const context = {
    calls,
    createImageData(width, height) {
      return { width, height, data: new Uint8ClampedArray(width * height * 4) };
    },
    putImageData(image) { this.image = image; calls.push(['putImageData', image]); },
    setTransform(...args) { calls.push(['setTransform', ...args]); },
    clearRect(...args) { calls.push(['clearRect', ...args]); },
    fillRect(...args) { calls.push(['fillRect', ...args]); },
    drawImage(...args) { calls.push(['drawImage', ...args]); },
    save() { calls.push(['save']); },
    restore() { calls.push(['restore']); },
    beginPath() { calls.push(['beginPath']); },
    moveTo(...args) { calls.push(['moveTo', ...args]); },
    lineTo(...args) { calls.push(['lineTo', ...args]); },
    stroke() { calls.push(['stroke']); },
    arc(...args) { calls.push(['arc', ...args]); },
    fill() { calls.push(['fill']); },
    measureText(text) { return { width: text.length * 6 }; },
    fillText(...args) { calls.push(['fillText', ...args]); },
    strokeText(...args) { calls.push(['strokeText', ...args]); },
    setLineDash(...args) { calls.push(['setLineDash', ...args]); },
    translate(...args) { calls.push(['translate', ...args]); },
    rotate(...args) { calls.push(['rotate', ...args]); },
  };
  return {
    width: 0,
    height: 0,
    calls,
    context,
    getContext() { return context; },
  };
}

const doc = { createElement: () => makeCanvas() };

test('measureAnnotation applies row/column spacing to distance and angle', () => {
  assert.equal(
    measureAnnotation({ kind: 'distance', points: [{ x: 0, y: 0 }, { x: 3, y: 4 }] }, [2, 1]),
    '8.5 mm',
  );
  assert.equal(
    measureAnnotation({ kind: 'angle', points: [{ x: 1, y: 0 }, { x: 0, y: 0 }, { x: 1, y: 1 }] }, [2, 1]),
    '63.4°',
  );
});

test('measureAnnotation ignores incomplete or non-finite points', () => {
  assert.equal(measureAnnotation({ kind: 'distance', points: [{ x: 0, y: 0 }, null] }, [1, 1]), '');
  assert.equal(measureAnnotation({ kind: 'angle', points: [{ x: 0, y: 0 }, { x: NaN, y: 0 }, { x: 1, y: 1 }] }, [1, 1]), '');
});

test('makeTransform rotates physical coordinates and round-trips points', () => {
  const transform = makeTransform(
    { columns: 5, rows: 3, pixelSpacing: [2, 1] },
    { width: 100, height: 100 },
    { zoom: 1, panX: 0, panY: 0, rotation: 90 },
  );
  const projected = transform.project({ x: 3, y: 1 });
  assert.ok(Math.abs(projected.x - 50) < 1e-9);
  assert.ok(Math.abs(projected.y - (50 + 100 / 6)) < 1e-9);
  const original = transform.unproject(projected);
  assert.ok(Math.abs(original.x - 3) < 1e-9);
  assert.ok(Math.abs(original.y - 1) < 1e-9);
});

test('createRaster applies the DICOM LINEAR window function and inversion', () => {
  const frame = {
    columns: 4,
    rows: 1,
    pixels: new Float32Array([-1, -0.5, 0, 0.5]),
    photometricInterpretation: 'MONOCHROME2',
  };
  const raster = createRaster(doc, frame, { center: 0, widthWindow: 2, invert: false });
  assert.deepEqual([...raster.context.image.data], [0, 0, 0, 255, 128, 128, 128, 255, 255, 255, 255, 255, 255, 255, 255, 255]);

  const inverted = createRaster(doc, frame, { center: 0, widthWindow: 2, invert: true });
  assert.deepEqual([...inverted.context.image.data].filter((_, i) => i % 4 === 0), [255, 127, 0, 0]);
});

test('createRaster clamps a LINEAR window width below one', () => {
  const frame = { columns: 3, rows: 1, pixels: new Float32Array([9.49, 9.5, 10]) };
  const raster = createRaster(doc, frame, { center: 10, widthWindow: 0, invert: false });
  assert.deepEqual([...raster.context.image.data].filter((_, i) => i % 4 === 0), [0, 0, 255]);
});

test('createRaster rejects pixel data that does not match the frame dimensions', () => {
  assert.throws(
    () => createRaster(doc, { columns: 2, rows: 2, pixels: new Float32Array(3) }, { center: 0, widthWindow: 1 }),
    /shorter than its dimensions/,
  );
});

test('createRaster preserves interleaved RGB values unless inversion is requested', () => {
  const frame = {
    columns: 2,
    rows: 1,
    pixels: new Uint8Array([0, 10, 200, 255, 128, 64]),
    type: 'rgb',
  };
  const raster = createRaster(doc, frame, { center: 0, widthWindow: 1, invert: false });
  assert.deepEqual([...raster.context.image.data], [0, 10, 200, 255, 255, 128, 64, 255]);
  const inverted = createRaster(doc, frame, { center: 0, widthWindow: 1, invert: true });
  assert.deepEqual([...inverted.context.image.data], [255, 245, 55, 255, 0, 127, 191, 255]);
});

test('drawFrame uses DPR for the image and screen-space annotation overlay', () => {
  const canvas = makeCanvas();
  const raster = makeCanvas();
  const transform = {
    matrix: [2, 0, 0, 2, 20, 30],
    project: ({ x, y }) => ({ x: 2 * x + 20, y: 2 * y + 30 }),
  };
  drawFrame(canvas, { width: 100, height: 80, dpr: 2 }, raster, transform, [
    { kind: 'distance', points: [{ x: 0, y: 0 }, { x: 2, y: 0 }] },
  ], [1, 1]);
  assert.equal(canvas.width, 200);
  assert.equal(canvas.height, 160);
  assert.ok(canvas.calls.some((call) => call[0] === 'setTransform' && call[1] === 2 && call[2] === 0 && call[4] === 2));
  assert.ok(canvas.calls.some((call) => call[0] === 'moveTo' && call[1] === 20 && call[2] === 30));
  assert.ok(canvas.calls.some((call) => call[0] === 'fillText' && call[1] === '2.0 mm'));

  const blank = makeCanvas();
  drawFrame(blank, { width: 10, height: 8, dpr: 1 }, null, null, [], [1, 1]);
  assert.ok(blank.calls.some((call) => call[0] === 'fillRect' && call[1] === 0 && call[2] === 0 && call[3] === 10 && call[4] === 8));
});

test('createExportCanvas corrects pixel aspect, rotates, and omits draft annotations', () => {
  const raster = makeCanvas();
  const frame = { columns: 2, rows: 1, pixelSpacing: [2, 1] };
  const exported = createExportCanvas(doc, frame, raster, 90, [
    { kind: 'distance', points: [{ x: 0, y: 0 }, { x: 1, y: 0 }] },
    { kind: 'distance', points: [{ x: 0, y: 0 }, { x: 1, y: 0 }], draft: true },
  ]);
  assert.equal(exported.width, 2);
  assert.equal(exported.height, 2);
  assert.equal(exported.calls.filter((call) => call[0] === 'drawImage').length, 1);
  assert.equal(exported.calls.filter((call) => call[0] === 'fillText').length, 1);
});

test('createExportCanvas bounds extreme pixel aspect without collapsing the raster', () => {
  const raster = makeCanvas();
  const exported = createExportCanvas(doc, { columns: 2, rows: 3, pixelSpacing: [1e12, 1] }, raster, 0, []);
  assert.ok(exported.width <= 8192);
  assert.ok(exported.height <= 8192);
  const draw = exported.calls.find((call) => call[0] === 'drawImage');
  assert.ok(draw[4] >= 1);
  assert.ok(draw[5] >= 1);
});
