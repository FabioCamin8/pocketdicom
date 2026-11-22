export function bindGestures(stage, {
  signal, getTool, start, move, end, cancel, step, zoom, pan,
}) {
  const active = new Map();
  const captured = new Set();
  let gesture = null;
  let ghostClickUntil = 0;
  let cleaned = false;

  const localPoint = event => {
    const rect = stage.getBoundingClientRect?.() ?? { left: 0, top: 0 };
    const x = Number(event.clientX), y = Number(event.clientY);
    return {
      x: (Number.isFinite(x) ? x : 0) - (rect.left || 0),
      y: (Number.isFinite(y) ? y : 0) - (rect.top || 0),
    };
  };
  const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const center = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  const suppressGhostClick = () => { ghostClickUntil = Date.now() + 700; };

  function capture(id) {
    if (typeof stage.setPointerCapture !== 'function') return;
    try {
      stage.setPointerCapture(id);
      captured.add(id);
    } catch { /* The pointer may no longer be active. */ }
  }

  function release(id) {
    if (!captured.delete(id)) return;
    try { stage.releasePointerCapture?.(id); } catch { /* Capture can be lost before release. */ }
  }

  function removePointer(id, releaseCapture = true) {
    active.delete(id);
    if (releaseCapture) release(id);
    else captured.delete(id);
  }

  function finishSuppressed() {
    if (active.size === 0) gesture = null;
  }

  function onPointerDown(event) {
    if (cleaned || (event.pointerType === 'mouse' && event.button !== 0)) return;
    const id = event.pointerId;
    if (active.has(id) || gesture?.kind === 'pinch' || gesture?.kind === 'suppressed') return;

    const point = localPoint(event);
    const pointerType = event.pointerType || 'mouse';
    if (!gesture) {
      active.set(id, { point, pointerType });
      capture(id);
      const tool = getTool();
      gesture = { kind: 'single', id, pointerType, tool, start: point, last: point };
      if (tool !== 'stack') start?.(point);
      return;
    }

    if (gesture.kind !== 'single' || gesture.pointerType !== 'touch' || pointerType !== 'touch') return;
    active.set(id, { point, pointerType });
    capture(id);
    if (gesture.tool !== 'stack') cancel?.();
    const first = active.get(gesture.id)?.point;
    if (!first) {
      gesture = { kind: 'suppressed' };
      return;
    }
    gesture = {
      kind: 'pinch',
      ids: [gesture.id, id],
      center: center(first, point),
      distance: distance(first, point),
    };
  }

  function onPointerMove(event) {
    if (cleaned) return;
    const id = event.pointerId;
    const tracked = active.get(id);
    if (!tracked) return;
    const point = localPoint(event);
    tracked.point = point;

    if (gesture?.kind === 'single' && gesture.id === id) {
      if (gesture.tool !== 'stack') {
        move?.(point, { x: point.x - gesture.last.x, y: point.y - gesture.last.y });
      }
      gesture.last = point;
      return;
    }

    if (gesture?.kind !== 'pinch' || !gesture.ids.includes(id)) return;
    const a = active.get(gesture.ids[0])?.point;
    const b = active.get(gesture.ids[1])?.point;
    if (!a || !b) return;
    const nextCenter = center(a, b);
    const nextDistance = distance(a, b);
    if (gesture.distance > 0 && nextDistance > 0) {
      const factor = nextDistance / gesture.distance;
      if (Number.isFinite(factor) && Math.abs(factor - 1) > 1e-6) zoom?.(factor, gesture.center);
    }
    const dx = nextCenter.x - gesture.center.x;
    const dy = nextCenter.y - gesture.center.y;
    if (dx || dy) pan?.(dx, dy);
    gesture.center = nextCenter;
    gesture.distance = nextDistance;
  }

  function onPointerUp(event) {
    const id = event.pointerId;
    const tracked = active.get(id);
    if (!tracked) return;
    const point = localPoint(event);

    if (gesture?.kind === 'single' && gesture.id === id) {
      const dx = point.x - gesture.start.x;
      const dy = point.y - gesture.start.y;
      if (gesture.tool === 'stack' && gesture.pointerType === 'touch') {
        const axis = Math.abs(dx) > Math.abs(dy) ? dx : dy;
        const steps = Math.floor(Math.abs(axis) / 40);
        if (steps > 0) {
          step?.(-Math.sign(axis) * steps);
          suppressGhostClick();
        }
      } else if (gesture.tool !== 'stack') {
        end?.(point, { x: dx, y: dy });
        if (gesture.pointerType === 'touch' && distance(point, gesture.start) >= 5) suppressGhostClick();
      }
      gesture = null;
      removePointer(id);
      return;
    }

    if (gesture?.kind === 'pinch' && gesture.ids.includes(id)) {
      suppressGhostClick();
      gesture = { kind: 'suppressed' };
      removePointer(id);
      finishSuppressed();
      return;
    }

    if (gesture?.kind === 'suppressed') {
      removePointer(id);
      finishSuppressed();
    }
  }

  function abortPointer(event, lostCapture = false) {
    const id = event.pointerId;
    const tracked = active.get(id);
    if (!tracked) return;

    if (gesture?.kind === 'single' && gesture.id === id) {
      if (gesture.tool !== 'stack') cancel?.();
      if (gesture.pointerType === 'touch') suppressGhostClick();
      gesture = null;
      removePointer(id, !lostCapture);
      return;
    }

    if (gesture?.kind === 'pinch' && gesture.ids.includes(id)) {
      suppressGhostClick();
      gesture = { kind: 'suppressed' };
      removePointer(id, !lostCapture);
      finishSuppressed();
      return;
    }

    if (gesture?.kind === 'suppressed') {
      removePointer(id, !lostCapture);
      finishSuppressed();
    }
  }

  function wheelPixels(event) {
    const dx = Number.isFinite(event.deltaX) ? event.deltaX : 0;
    const dy = Number.isFinite(event.deltaY) ? event.deltaY : 0;
    const vertical = Math.abs(dy) >= Math.abs(dx);
    const axis = vertical ? dy : dx;
    const mode = event.deltaMode || 0;
    const rect = stage.getBoundingClientRect?.() ?? {};
    const scale = mode === 1 ? 16
      : mode === 2 ? (vertical ? rect.height : rect.width) || 800
        : 1;
    return axis * scale;
  }

  function onWheel(event) {
    if (cleaned) return;
    const delta = wheelPixels(event);
    if (!delta) return;
    const tool = getTool();
    if (event.ctrlKey || event.metaKey || tool === 'zoom') {
      const boundedDelta = Math.max(-10000, Math.min(10000, delta));
      zoom?.(Math.exp(-boundedDelta * 0.002), localPoint(event));
      event.preventDefault();
    } else if (tool === 'stack') {
      step?.(Math.sign(delta));
      event.preventDefault();
    }
  }

  function onClick(event) {
    if (Date.now() > ghostClickUntil) return;
    ghostClickUntil = 0;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation?.();
  }

  if (signal?.aborted) return () => {};
  const listeners = [
    ['pointerdown', onPointerDown],
    ['pointermove', onPointerMove],
    ['pointerup', onPointerUp],
    ['pointercancel', abortPointer],
    ['lostpointercapture', event => abortPointer(event, true)],
    ['wheel', onWheel, { passive: false }],
    ['click', onClick, true],
  ];
  for (const [type, handler, options] of listeners) stage.addEventListener(type, handler, options);

  function cleanup() {
    if (cleaned) return;
    cleaned = true;
    if (gesture?.kind === 'single' && gesture.tool !== 'stack') cancel?.();
    for (const [type, handler, options] of listeners) stage.removeEventListener(type, handler, options);
    signal?.removeEventListener('abort', cleanup);
    for (const id of captured) release(id);
    captured.clear();
    active.clear();
    gesture = null;
  }

  signal?.addEventListener('abort', cleanup, { once: true });
  if (signal?.aborted) cleanup();
  return cleanup;
}
