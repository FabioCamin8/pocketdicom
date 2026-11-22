import assert from 'node:assert/strict';
import test from 'node:test';
import { mountSlice } from '../web/slice.js';

class Element extends EventTarget {
  constructor(doc, tag) {
    super();
    this.ownerDocument = doc;
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.attributes = new Map();
    this.style = {};
    this.dataset = {};
    this.value = '';
    this.drawCalls = [];
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  append(...nodes) {
    for (const node of nodes) {
      node.parent = this;
      this.children.push(node);
    }
  }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(node => node !== this); }
  focus() {}
  click() { if (this.download) this.ownerDocument.downloads.push(this.download); }
  toDataURL() { this.ownerDocument.exported = this; return 'data:image/png;base64,AAAA'; }
  getBoundingClientRect() { return { left: 0, top: 0, width: 320, height: 240 }; }
  getContext() {
    return {
      createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
      putImageData: image => this.ownerDocument.decoded.push(image.data),
      save() {}, restore() {}, setTransform() {}, translate() {}, rotate() {},
      beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, fill() {}, strokeText() {}, setLineDash() {},
      measureText: text => ({ width: text.length * 6 }),
      fillRect: (...args) => this.ownerDocument.overlayRuns.push(args),
      drawImage: (...args) => this.drawCalls.push(['image', ...args]),
      fillText: (...args) => this.drawCalls.push(['text', ...args]),
      arc: (...args) => this.drawCalls.push(['handle', ...args]),
    };
  }
}

function viewer() {
  const timers = new Map();
  let paint;
  let next = 0;
  const doc = {
    overlayRuns: [],
    decoded: [],
    downloads: [],
    createElement(tag) { return new Element(doc, tag); },
    defaultView: {
      CustomEvent,
      requestAnimationFrame: fn => { paint = fn; return 1; },
      cancelAnimationFrame() { paint = undefined; },
      setTimeout(fn, delay) { timers.set(++next, { fn, delay }); return next; },
      clearTimeout(id) { timers.delete(id); },
    },
  };
  return {
    host: doc.createElement('main'), timers, overlayRuns: doc.overlayRuns, decoded: doc.decoded, doc,
    paint() { const callback = paint; paint = undefined; callback?.(); },
  };
}

function control(node, label) {
  if (node.attributes.get('aria-label') === label || node.textContent === label) return node;
  for (const child of node.children) {
    const match = control(child, label);
    if (match) return match;
  }
}

function fire(node, type, fields) {
  assert.ok(node, `Missing control for ${type}`);
  node.dispatchEvent(Object.assign(new Event(type, { cancelable: true }), fields));
}

const series = {
  id: 'synthetic', label: 'Synthetic stack', modality: 'CT',
  frames: ['a', 'b', 'c'].map((id, i) => ({ id, label: `Synthetic image ${i + 1}`, instance: i + 1 })),
};
const pixels = (width = 2, height = 3) => ({
  width, height, type: 'f32', pixels: new Float32Array(width * height), center: 25,
  widthWindow: 50, invert: false, spacing: [2, 1],
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('initial index, next button, slider and host-only compare jumps select without echoing', async () => {
  const { host } = viewer();
  const selected = [];
  const calls = [];
  host.addEventListener('slice-position', e => {
    selected.push(e.detail.index);
    assert.equal(e.bubbles, false);
  });
  const cleanup = await mountSlice(host, {
    series, initialIndex: 1,
    loadFrame: async id => { calls.push(id); return pixels(); },
  });
  await settle();
  fire(control(host, 'Next frame'), 'click');
  host.dispatchEvent(new CustomEvent('slice-jump', { detail: { index: 0 } }));
  const slider = control(host, 'Frame');
  assert.equal(slider.value, '1');
  slider.value = '2';
  fire(slider, 'input');
  await settle();
  assert.deepEqual(calls, ['b', 'c', 'a', 'b']);
  assert.deepEqual(selected, [2, 1]);
  cleanup();
  assert.equal(host.children.length, 0);
  host.dispatchEvent(new CustomEvent('slice-jump', { detail: { index: 2 } }));
  assert.deepEqual(calls, ['b', 'c', 'a', 'b']);
});

test('out-of-order images and tags cannot replace the selected frame or restore an error', async () => {
  const { host } = viewer();
  const firstPixels = deferred();
  const firstTags = deferred();
  const requests = new Map();
  const unmount = new AbortController();
  const cleanup = await mountSlice(host, {
    series, signal: unmount.signal,
    loadFrame: (id, signal) => {
      requests.set(id, signal);
      return id === 'a' ? firstPixels.promise : Promise.resolve(pixels(8, 6));
    },
    loadTags: id => id === 'a' ? firstTags.promise : Promise.resolve({ PhotometricInterpretation: 'MONOCHROME2' }),
  });
  fire(control(host, 'Next frame'), 'click');
  await settle();
  assert.equal(requests.get('a').aborted, true);
  const info = control(host, 'Image properties');
  assert.match(info.textContent, /8 × 6.*MONOCHROME2/);
  firstPixels.reject(new Error('Older frame failed'));
  firstTags.resolve({ PhotometricInterpretation: 'STALE TAG' });
  await settle();
  assert.match(info.textContent, /8 × 6.*MONOCHROME2/);
  assert.equal(control(host, 'Retry frame').hidden, true);
  unmount.abort();
  assert.equal(requests.get('b').aborted, true);
  assert.equal(host.children.length, 0);
  cleanup();
});

test('keyboard navigation does not change windowed zoom state; reset restores the frame default', async () => {
  const { host } = viewer();
  const cleanup = await mountSlice(host, { series, loadFrame: async () => pixels() });
  await settle();
  const center = control(host, 'Window center');
  const width = control(host, 'Window width');
  const invert = control(host, 'Invert');
  center.value = '-14';
  fire(center, 'change');
  fire(invert, 'click');
  fire(control(host, 'Rotate clockwise'), 'click');
  fire(control(host, 'Zoom in'), 'click');
  fire(control(host, 'Image viewport'), 'keydown', { key: 'ArrowRight' });
  await settle();
  assert.equal(control(host, 'Frame').value, '2');
  assert.equal(center.value, '-14');
  assert.equal(invert.attributes.get('aria-pressed'), 'true');
  assert.match(control(host, 'View properties').textContent, /125%.*90°/);
  fire(control(host, 'Reset view'), 'click');
  assert.equal(center.value, '25');
  assert.equal(width.value, '50');
  assert.equal(invert.attributes.get('aria-pressed'), 'false');
  assert.match(control(host, 'View properties').textContent, /100%.*0°/);
  cleanup();
});

test('cine uses the chosen speed without overlapping decode and stops on command', async () => {
  const { host, timers } = viewer();
  const pending = deferred();
  const cleanup = await mountSlice(host, {
    series,
    loadFrame: id => id === 'b' ? pending.promise : Promise.resolve(pixels()),
  });
  await settle();
  const speed = control(host, 'Cine speed');
  speed.value = '12';
  fire(speed, 'change');
  fire(control(host, 'Play cine'), 'click');
  const [[id, tick]] = timers;
  assert.ok(Math.abs(tick.delay - 1000 / 12) < 1);
  timers.delete(id);
  tick.fn();
  assert.equal(control(host, 'Frame').value, '2');
  assert.equal(timers.size, 0);
  fire(control(host, 'Stop cine'), 'click');
  pending.resolve(pixels());
  await settle();
  assert.equal(timers.size, 0);
  assert.equal(control(host, 'Frame').value, '2');
  cleanup();
});

test('only the selected frame can show source graphics, and the toggle persists', async () => {
  const { host, overlayRuns } = viewer();
  const first = deferred();
  const cleanup = await mountSlice(host, {
    series, loadFrame: async () => pixels(),
    loadOverlays: id => id === 'a' ? first.promise : [{ x: 1, y: 1, width: 1, height: 1, mask: 'AQ==' }],
  });
  fire(control(host, 'Next frame'), 'click');
  await settle();
  assert.deepEqual(overlayRuns, [[1, 1, 1, 1]]);
  const toggle = control(host, 'Source overlays');
  fire(toggle, 'click');
  assert.equal(toggle.attributes.get('aria-pressed'), 'false');
  first.resolve([{ x: 0, y: 0, width: 1, height: 1, mask: 'AQ==' }]);
  fire(control(host, 'Next frame'), 'click');
  await settle();
  assert.deepEqual(overlayRuns, [[1, 1, 1, 1]]);
  fire(toggle, 'click');
  assert.deepEqual(overlayRuns, [[1, 1, 1, 1], [1, 1, 1, 1]]);
  cleanup();
});

test('moving the slider during cine selects the user’s frame and stops playback', async () => {
  const { host, timers } = viewer();
  const cleanup = await mountSlice(host, { series, loadFrame: async () => pixels() });
  await settle();
  fire(control(host, 'Play cine'), 'click');
  const slider = control(host, 'Frame');
  slider.value = '3';
  fire(slider, 'input');
  assert.equal(slider.value, '3');
  assert.equal(timers.size, 0);
  assert.ok(control(host, 'Play cine'));
  cleanup();
});

test('a rotated line measures row/column spacing; edit changes it only on its own frame', async () => {
  const { host } = viewer();
  const cleanup = await mountSlice(host, { series, loadFrame: async () => pixels(10, 10) });
  await settle();
  const [canvas] = control(host, 'Image viewport').children;
  function drag(from, to) {
    for (const [type, [clientX, clientY]] of [['pointerdown', from], ['pointermove', to], ['pointerup', to]]) {
      fire(canvas, type, { clientX, clientY, button: 0, pointerType: 'mouse', pointerId: 1 });
    }
  }
  fire(control(host, 'Rotate clockwise'), 'click');
  fire(control(host, 'Distance'), 'click');
  drag([160, 120], [128, 168]);
  const measurements = control(host, 'Measurements');
  assert.match(measurements.textContent, /1 measurement · 3.6 mm/);
  fire(control(host, 'Edit'), 'click');
  drag([128, 168], [96, 184]);
  assert.match(measurements.textContent, /1 measurement · 5.7 mm/);
  fire(control(host, 'Next frame'), 'click');
  await settle();
  assert.equal(measurements.textContent, '');
  fire(control(host, 'Previous frame'), 'click');
  await settle();
  assert.match(measurements.textContent, /1 measurement · 5.7 mm/);
  cleanup();
});

test('the RGB loader contract does not apply monochrome windowing', async () => {
  const { host, decoded } = viewer();
  const cleanup = await mountSlice(host, {
    series,
    loadFrame: async () => ({ ...pixels(1, 1), type: 'rgb', pixels: new Uint8Array([5, 50, 200]) }),
  });
  await settle();
  assert.deepEqual([...decoded.at(-1)], [5, 50, 200, 255]);
  assert.equal(control(host, 'Window center').disabled, true);
  assert.equal(control(host, 'Inspect pixel').disabled, true);
  cleanup();
});

test('completed measurements survive remount with a session annotation store, isolated by series', async () => {
  const { host } = viewer();
  const annotationStore = new Map();
  const opts = { series, annotationStore, loadFrame: async () => pixels(10, 10) };
  let cleanup = await mountSlice(host, opts);
  await settle();
  fire(control(host, 'Distance'), 'click');
  const viewport = control(host, 'Image viewport');
  fire(viewport, 'keydown', { key: 'Enter' });
  fire(viewport, 'keydown', { key: 'ArrowDown', shiftKey: true });
  fire(viewport, 'keydown', { key: 'Enter' });
  assert.match(control(host, 'Measurements').textContent, /1 measurement · 2.0 mm/);
  cleanup();

  cleanup = await mountSlice(host, { ...opts, series: { ...series, id: 'another-series' } });
  await settle();
  assert.equal(control(host, 'Measurements').textContent, '');
  cleanup();

  cleanup = await mountSlice(host, opts);
  await settle();
  assert.match(control(host, 'Measurements').textContent, /1 measurement · 2.0 mm/);
  cleanup();
});

test('the first measurement point is visible and PNG only includes completed measurements', async () => {
  const { host, doc, paint } = viewer();
  const cleanup = await mountSlice(host, { series, loadFrame: async () => pixels(32, 24) });
  await settle();
  fire(control(host, 'Distance'), 'click');
  const viewport = control(host, 'Image viewport');
  fire(viewport, 'keydown', { key: 'Enter' });
  paint();
  const [canvas] = viewport.children;
  assert.ok(canvas.drawCalls.some(([type]) => type === 'handle'));
  fire(control(host, 'Export PNG'), 'click');
  assert.equal(doc.exported.drawCalls.some(([type]) => type === 'text'), false);

  for (let i = 0; i < 4; i++) fire(viewport, 'keydown', { key: 'ArrowDown', shiftKey: true });
  fire(viewport, 'keydown', { key: 'Enter' });
  fire(control(host, 'Export PNG'), 'click');
  assert.ok(doc.exported.drawCalls.some(([type]) => type === 'image'));
  assert.ok(doc.exported.drawCalls.some(([type, text]) => type === 'text' && text === '8.0 mm'));
  assert.deepEqual(doc.downloads, ['dicom-frame-1.png', 'dicom-frame-1.png']);
  cleanup();
});

test('a point note rejects blanks, saves literal short text, and can be edited and deleted after remount', async () => {
  const { host, doc } = viewer();
  const printed = [];
  let printCanvas;
  doc.defaultView.open = () => ({
    document: { body: { append: canvas => { printCanvas = canvas; } } },
    focus() {},
    print() { printed.push(printCanvas); },
  });
  const annotationStore = new Map();
  const options = { series, annotationStore, loadFrame: async () => pixels(10, 10) };
  let cleanup = await mountSlice(host, options);
  await settle();
  function tap(x, y) {
    const [canvas] = control(host, 'Image viewport').children;
    for (const type of ['pointerdown', 'pointerup']) {
      fire(canvas, type, { clientX: x, clientY: y, button: 0, pointerType: 'mouse', pointerId: 1 });
    }
  }
  fire(control(host, 'Note'), 'click');
  tap(160, 120);
  let input = control(host, 'Note text');
  input.value = '   \n';
  fire(control(host, 'Save note'), 'click');
  assert.equal(control(host, 'Note feedback').textContent, 'Enter a note.');
  assert.deepEqual(annotationStore.get(series.id).get('a'), []);
  input.value = '  <scan>  ' + '🔎'.repeat(90);
  fire(control(host, 'Save note'), 'click');
  const [note] = annotationStore.get(series.id).get('a');
  assert.deepEqual(note.points, [{ x: 4.5, y: 4.5 }]);
  assert.equal(note.text, '<scan> ' + '🔎'.repeat(57));
  assert.match(control(host, 'Annotations').textContent, /<scan>/);
  fire(control(host, 'Export PNG'), 'click');
  assert.ok(doc.exported.drawCalls.some(([type, text]) => type === 'text' && text === note.text));
  fire(control(host, 'Print image'), 'click');
  assert.ok(printed[0].drawCalls.some(([type, text]) => type === 'text' && text === note.text));
  cleanup();

  cleanup = await mountSlice(host, options);
  await settle();
  fire(control(host, 'Edit'), 'click');
  tap(160, 120);
  input = control(host, 'Note text');
  assert.equal(input.value, note.text);
  input.value = 'Revised';
  fire(control(host, 'Save note'), 'click');
  assert.match(control(host, 'Annotations').textContent, /Revised/);
  const [canvas] = control(host, 'Image viewport').children;
  for (const [type, clientX, clientY] of [['pointerdown', 160, 120], ['pointermove', 184, 144], ['pointerup', 184, 144]]) {
    fire(canvas, type, { clientX, clientY, button: 0, pointerType: 'mouse', pointerId: 1 });
  }
  assert.deepEqual(note.points, [{ x: 6.5, y: 5.5 }]);
  fire(control(host, 'Delete selected annotation'), 'click');
  assert.deepEqual(annotationStore.get(series.id).get('a'), []);
  cleanup();
});

test('Inspect reads the original CT sample under rotation and clears it on a frame switch', async () => {
  const { host } = viewer();
  const cleanup = await mountSlice(host, {
    series,
    loadFrame: async () => {
      const image = pixels(4, 4);
      image.pixels[5] = -11.25;
      return image;
    },
  });
  await settle();
  fire(control(host, 'Rotate clockwise'), 'click');
  fire(control(host, 'Inspect pixel'), 'click');
  const [canvas] = control(host, 'Image viewport').children;
  for (const type of ['pointerdown', 'pointerup']) {
    fire(canvas, type, { clientX: 200, clientY: 100, button: 0, pointerType: 'touch', pointerId: 1 });
  }
  const info = control(host, 'Pixel value');
  assert.equal(info.textContent, 'Column 2, row 2 · Intensity −11.25');
  fire(control(host, 'Next frame'), 'click');
  assert.equal(info.textContent, '');
  cleanup();

  const cleanMR = await mountSlice(host, { series: { ...series, modality: 'MR' }, loadFrame: async () => pixels() });
  assert.equal(control(host, 'Inspect pixel'), undefined);
  cleanMR();
});
