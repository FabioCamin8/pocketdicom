import assert from 'node:assert/strict';
import test from 'node:test';
import { drawSourceOverlays } from '../web/slice-overlay.js';

test('clips negative origins and reads LSB-first bits continuously across rows', () => {
  const runs = [];
  const raster = {
    width: 4, height: 3,
    getContext: () => ({ save() {}, restore() {}, fillRect: (...args) => runs.push(args) }),
  };
  // 3×3 bits: 110 / 011 / 101, image origin (-1, 0).
  drawSourceOverlays(raster, [{ x: -1, y: 0, width: 3, height: 3, mask: 'cwE=' }]);
  assert.deepEqual(runs, [[0, 0, 1, 1], [0, 1, 2, 1], [1, 2, 1, 1]]);
});

test('skips malformed, empty and off-image graphics without affecting valid graphics', () => {
  const runs = [];
  const raster = {
    width: 2, height: 3,
    getContext: () => ({ save() {}, restore() {}, fillRect: (...args) => runs.push(args) }),
  };
  drawSourceOverlays(raster, [
    null, { x: 0, y: 0, width: 5, height: 2, mask: 'AQ==' },
    { x: 0, y: 0, width: 1, height: 1, mask: '*Q==' },
    { x: 0, y: 3, width: 1, height: 1, mask: 'AQ==' },
    { x: 1, y: 2, width: 1, height: 1, mask: 'AQ==' },
  ]);
  assert.deepEqual(runs, [[1, 2, 1, 1]]);
});
