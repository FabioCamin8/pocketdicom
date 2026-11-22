import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeNote } from '../web/slice-note.js';
import { createExportCanvas, drawFrame } from '../web/slice-render.js';

function makeCanvas() {
  const calls = [];
  const context = {
    save() {}, restore() {}, setTransform() {}, fillRect() {}, setLineDash() {},
    beginPath() {}, arc(...args) { calls.push(['arc', ...args]); }, fill() {}, stroke() {},
    measureText(text) { return { width: Array.from(text).length * 6 }; },
    fillText(...args) { calls.push(['fillText', ...args]); },
    strokeText(...args) { calls.push(['strokeText', ...args]); },
    translate() {}, rotate(...args) { calls.push(['rotate', ...args]); }, drawImage() {},
  };
  return { width: 0, height: 0, calls, getContext: () => context };
}

const doc = { createElement: () => makeCanvas() };

test('normalizeNote returns an empty string for non-string and blank values', () => {
  assert.equal(normalizeNote(null), '');
  assert.equal(normalizeNote(42), '');
  assert.equal(normalizeNote(' \n\t '), '');
});

test('normalizeNote collapses whitespace and control characters to one line', () => {
  assert.equal(normalizeNote('  left\r\n\tmiddle\u0000right  '), 'left middle right');
});

test('normalizeNote caps text at 64 Unicode code points without splitting a surrogate pair', () => {
  const expected = `${'a'.repeat(63)}🙂`;
  const normalized = normalizeNote(`${expected}z`);
  assert.equal(normalized, expected);
  assert.equal(Array.from(normalized).length, 64);
});

test('drawFrame projects a note marker and renders literal markup as unrotated canvas text', () => {
  const canvas = makeCanvas();
  const text = '<b>note</b>\n next';
  drawFrame(canvas, { width: 200, height: 100 }, null, {
    project: ({ x, y }) => ({ x: x * 2 + 10, y: y * 3 + 20 }),
  }, [{ kind: 'note', points: [{ x: 3, y: 4 }], text }]);

  assert.deepEqual(canvas.calls.find(([name]) => name === 'arc'), ['arc', 16, 32, 3, 0, Math.PI * 2]);
  assert.ok(canvas.calls.some(([name, value, x, y]) => name === 'fillText' && value === '<b>note</b> next' && x === 24 && y === 24));
  assert.equal(canvas.calls.filter(([name]) => name === 'rotate').length, 0);
});

test('drawFrame clamps a long note label to the viewport', () => {
  const canvas = makeCanvas();
  const text = 'n'.repeat(64);
  drawFrame(canvas, { width: 100, height: 80 }, null, {
    project: () => ({ x: 95, y: 40 }),
  }, [{ kind: 'note', points: [{ x: 0, y: 0 }], text }]);

  const label = canvas.calls.find(([name]) => name === 'fillText');
  assert.equal(label[1], text);
  assert.equal(label[2], 3);
  assert.ok(label[2] + label[4] <= 97);
});

test('createExportCanvas includes saved notes and omits draft notes', () => {
  const exported = createExportCanvas(doc, { columns: 200, rows: 100 }, null, 90, [
    { kind: 'note', points: [{ x: 50, y: 50 }], text: 'saved note' },
    { kind: 'note', points: [{ x: 50, y: 50 }], text: 'draft note', draft: true },
  ]);

  assert.deepEqual(exported.calls.filter(([name]) => name === 'fillText').map(([, text]) => text), ['saved note']);
  assert.equal(exported.calls.filter(([name]) => name === 'arc').length, 1);
});
