import assert from 'node:assert/strict';
import test from 'node:test';
import { mountBlend } from '../web/blend.js';

class Element extends EventTarget {
  constructor(doc, tag) {
    super();
    this.ownerDocument = doc;
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.attributes = new Map();
    this.style = {};
    this.value = '';
    this.textContent = '';
    this.hidden = false;
    this.disabled = false;
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  append(...nodes) {
    for (const node of nodes) {
      node.parent = this;
      this.children.push(node);
    }
  }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(node => node !== this); }
  getContext() {
    const canvas = this;
    return {
      createImageData: (width, height) => ({ width, height, data: new Uint8ClampedArray(width * height * 4) }),
      getImageData: (_x, _y, width, height) => canvas.imageData || { width, height, data: new Uint8ClampedArray(width * height * 4) },
      putImageData: image => { canvas.imageData = image; },
    };
  }
}

function viewer() {
  const doc = { createElement: tag => new Element(doc, tag) };
  return { host: doc.createElement('main') };
}

function find(node, label) {
  if (node.attributes.get('aria-label') === label) return node;
  for (const child of node.children) {
    const match = find(child, label);
    if (match) return match;
  }
}

const orientation = [1, 0, 0, 0, 1, 0];
function stack(prefix, { offset = [0, 0, 0], orient = orientation, forUID = 'same-frame', step = 5 } = {}) {
  return {
    modality: 'CT', volume: true, frameOfReference: forUID, orientation: orient,
    frames: [0, step].map((z, i) => ({
      id: `${prefix}${i}`, position: [offset[0], offset[1], offset[2] + z],
    })),
  };
}

function scalar(pixels, { width = 5, height = 1, spacing = [1, 0.5], center = 1, widthWindow = 2, invert = false } = {}) {
  return { type: 'f32', width, height, pixels: new Float32Array(pixels), spacing, center, widthWindow, invert };
}

const settle = () => new Promise(resolve => setImmediate(resolve));
const signalEvent = node => node.dispatchEvent(new Event('input'));

test('resamples a shifted phantom in DICOM coordinates using row/column spacing and a 1 mm origin offset', async () => {
  const { host } = viewer();
  const primary = stack('p');
  const second = stack('s', { offset: [1, 0, 0] });
  const cleanup = await mountBlend(host, {
    series: primary, second,
    loadFrame: async id => id[0] === 'p'
      ? scalar([0, 0, 0, 0, 0])
      : scalar([1, 0, 0, 0, 0]),
  });
  await settle();

  const image = find(host, 'Blended CT image').imageData.data;
  assert.equal(image[0], 0, 'same pixel index must not be copied from the shifted series');
  assert.ok(image[2 * 4] >= 126 && image[2 * 4] <= 129, '1 mm (two columns at 0.5 mm) maps to primary column 2');
  assert.equal(image[4 * 4], 0);
  assert.match(find(host, 'Blend geometry caution').textContent, /No motion correction/i);
  assert.match(find(host, 'Blend geometry caution').textContent, /1\.00 mm/);
  cleanup();
});

test('does not blend stacks with angular disagreement that creates plane drift across the image', async () => {
  const { host } = viewer();
  const theta = 0.5 * Math.PI / 180;
  const tilted = [Math.cos(theta), 0, Math.sin(theta), 0, 1, 0];
  const primary = stack('p');
  const second = stack('s', { orient: tilted });
  let loads = 0;
  const cleanup = await mountBlend(host, { series: primary, second, loadFrame: async () => { loads++; return scalar([0, 0, 0, 0, 0]); } });

  assert.equal(loads, 0);
  assert.match(find(host, 'Blend status').textContent, /orientation|angle|geometry/i);
  cleanup();
});

test('rejects a sub-tolerance normal angle when its across-field drift exceeds 0.5 mm', async () => {
  const { host } = viewer();
  const theta = 0.03 * Math.PI / 180;
  const tilted = [Math.cos(theta), 0, Math.sin(theta), 0, 1, 0];
  const primary = stack('p');
  const second = stack('s', { orient: tilted });
  const cleanup = await mountBlend(host, {
    series: primary, second,
    loadFrame: async id => scalar(new Array(1000).fill(0), { width: 1000, height: 1, spacing: [1, 1] }),
  });
  await settle();
  assert.match(find(host, 'Blend status').textContent, /0\.5\d mm field drift/i);
  assert.match(find(host, 'Blend geometry caution').textContent, /across-field plane drift: 0\.5\d mm/);
  cleanup();
});

test('uses valid per-frame PixelSpacing instead of a different decoded fallback', async () => {
  const { host } = viewer();
  const primary = stack('p');
  const second = stack('s', { offset: [1, 0, 0] });
  second.frames.forEach(frame => { frame.pixelSpacing = [1, 1]; });
  const cleanup = await mountBlend(host, {
    series: primary, second,
    loadFrame: async id => id[0] === 'p'
      ? scalar([0, 0, 0, 0, 0])
      : scalar([0, 1, 0, 0, 0], { spacing: [1, 0.5] }),
  });
  await settle();

  const image = find(host, 'Blended CT image').imageData.data;
  assert.ok(image[4 * 4] >= 126 && image[4 * 4] <= 129, 'record.pixelSpacing places the bright source pixel at column 4');
  assert.ok(image[3 * 4] > 0 && image[3 * 4] < 100, 'record.pixelSpacing produces an interpolated edge, not the decoded-spacing pixel at full intensity');
  cleanup();
});

test('resamples a rotated row/column grid with unequal row and column spacing', async () => {
  const { host } = viewer();
  const primary = stack('p');
  primary.frames.forEach(frame => { frame.pixelSpacing = [2, 0.5]; });
  const rotated = [0, 1, 0, -1, 0, 0];
  const second = stack('s', { offset: [2, 0, 0], orient: rotated });
  second.frames.forEach(frame => { frame.orientation = rotated; frame.pixelSpacing = [0.5, 1]; });
  const cleanup = await mountBlend(host, {
    series: primary, second,
    loadFrame: async id => id[0] === 'p'
      ? scalar(new Array(15).fill(0), { width: 5, height: 3, spacing: [2, 0.5] })
      : scalar([0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0], { width: 3, height: 5, spacing: [0.5, 1] }),
  });
  await settle();

  const image = find(host, 'Blended CT image').imageData.data;
  const targetPixel = (1 * 5 + 2) * 4;
  assert.ok(image[targetPixel] >= 126 && image[targetPixel] <= 129, 'patient-space location aligns despite the 90° in-plane direction change');
  assert.equal(image[(2 * 5 + 2) * 4], 0, 'same-index blending would place the signal on the wrong row');
  cleanup();
});

test('uses per-frame orientation when present and refuses its angular disagreement', async () => {
  const { host } = viewer();
  const primary = stack('p');
  const second = stack('s');
  const theta = 0.5 * Math.PI / 180;
  second.frames[0].orientation = [Math.cos(theta), 0, Math.sin(theta), 0, 1, 0];
  let loads = 0;
  const cleanup = await mountBlend(host, { series: primary, second, loadFrame: async () => { loads++; return scalar([0, 0, 0, 0, 0]); } });
  assert.equal(loads, 0);
  assert.match(find(host, 'Blend status').textContent, /orientation|angle|geometry/i);
  cleanup();
});

test('excludes a second plane when matchStacks has no nearby recorded slice', async () => {
  const { host } = viewer();
  const primary = stack('p');
  const second = stack('s', { offset: [0, 0, 20] });
  const loaded = [];
  const cleanup = await mountBlend(host, {
    series: primary, second,
    loadFrame: async id => { loaded.push(id); return scalar([0, 0, 0, 0, 0]); },
  });
  await settle();

  assert.deepEqual(loaded, ['p0']);
  assert.match(find(host, 'Blend status').textContent, /no nearby|no matching|outside/i);
  cleanup();
});

test('allows a 1 mm plane offset but refuses 9 mm even when thick-slice matching accepts it', async t => {
  await t.test('inclusive 1 mm limit', async () => {
    const { host } = viewer();
    const cleanup = await mountBlend(host, {
      series: stack('p', { step: 20 }), second: stack('s', { offset: [0, 0, 1], step: 20 }),
      loadFrame: async id => id[0] === 'p' ? scalar([0, 0, 0, 0, 0]) : scalar([1, 1, 1, 1, 1]),
    });
    await settle();
    const image = find(host, 'Blended CT image').imageData.data;
    assert.ok(image[0] >= 126 && image[0] <= 129);
    assert.match(find(host, 'Blend geometry caution').textContent, /Plane separation at image origins: 1\.00 mm/);
    cleanup();
  });
  await t.test('thick stack refuses 9 mm', async () => {
    const { host } = viewer();
    const cleanup = await mountBlend(host, {
      series: stack('p', { step: 20 }), second: stack('s', { offset: [0, 0, 9], step: 20 }),
      loadFrame: async id => id[0] === 'p' ? scalar([0, 0, 0, 0, 0]) : scalar([1, 1, 1, 1, 1]),
    });
    await settle();
    assert.match(find(host, 'Blend geometry caution').textContent, /9\.00 mm.*1\.00 mm/i);
    assert.equal(find(host, 'Blend status').textContent.includes('source slice only'), true);
    assert.equal(find(host, 'Blended CT image').imageData.data[0], 0);
    cleanup();
  });
});

test('refuses missing Frame of Reference and non-CT or non-scalar input before loading pixels', async () => {
  for (const [series, second] of [
    [stack('p', { forUID: '' }), stack('s', { forUID: '' })],
    [{ ...stack('p'), modality: 'MR' }, stack('s')],
  ]) {
    const { host } = viewer();
    let loads = 0;
    const cleanup = await mountBlend(host, { series, second, loadFrame: async () => { loads++; return scalar([0, 0, 0, 0, 0]); } });
    assert.equal(loads, 0);
    assert.match(find(host, 'Blend status').textContent, /CT|reference|geometry/i);
    cleanup();
  }

  const { host } = viewer();
  const cleanup = await mountBlend(host, {
    series: stack('p'), second: stack('s'),
    loadFrame: async () => ({ ...scalar([0, 0, 0, 0, 0]), type: 'rgb', pixels: new Uint8Array(15) }),
  });
  await settle();
  assert.match(find(host, 'Blend status').textContent, /scalar|monochrome|frame/i);
  cleanup();
});

test('keeps the primary visible when the secondary is missing or decodes as RGB', async t => {
  for (const [label, loadFrame, expected] of [
    ['rejected load', async id => { if (id[0] === 's') throw new Error('Secondary unavailable'); return scalar([0, 0, 0, 0, 0]); }, /secondary|unavailable/i],
    ['RGB decode', async id => id[0] === 's'
      ? { ...scalar([0, 0, 0, 0, 0]), type: 'rgb', pixels: new Uint8Array(15) }
      : scalar([0, 0, 0, 0, 0]), /scalar|monochrome|secondary/i],
  ]) {
    await t.test(label, async () => {
      const { host } = viewer();
      const cleanup = await mountBlend(host, { series: stack('p'), second: stack('s'), loadFrame });
      await settle();
      assert.ok(find(host, 'Blended CT image').imageData, 'the primary slice remains visible');
      assert.match(find(host, 'Blend status').textContent, expected);
      cleanup();
    });
  }
});

test('stale loads are aborted and cannot repaint after selecting another source slice', async () => {
  const { host } = viewer();
  const primary = stack('p');
  const second = stack('s');
  let resolveFirst;
  let firstSignal;
  const cleanup = await mountBlend(host, {
    series: primary, second,
    loadFrame(id, signal) {
      if (id === 'p0') {
        firstSignal = signal;
        return new Promise(resolve => { resolveFirst = resolve; });
      }
      return Promise.resolve(scalar(id[0] === 'p' ? [0, 0, 0, 0, 0] : [1, 1, 1, 1, 1]));
    },
  });
  const slider = find(host, 'Source slice');
  slider.value = '2';
  signalEvent(slider);
  await settle();
  const selectedPixels = [...find(host, 'Blended CT image').imageData.data];
  assert.equal(firstSignal.aborted, true);
  resolveFirst(scalar([1, 1, 1, 1, 1]));
  await settle();
  assert.deepEqual([...find(host, 'Blended CT image').imageData.data], selectedPixels);
  cleanup();
});

test('clears the prior image and distance warning while a selected source load is pending or fails', async () => {
  const { host } = viewer();
  const primary = stack('p');
  const second = stack('s', { offset: [0, 0, 1] });
  let rejectPrimary;
  const cleanup = await mountBlend(host, {
    series: primary, second,
    loadFrame(id) {
      if (id === 'p1') return new Promise((_resolve, reject) => { rejectPrimary = reject; });
      return Promise.resolve(id[0] === 'p' ? scalar([0, 0, 0, 0, 0]) : scalar([1, 1, 1, 1, 1]));
    },
  });
  await settle();
  const canvas = find(host, 'Blended CT image');
  const warning = find(host, 'Blend geometry caution');
  const defaultWarning = 'No motion correction. Plane separation and in-plane offset are different measurements.';
  assert.equal(canvas.width, 5);
  assert.match(warning.textContent, /1\.00 mm/);

  const slider = find(host, 'Source slice');
  slider.value = '2';
  signalEvent(slider);
  assert.equal(canvas.width, 0, 'old pixels clear synchronously on selection');
  assert.equal(warning.textContent, defaultWarning, 'old geometry values clear synchronously on selection');
  await settle();
  rejectPrimary(new Error('Primary frame missing'));
  await settle();
  assert.equal(canvas.width, 0, 'a failed source frame does not leave the previous slice visible');
  assert.equal(warning.textContent, defaultWarning);
  assert.match(find(host, 'Blend status').textContent, /could not load source slice/i);
  cleanup();
});

test('applies each decoded frame’s MONOCHROME1 inversion to its own raster', async t => {
  for (const [label, primaryInvert, secondInvert, alpha] of [
    ['primary', true, false, '0'],
    ['secondary', false, true, '100'],
  ]) {
    await t.test(label, async () => {
      const { host } = viewer();
      const cleanup = await mountBlend(host, {
        series: stack('p'), second: stack('s'),
        loadFrame: async id => scalar([0, 0, 0, 0, 0], { invert: id[0] === 'p' ? primaryInvert : secondInvert }),
      });
      await settle();
      const opacity = find(host, 'Overlay opacity');
      opacity.value = alpha;
      signalEvent(opacity);
      assert.equal(find(host, 'Blended CT image').imageData.data[0], 255);
      cleanup();
    });
  }
});

test('an aborted mount makes no requests', async () => {
  const { host } = viewer();
  const signal = AbortSignal.abort();
  let loads = 0;
  const cleanup = await mountBlend(host, {
    series: stack('p'), second: stack('s'), signal,
    loadFrame: async () => { loads++; return scalar([0, 0, 0, 0, 0]); },
  });
  assert.equal(loads, 0);
  cleanup();
});

test('external cancellation aborts both in-flight decodes and clears the viewer', async () => {
  const { host } = viewer();
  const lifetime = new AbortController();
  const signals = [];
  const cleanup = await mountBlend(host, {
    series: stack('p'), second: stack('s'), signal: lifetime.signal,
    loadFrame: (_id, signal) => { signals.push(signal); return new Promise(() => {}); },
  });
  await settle();
  lifetime.abort();
  assert.equal(signals.length, 2);
  assert.ok(signals.every(signal => signal.aborted));
  assert.equal(host.children.length, 0);
  cleanup();
});

test('cleanup removes only its own root if the host has since been remounted', async () => {
  const { host } = viewer();
  const cleanup = await mountBlend(host, {
    series: stack('p'), second: stack('s'), loadFrame: async () => new Promise(() => {}),
  });
  const replacement = host.ownerDocument.createElement('p');
  host.replaceChildren(replacement);
  cleanup();
  assert.deepEqual(host.children, [replacement]);
});
