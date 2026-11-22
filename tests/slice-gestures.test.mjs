import test from 'node:test';
import assert from 'node:assert/strict';
import { bindGestures } from '../web/slice-gestures.js';

class InputEvent extends Event {
  constructor(type, fields = {}) {
    super(type, { bubbles: true, cancelable: true });
    Object.assign(this, fields);
  }
}

class Stage extends EventTarget {
  captured = new Set();

  getBoundingClientRect() {
    return { left: 10, top: 20, width: 400, height: 300 };
  }

  setPointerCapture(id) { this.captured.add(id); }
  releasePointerCapture(id) { this.captured.delete(id); }
  hasPointerCapture(id) { return this.captured.has(id); }
}

function harness(initialTool = 'edit', signal) {
  const stage = new Stage();
  let tool = initialTool;
  const calls = { start: [], move: [], end: [], cancel: 0, step: [], zoom: [], pan: [] };
  const cleanup = bindGestures(stage, {
    signal,
    getTool: () => tool,
    start: point => calls.start.push(point),
    move: (point, delta) => calls.move.push([point, delta]),
    end: (point, total) => calls.end.push([point, total]),
    cancel: () => calls.cancel++,
    step: delta => calls.step.push(delta),
    zoom: (factor, anchor) => calls.zoom.push([factor, anchor]),
    pan: (dx, dy) => calls.pan.push([dx, dy]),
  });
  return { stage, calls, cleanup, setTool: value => { tool = value; } };
}

function pointer(stage, type, id, x, y, pointerType = 'mouse') {
  stage.dispatchEvent(new InputEvent(type, {
    pointerId: id, pointerType, isPrimary: id === 1,
    button: 0, clientX: x, clientY: y,
  }));
}

function wheel(stage, fields = {}) {
  const event = new InputEvent('wheel', {
    deltaX: 0, deltaY: 0, deltaMode: 0, clientX: 80, clientY: 120,
    ctrlKey: false, metaKey: false, ...fields,
  });
  stage.dispatchEvent(event);
  return event;
}

test('single-pointer tools receive stage-local points, incremental moves, and total end deltas', () => {
  const { stage, calls } = harness('edit');
  pointer(stage, 'pointerdown', 1, 40, 60);
  pointer(stage, 'pointermove', 1, 55, 66);
  pointer(stage, 'pointermove', 1, 51, 70);
  pointer(stage, 'pointerup', 1, 52, 72);

  assert.deepEqual(calls.start, [{ x: 30, y: 40 }]);
  assert.deepEqual(calls.move, [
    [{ x: 45, y: 46 }, { x: 15, y: 6 }],
    [{ x: 41, y: 50 }, { x: -4, y: 4 }],
  ]);
  assert.deepEqual(calls.end, [[{ x: 42, y: 52 }, { x: 12, y: 12 }]]);
  assert.equal(calls.cancel, 0);
  assert.equal(stage.captured.size, 0);
});

test('stack touch swipes step in either axis after a threshold, without annotation callbacks', () => {
  const { stage, calls } = harness('stack');
  pointer(stage, 'pointerdown', 1, 150, 100, 'touch');
  pointer(stage, 'pointerup', 1, 150, 145, 'touch');
  pointer(stage, 'pointerdown', 2, 120, 100, 'touch');
  pointer(stage, 'pointerup', 2, 70, 100, 'touch');
  pointer(stage, 'pointerdown', 3, 100, 100, 'touch');
  pointer(stage, 'pointerup', 3, 100, 125, 'touch');

  assert.deepEqual(calls.step, [-1, 1]);
  assert.deepEqual(calls.start, []);
  assert.deepEqual(calls.move, []);
  assert.deepEqual(calls.end, []);
  assert.equal(calls.cancel, 0);
});

test('wheel steps stacks and zooms with a positive factor anchored in stage coordinates', () => {
  const { stage, calls, setTool } = harness('stack');
  const stackWheel = wheel(stage, { deltaY: 120 });
  assert.deepEqual(calls.step, [1]);
  assert.equal(stackWheel.defaultPrevented, true);

  wheel(stage, { deltaY: -80, ctrlKey: true });
  setTool('zoom');
  wheel(stage, { deltaY: 40 });
  assert.equal(calls.zoom.length, 2);
  assert.ok(calls.zoom.every(([factor]) => Number.isFinite(factor) && factor > 0));
  assert.deepEqual(calls.zoom.map(([, anchor]) => anchor), [
    { x: 70, y: 100 }, { x: 70, y: 100 },
  ]);
  assert.deepEqual(calls.step, [1]);
});

test('two-touch pinch zooms and pans, cancels a single drag, and cannot end it on lift', () => {
  const { stage, calls } = harness('distance');
  pointer(stage, 'pointerdown', 1, 50, 70, 'touch');
  pointer(stage, 'pointermove', 1, 55, 75, 'touch');
  pointer(stage, 'pointerdown', 2, 90, 70, 'touch');
  pointer(stage, 'pointermove', 1, 45, 80, 'touch');
  pointer(stage, 'pointermove', 2, 105, 80, 'touch');
  pointer(stage, 'pointerup', 2, 105, 80, 'touch');
  pointer(stage, 'pointerup', 1, 45, 80, 'touch');

  assert.equal(calls.start.length, 1);
  assert.equal(calls.cancel, 1);
  assert.deepEqual(calls.end, []);
  assert.equal(calls.zoom.length, 2);
  assert.ok(calls.zoom.every(([factor, anchor]) => factor > 0 && anchor.x >= 0 && anchor.y >= 0));
  assert.deepEqual(calls.zoom.map(([, anchor]) => anchor), [{ x: 62.5, y: 52.5 }, { x: 57.5, y: 55 }]);
  assert.deepEqual(calls.pan, [[-5, 2.5], [7.5, 5]]);

  const ghostClick = new InputEvent('click');
  stage.dispatchEvent(ghostClick);
  assert.equal(ghostClick.defaultPrevented, true);
});

test('pointercancel and lost capture cancel a single gesture once and never end it', () => {
  const { stage, calls } = harness('angle');
  pointer(stage, 'pointerdown', 1, 40, 60);
  stage.dispatchEvent(new InputEvent('pointercancel', { pointerId: 1 }));
  stage.dispatchEvent(new InputEvent('lostpointercapture', { pointerId: 1 }));
  assert.equal(calls.cancel, 1);
  assert.deepEqual(calls.end, []);
  assert.equal(stage.captured.size, 0);

  pointer(stage, 'pointerdown', 2, 40, 60);
  stage.dispatchEvent(new InputEvent('lostpointercapture', { pointerId: 2 }));
  pointer(stage, 'pointerup', 2, 40, 60);
  assert.equal(calls.cancel, 2);
  assert.deepEqual(calls.end, []);
});

test('canceling one pointer during a pinch suppresses the remaining finger until it lifts', () => {
  const { stage, calls } = harness('edit');
  pointer(stage, 'pointerdown', 1, 40, 60, 'touch');
  pointer(stage, 'pointerdown', 2, 80, 60, 'touch');
  stage.dispatchEvent(new InputEvent('pointercancel', { pointerId: 2 }));
  pointer(stage, 'pointerup', 1, 40, 60, 'touch');

  assert.equal(calls.cancel, 1);
  assert.deepEqual(calls.end, []);
  assert.equal(stage.captured.size, 0);
});

test('cleanup cancels an active drag and removes listeners and pointer capture', () => {
  const { stage, calls, cleanup } = harness('pan');
  pointer(stage, 'pointerdown', 1, 40, 60);
  cleanup();
  pointer(stage, 'pointermove', 1, 80, 90);
  pointer(stage, 'pointerup', 1, 80, 90);

  assert.equal(calls.cancel, 1);
  assert.deepEqual(calls.move, []);
  assert.deepEqual(calls.end, []);
  assert.equal(stage.captured.size, 0);
  cleanup();
  assert.equal(calls.cancel, 1);
});

test('an already-aborted signal installs no active gesture listeners', () => {
  const controller = new AbortController();
  controller.abort();
  const { stage, calls } = harness('edit', controller.signal);
  pointer(stage, 'pointerdown', 1, 40, 60);
  pointer(stage, 'pointerup', 1, 40, 60);
  assert.deepEqual(calls.start, []);
  assert.deepEqual(calls.end, []);
});

test('aborting the signal cancels an active drag and releases its pointer', () => {
  const controller = new AbortController();
  const { stage, calls } = harness('window', controller.signal);
  pointer(stage, 'pointerdown', 1, 40, 60);
  controller.abort();
  pointer(stage, 'pointermove', 1, 80, 90);
  pointer(stage, 'pointerup', 1, 80, 90);

  assert.equal(calls.cancel, 1);
  assert.deepEqual(calls.move, []);
  assert.deepEqual(calls.end, []);
  assert.equal(stage.captured.size, 0);
});
