const GRIP_CLASS = 'viewport-resize-grip';
const MIN_WIDTH = 180;
const MIN_HEIGHT = 140;
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const pixels = value => `${Math.round(value)}px`;

function resizeTargets(stage) {
  if (stage.classList.contains('slice-stage')) {
    const host = stage.closest('.view-host') || stage;
    return {width: host, height: host};
  }
  if (stage.classList.contains('blend-stage')) {
    return {width: stage.closest('.view-host') || stage, height: stage};
  }
  if (stage.classList.contains('pdv-stage')) {
    const panel = stage.closest('.pdv-panel');
    return panel ? {width: panel, height: stage} : {width: stage.closest('.pdv-rotate') || stage, height: stage};
  }
  return {width: stage, height: stage};
}

function resizeName(stage) {
  if (stage.classList.contains('blend-stage')) return 'blend';
  if (stage.closest('.pdv-rotate')) return '3D maximum intensity projection';
  const plane = stage.closest('.pdv-panel');
  if (plane) return `${plane.querySelector('h3')?.textContent || 'section'} section`;
  const pane = stage.closest('.compare-pane');
  if (pane) return `comparison ${[...pane.parentElement.querySelectorAll('.compare-pane')].indexOf(pane) + 1}`;
  return '2D';
}

function findAncestor(node, selector) {
  for (let element = node; element;) {
    if (element.matches?.(selector)) return element;
    const root = element.getRootNode?.();
    if (root?.host) {
      element = root.host;
      continue;
    }
    element = element.parentElement;
  }
  return null;
}

function availableWidth(stage, view) {
  const area = findAncestor(stage, '#view-area') || findAncestor(stage, '.workspace');
  const workspace = area?.getBoundingClientRect().width || 0;
  const viewport = view.visualViewport?.width || view.innerWidth || 0;
  const widest = workspace > 0 ? Math.min(workspace, viewport || workspace) : viewport;
  return Math.max(0, widest - 12);
}

// Add one diagonal resize grip directly to a freshly constructed stage. Views call this
// as they build their stages, so a rebuilt shadow tree receives new grips without a scan.
export function installResizeGrip(stage) {
  if (!stage || typeof stage.querySelector !== 'function' || typeof stage.closest !== 'function'
    || typeof stage.classList?.contains !== 'function') return;
  if (stage.querySelector(`:scope > .${GRIP_CLASS}`)) return;
  const view = stage.ownerDocument?.defaultView;
  if (!view) return;

  const {width: widthTarget, height: heightTarget} = resizeTargets(stage);
  const wrapper = widthTarget.closest('.compare-pane') || widthTarget.closest('.pdv-panel');
  const grip = stage.ownerDocument.createElement('button');
  grip.type = 'button';
  grip.className = GRIP_CLASS;
  grip.textContent = '⤡';
  grip.setAttribute('aria-label', `Resize image viewport: ${resizeName(stage)}`);
  grip.setAttribute('aria-keyshortcuts', 'ArrowLeft ArrowRight ArrowUp ArrowDown');
  grip.title = 'Drag the diagonal grip to resize width and height. Arrow keys also resize.';
  stage.dataset.resizeStage = '';
  stage.append(grip);

  const read = () => ({
    w: widthTarget.getBoundingClientRect().width,
    h: heightTarget.getBoundingClientRect().height,
  });
  const wrapperChrome = wrapper && wrapper !== widthTarget
    ? wrapper.offsetWidth - wrapper.clientWidth
      + parseFloat(view.getComputedStyle(wrapper).paddingLeft)
      + parseFloat(view.getComputedStyle(wrapper).paddingRight)
    : 0;

  function limits(baseW, baseH) {
    const viewportHeight = view.visualViewport?.height || view.innerHeight;
    const narrow = Boolean(view.matchMedia?.('(max-width: 850px)').matches);
    const available = Math.max(0, availableWidth(stage, view) - wrapperChrome);
    return {
      minW: Math.min(baseW, MIN_WIDTH),
      minH: Math.min(baseH, MIN_HEIGHT),
      maxW: Math.max(baseW, available),
      maxH: Math.max(baseH, narrow ? viewportHeight * 0.95 : viewportHeight * 2.5),
    };
  }

  function apply(width, height, baseW, baseH) {
    const limit = limits(baseW, baseH);
    const w = clamp(width, limit.minW, limit.maxW);
    const h = clamp(height, limit.minH, limit.maxH);
    widthTarget.style.width = pixels(w);
    widthTarget.style.maxWidth = '100%';
    heightTarget.style.height = pixels(h);
    if (stage.classList.contains('pdv-stage')) stage.style.setProperty('--pdv-height', pixels(h));
    if (wrapper) wrapper.style.flex = '0 0 auto';
    if (wrapper && wrapper !== widthTarget) {
      wrapper.style.inlineSize = pixels(w + wrapperChrome);
      wrapper.style.maxWidth = '100%';
    }
  }

  let drag;
  grip.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const {w, h} = read();
    drag = {id: event.pointerId, x: event.clientX, y: event.clientY, w, h};
    grip.dataset.resizing = 'true';
    try { grip.setPointerCapture(event.pointerId); } catch { /* Synthetic pointers may not be active. */ }
  });
  grip.addEventListener('pointermove', event => {
    if (!drag || drag.id !== event.pointerId) return;
    event.preventDefault();
    apply(drag.w + event.clientX - drag.x, drag.h + event.clientY - drag.y, drag.w, drag.h);
  });
  const end = event => {
    if (!drag || drag.id !== event.pointerId) return;
    drag = null;
    delete grip.dataset.resizing;
    if (grip.hasPointerCapture?.(event.pointerId)) grip.releasePointerCapture(event.pointerId);
  };
  grip.addEventListener('pointerup', end);
  grip.addEventListener('pointercancel', end);
  grip.addEventListener('lostpointercapture', end);
  grip.addEventListener('keydown', event => {
    const step = event.shiftKey ? 64 : 24;
    const delta = {ArrowRight: [step, 0], ArrowLeft: [-step, 0], ArrowDown: [0, step], ArrowUp: [0, -step]}[event.key];
    if (!delta) return;
    event.preventDefault();
    event.stopPropagation();
    const {w, h} = read();
    apply(w + delta[0], h + delta[1], w, h);
  });
}
