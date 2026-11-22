import { createExportCanvas, createRaster, drawFrame, makeTransform, measureAnnotation } from './slice-render.js';
import { bindGestures } from './slice-gestures.js';
import { drawSourceOverlays } from './slice-overlay.js';
import { normalizeNote } from './slice-note.js';
import { installResizeGrip } from './view-resize.js';

const TOOLS = {
  stack: ['Stack', 'Scroll or swipe to move through frames. Use arrow keys when the image has focus.'],
  window: ['W/L', 'Drag left or right to adjust width. Drag up or down to adjust center.'],
  pan: ['Pan', 'Drag to move the image.'],
  zoom: ['Zoom', 'Drag vertically or use the wheel to zoom. Pinch on a touch screen.'],
  distance: ['Distance', 'Drag a line or place two points. Use Shift + arrow keys and Enter to place a point.'],
  angle: ['Angle', 'Place three points. The second point is the vertex. Use Shift + arrow keys and Enter to place a point.'],
  note: ['Note', 'Select a point, then enter a short note. Use Shift + arrow keys and Enter to place a point.'],
  edit: ['Edit', 'Drag an annotation point to move it. Select a note point to edit its text.'],
  inspect: ['Inspect', 'Select a pixel to read its original CT intensity.'],
};
const CT_WINDOWS = {
  soft: ['Soft tissue', 40, 400], lung: ['Lung', -600, 1500],
  bone: ['Bone', 300, 1500], brain: ['Brain', 40, 80],
};
const clamp = (x, min, max) => Math.min(max, Math.max(min, x));
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const rounded = value => String(Number(value.toFixed(2)));

export async function mountSlice(host, { series, loadFrame, loadTags, loadOverlays, signal, initialIndex = 0, annotationStore }) {
  if (signal?.aborted) return () => {};
  const doc = host.ownerDocument;
  const view = doc.defaultView;
  const lifetime = new AbortController();
  const on = (target, type, listener) => target.addEventListener(type, listener, { signal: lifetime.signal });
  const frames = series.frames;
  const isCT = series.modality?.toUpperCase() === 'CT';
  const annotations = annotationStore?.get(series.id) ?? new Map();
  if (annotationStore && !annotationStore.has(series.id)) annotationStore.set(series.id, annotations);
  let index = -1, request, pending = false, disposed = false, timer, paintId;
  let frame, raster, tags, overlays = [], showOverlays = true;
  let tool = 'stack', playing = false, fps = 6;
  let transform = { zoom: 1, panX: 0, panY: 0, rotation: 0 };
  let preset = 'default', customWindow, flip = false;
  let marks = [], selected, draft, gesture, cursor, noteEditor, probe;

  function make(tag, className = '', text) {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function labelled(node, label) { node.setAttribute('aria-label', label); return node; }
  function group(label, className = 'slice-group') {
    const node = labelled(make('div', className), label);
    node.setAttribute('role', 'group');
    return node;
  }
  function button(label, fn, name = label) {
    const node = labelled(make('button', 'slice-button', label), name);
    node.type = 'button';
    node.title = name;
    on(node, 'click', fn);
    return node;
  }
  function addOption(select, value, text) {
    const option = make('option', '', text);
    option.value = value;
    select.append(option);
  }
  function field(text, control) {
    const label = make('label', 'slice-field');
    label.append(make('span', '', text), control);
    return label;
  }

  const root = labelled(make('section', 'slice-viewer'), '2D image viewer');
  const toolbar = make('div', 'slice-toolbar');
  const tools = group('Viewport tools');
  const toolButtons = Object.fromEntries(Object.entries(TOOLS).filter(([id]) => id !== 'inspect' || isCT).map(([id, [label, hint]]) => {
    const control = button(label, () => chooseTool(id), { window: 'Window / level tool', inspect: 'Inspect pixel' }[id] ?? label);
    control.title = hint;
    tools.append(control);
    return [id, control];
  }));
  const viewButtons = group('Image transform');
  const zoomIn = button('+', () => zoomAt(1.25), 'Zoom in');
  const zoomOut = button('−', () => zoomAt(1 / 1.25), 'Zoom out');
  const rotate = button('Rotate', () => {
    transform.rotation = (transform.rotation + 90) % 360;
    draw();
  }, 'Rotate clockwise');
  const reset = button('Reset', resetView, 'Reset view');
  viewButtons.append(zoomOut, zoomIn, rotate, reset);
  const measurementButtons = group('Manage annotations');
  const deleteMark = button('Delete', deleteSelected, 'Delete selected annotation');
  const clearMarks = button('Clear', () => {
    marks.length = 0;
    selected = null;
    cancelGesture(false);
    draw();
  }, 'Clear measurements');
  measurementButtons.append(deleteMark, clearMarks);
  toolbar.append(tools, viewButtons, measurementButtons);

  const settings = make('div', 'slice-toolbar slice-settings');
  const windowGroup = group('Display');
  const windowSelect = labelled(make('select'), 'Window preset');
  addOption(windowSelect, 'default', 'Image default');
  if (isCT) {
    for (const [id, [label]] of Object.entries(CT_WINDOWS)) addOption(windowSelect, id, label);
  }
  addOption(windowSelect, 'custom', 'Custom');
  const centerInput = labelled(make('input'), 'Window center');
  const widthInput = labelled(make('input'), 'Window width');
  for (const input of [centerInput, widthInput]) {
    input.type = 'number';
    input.step = 'any';
    input.inputMode = 'decimal';
  }
  widthInput.min = '1';
  const invert = button('Invert', () => { flip = !flip; rebuildRaster(); });
  const sourceGraphics = button('Source overlays', () => { showOverlays = !showOverlays; rebuildRaster(); });
  windowGroup.append(field('Preset', windowSelect), field('C', centerInput), field('W', widthInput), invert);
  if (loadOverlays) windowGroup.append(sourceGraphics);
  const outputGroup = group('Output');
  const exportButton = button('PNG', exportImage, 'Export PNG');
  const printButton = button('Print', printImage, 'Print image');
  outputGroup.append(exportButton, printButton);
  settings.append(windowGroup, outputGroup);

  const stage = labelled(make('div', 'slice-stage'), 'Image viewport');
  stage.setAttribute('role', 'region');
  stage.tabIndex = 0;
  const canvas = make('canvas', 'slice-canvas');
  canvas.setAttribute('aria-hidden', 'true');
  const upper = make('div', 'slice-upper');
  const imageLabel = make('div', 'slice-series', [series.modality, series.label].filter(Boolean).join(' · ') || 'Image series');
  const imageInfo = labelled(make('div', 'slice-readout'), 'Image properties');
  const frameInfo = labelled(make('div', 'slice-readout'), 'Selected frame');
  upper.append(imageLabel, frameInfo, imageInfo);
  const lower = make('div', 'slice-lower');
  const viewInfo = labelled(make('div', 'slice-readout'), 'View properties');
  const measureInfo = labelled(make('div', 'slice-readout'), 'Measurements');
  const noteInfo = labelled(make('div', 'slice-readout'), 'Annotations');
  const pixelInfo = labelled(make('div', 'slice-readout'), 'Pixel value');
  const hint = make('div', 'slice-hint');
  lower.append(viewInfo, measureInfo, noteInfo, pixelInfo, hint);
  const statusBox = make('div', 'slice-message');
  const status = make('p', 'slice-status');
  status.setAttribute('role', 'status');
  const retry = button('Retry frame', () => selectFrame(index, { force: true }));
  retry.hidden = true;
  statusBox.append(status, retry);
  const noteForm = labelled(make('form', 'slice-note'), 'Text annotation');
  const noteInput = labelled(make('input'), 'Note text');
  noteInput.type = 'text';
  noteInput.maxLength = 128;
  noteInput.placeholder = 'Up to 64 characters';
  const noteFeedback = labelled(make('div', 'slice-note-feedback'), 'Note feedback');
  noteFeedback.setAttribute('role', 'status');
  const noteActions = make('div', 'slice-note-actions');
  const save = button('Save note', saveNote);
  noteActions.append(save, button('Cancel', closeNote, 'Cancel note'));
  noteForm.append(field('Note', noteInput), noteActions, noteFeedback);
  noteForm.hidden = true;
  stage.append(canvas, upper, lower, statusBox, noteForm);

  const timeline = group('Stack and cine', 'slice-timeline');
  const previous = button('‹', () => step(-1), 'Previous frame');
  const next = button('›', () => step(1), 'Next frame');
  const slider = labelled(make('input', 'slice-slider'), 'Frame');
  slider.type = 'range';
  slider.min = '1';
  slider.max = String(Math.max(1, frames.length));
  slider.step = '1';
  const counter = make('span', 'slice-counter');
  const cine = button('Play', toggleCine, 'Play cine');
  const speed = labelled(make('select'), 'Cine speed');
  for (const rate of [1, 3, 6, 12, 24]) addOption(speed, String(rate), `${rate} fps`);
  speed.value = String(fps);
  timeline.append(previous, slider, next, counter, cine, speed);
  root.append(toolbar, settings, stage, timeline);
  host.append(root);
  installResizeGrip(stage);

  function windowValues() {
    if (!frame) return null;
    const selectedPreset = CT_WINDOWS[preset];
    return {
      center: selectedPreset?.[1] ?? customWindow?.center ?? (Number.isFinite(frame.center) ? frame.center : 0),
      widthWindow: selectedPreset?.[2] ?? customWindow?.widthWindow ??
        (Number.isFinite(frame.widthWindow) ? Math.max(1, frame.widthWindow) : 1),
      invert: Boolean(frame.invert) !== flip,
    };
  }

  function controls() {
    const values = windowValues();
    const monochrome = frame?.type === 'f32';
    const info = frames[index];
    const spacing = frame?.spacing;
    const validSpacing = Array.isArray(spacing) && spacing.length === 2 && spacing.every(n => Number.isFinite(n) && n > 0);
    const photo = tags?.PhotometricInterpretation ?? tags?.['0028,0004'];
    const position = info?.position;
    const positionLabel = Number.isFinite(position) ? rounded(position) :
      Array.isArray(position) && position.length === 3 && position.every(Number.isFinite)
        ? position.map(rounded).join(', ') : '';
    imageInfo.textContent = !frame ? '' : [
      `${frame.width} × ${frame.height}`,
      validSpacing ? `${spacing.map(n => Number(n.toPrecision(4))).join(' × ')} mm / px` : 'No pixel spacing',
      typeof photo === 'string' ? photo : '',
    ].filter(Boolean).join(' · ');
    frameInfo.textContent = info ? [
      `Frame ${index + 1} of ${frames.length}`,
      info.instance !== undefined && info.instance !== null ? `Instance ${info.instance}` : '',
      positionLabel ? `Position ${positionLabel} mm` : '',
      info.label,
    ].filter(Boolean).join(' · ') : '';
    viewInfo.textContent = !values ? '' : [
      monochrome ? `W ${rounded(values.widthWindow)} / C ${rounded(values.center)}` : 'Color',
      `${Math.round(transform.zoom * 100)}%`, `${transform.rotation}°`, values.invert ? 'Inverted' : '',
    ].filter(Boolean).join(' · ');
    const measures = marks.filter(mark => mark.kind !== 'note');
    const notes = marks.filter(mark => mark.kind === 'note');
    const visibleMark = selected && selected.kind !== 'note' ? selected : measures.at(-1);
    const visibleNote = selected?.kind === 'note' ? selected : notes.at(-1);
    measureInfo.textContent = frame && visibleMark
      ? `${measures.length} measurement${measures.length === 1 ? '' : 's'} · ${measureAnnotation(visibleMark, spacing)}` : '';
    noteInfo.textContent = frame && visibleNote ? `${notes.length} note${notes.length === 1 ? '' : 's'} · ${visibleNote.text}` : '';
    pixelInfo.textContent = frame && probe ? `Column ${probe.x + 1}, row ${probe.y + 1} · ${Number.isFinite(probe.value)
      ? `Intensity ${rounded(probe.value).replace(/^-/, '−')}` : 'Intensity unavailable'}` : '';
    noteForm.hidden = !noteEditor;
    stage.dataset.tool = tool;
    hint.textContent = TOOLS[tool][1];
    for (const [id, control] of Object.entries(toolButtons)) {
      control.setAttribute('aria-pressed', String(id === tool));
      control.disabled = id === 'window' || id === 'inspect' ? !monochrome : id !== 'stack' && !frame;
    }
    for (const control of [zoomIn, zoomOut, rotate, reset, invert, exportButton, printButton]) control.disabled = !frame;
    windowSelect.disabled = centerInput.disabled = widthInput.disabled = !monochrome;
    windowSelect.value = preset;
    centerInput.value = monochrome ? rounded(values.center) : '';
    widthInput.value = monochrome ? rounded(values.widthWindow) : '';
    invert.setAttribute('aria-pressed', String(values?.invert ?? false));
    sourceGraphics.disabled = !frame || !overlays.length;
    sourceGraphics.setAttribute('aria-pressed', String(showOverlays));
    deleteMark.disabled = !frame || !selected;
    clearMarks.disabled = !frame || !marks.length;
    clearMarks.setAttribute('aria-label', notes.length ? 'Clear annotations' : 'Clear measurements');
    previous.disabled = index <= 0;
    next.disabled = index < 0 || index >= frames.length - 1;
    slider.disabled = cine.disabled = speed.disabled = frames.length < 2;
    slider.value = String(Math.max(1, index + 1));
    counter.textContent = `${Math.max(0, index + 1)} / ${frames.length}`;
    cine.textContent = playing ? 'Stop' : 'Play';
    cine.setAttribute('aria-label', `${playing ? 'Stop' : 'Play'} cine`);
    cine.setAttribute('aria-pressed', String(playing));
  }

  function statusText(text = '', canRetry = false) {
    status.textContent = text;
    statusBox.hidden = !text;
    retry.hidden = !canRetry;
  }

  function stageSize() {
    const { width, height } = stage.getBoundingClientRect();
    return { width, height, dpr: Math.min(view.devicePixelRatio || 1, 2) };
  }

  function displayedMarks() {
    const visible = marks.map(mark => mark === selected ? { ...mark, selected: true } : mark);
    if (gesture?.editing) {
      const { mark, points } = gesture.editing;
      visible[marks.indexOf(mark)] = { ...mark, points, selected: true };
    } else if (gesture?.kind === 'distance' && gesture.preview && !draft) {
      visible.push({ kind: 'distance', points: [gesture.source, gesture.preview], draft: true });
    } else if (draft) visible.push({ ...draft, draft: true });
    if (cursor) visible.push({ kind: tool, points: [cursor], draft: true });
    if (noteEditor && !noteEditor.mark) visible.push({ kind: 'note', points: [noteEditor.point], draft: true });
    if (probe) visible.push({ kind: 'inspect', points: [probe], draft: true });
    return visible;
  }

  function paint() {
    paintId = undefined;
    const size = stageSize();
    if (!size.width || !size.height) return;
    const projection = raster ? makeTransform(frame, size, transform) : null;
    drawFrame(canvas, size, raster, projection, displayedMarks(), frame?.spacing);
  }

  function draw() {
    if (disposed) return;
    controls();
    if (paintId === undefined) paintId = view.requestAnimationFrame(paint);
  }

  function rebuildRaster() {
    if (!frame) return;
    raster = createRaster(doc, frame, windowValues());
    if (showOverlays && overlays.length) drawSourceOverlays(raster, overlays);
    draw();
  }

  function selectFrame(target, { external = false, force = false } = {}) {
    if (disposed || !frames.length || !Number.isInteger(target)) return;
    target = clamp(target, 0, frames.length - 1);
    if (target === index && !force) return;
    const wasSelected = index >= 0;
    const changed = index !== target;
    const info = frames[target];
    const previousRequest = request;
    const active = request = new AbortController();
    previousRequest?.abort();
    const current = () => !disposed && request === active && !active.signal.aborted;
    clearTimer();
    index = target;
    frame = raster = tags = null;
    overlays = [];
    probe = null;
    selected = null;
    cancelGesture(false);
    if (!annotations.has(info.id)) annotations.set(info.id, []);
    marks = annotations.get(info.id);
    pending = true;
    statusText('Loading image…');
    draw();

    void (async () => {
      try {
        const loaded = await loadFrame(info.id, active.signal);
        if (!current()) return;
        if (!loaded || !Number.isSafeInteger(loaded.width) || loaded.width < 1 ||
            !Number.isSafeInteger(loaded.height) || loaded.height < 1 ||
            !['f32', 'rgb'].includes(loaded.type) ||
            loaded.pixels?.length !== loaded.width * loaded.height * (loaded.type === 'rgb' ? 3 : 1)) {
          throw new Error('Invalid image');
        }
        frame = loaded;
        if (frame.type !== 'f32' && ['window', 'inspect'].includes(tool)) tool = 'stack';
        rebuildRaster();
        pending = false;
        statusText();
        scheduleCine();
      } catch {
        if (!current()) return;
        frame = raster = null;
        pending = false;
        stopCine();
        statusText('Unable to load this image.', true);
      }
    })();
    async function readOptional(loader, apply) {
      if (!loader || !current()) return;
      try {
        const data = await loader(info.id, active.signal);
        if (current()) apply(data);
      } catch { /* Optional data must not prevent image display. */ }
    }
    void readOptional(loadTags, data => { tags = data; draw(); });
    void readOptional(loadOverlays, data => {
      overlays = Array.isArray(data) ? data : [];
      if (frame && showOverlays && overlays.length) rebuildRaster();
      else draw();
    });

    if (changed) {
      host.dispatchEvent(new view.CustomEvent('slice-framechange', {
        bubbles: true, detail: { seriesId: series.id, frameId: info.id, index },
      }));
      if (current() && wasSelected && !external) {
        host.dispatchEvent(new view.CustomEvent('slice-position', { detail: { index } }));
      }
    }
  }

  function clearTimer() {
    if (timer !== undefined) view.clearTimeout(timer);
    timer = undefined;
  }

  function stopCine() {
    playing = false;
    clearTimer();
    draw();
  }

  function scheduleCine() {
    clearTimer();
    if (!playing || pending || disposed) return;
    timer = view.setTimeout(() => selectFrame((index + 1) % frames.length), 1000 / fps);
  }

  function toggleCine() {
    if (playing) return stopCine();
    if (frames.length < 2) return;
    cancelGesture(false);
    selected = null;
    playing = true;
    if (!frame && !pending) selectFrame(index, { force: true });
    scheduleCine();
    draw();
  }

  function step(delta) {
    if (frames.length < 2) return;
    if (playing) stopCine();
    selectFrame(index + delta);
  }

  function chooseTool(nextTool) {
    cancelGesture(false);
    selected = null;
    cursor = null;
    tool = nextTool;
    draw();
  }

  function resetView() {
    transform = { zoom: 1, panX: 0, panY: 0, rotation: 0 };
    preset = 'default';
    customWindow = null;
    flip = false;
    cancelGesture(false);
    rebuildRaster();
  }

  function zoomAt(factor, point) {
    if (!frame || !Number.isFinite(factor) || factor <= 0) return;
    const { width, height } = stageSize();
    const nextZoom = clamp(transform.zoom * factor, 0.25, 16);
    const shift = 1 - nextZoom / transform.zoom;
    transform.panX += ((point?.x ?? width / 2) - width / 2 - transform.panX) * shift;
    transform.panY += ((point?.y ?? height / 2) - height / 2 - transform.panY) * shift;
    transform.zoom = nextZoom;
    draw();
  }

  function panBy(x, y) {
    if (!frame) return;
    transform.panX += x;
    transform.panY += y;
    draw();
  }

  function setWindow(center, widthWindow) {
    if (!Number.isFinite(center) || !Number.isFinite(widthWindow) || widthWindow < 1) return controls();
    preset = 'custom';
    customWindow = { center, widthWindow };
    rebuildRaster();
  }

  function choosePreset() {
    const nextPreset = windowSelect.value;
    customWindow = nextPreset === 'custom' ? windowValues() : null;
    preset = nextPreset;
    rebuildRaster();
  }

  function imagePoint(point, clip = false) {
    if (!frame) return null;
    const size = stageSize();
    if (!size.width || !size.height) return null;
    const { x, y } = makeTransform(frame, size, transform).unproject(point);
    if (clip) return { x: clamp(x, -0.5, frame.width - 0.5), y: clamp(y, -0.5, frame.height - 0.5) };
    return x >= -0.5 && x <= frame.width - 0.5 && y >= -0.5 && y <= frame.height - 0.5 ? { x, y } : null;
  }

  function validMark({ kind, points }) {
    if (kind === 'note') return points.length === 1 && !!points[0];
    return points.length === (kind === 'distance' ? 2 : 3) &&
      distance(points[0], points[1]) > 1e-4 && (kind === 'distance' || distance(points[1], points[2]) > 1e-4);
  }

  function place(point) {
    if (!point) return;
    if (tool === 'note') return openNote(point);
    if (tool === 'inspect') return inspectAt(point);
    if (!draft) draft = { kind: tool, points: [] };
    const last = draft.points.at(-1);
    if (last && distance(last, point) <= 1e-4) return;
    draft.points.push(point);
    if (validMark(draft)) {
      marks.push(draft);
      draft = null;
    }
    draw();
  }

  function inspectAt(point) {
    if (!isCT || frame?.type !== 'f32') return;
    const x = clamp(Math.round(point.x), 0, frame.width - 1);
    const y = clamp(Math.round(point.y), 0, frame.height - 1);
    probe = { x, y, value: frame.pixels[y * frame.width + x] };
    draw();
  }

  function openNote(point, mark = null) {
    noteEditor = { point, mark };
    noteInput.value = mark?.text ?? '';
    noteFeedback.textContent = '';
    draw();
    noteInput.focus();
  }

  function closeNote() {
    noteEditor = null;
    draw();
    stage.focus({ preventScroll: true });
  }

  function saveNote() {
    if (!noteEditor) return;
    const text = normalizeNote(noteInput.value);
    if (!text) {
      noteFeedback.textContent = 'Enter a note.';
      noteInput.focus();
      return;
    }
    if (noteEditor.mark) {
      noteEditor.mark.text = text;
      selected = noteEditor.mark;
    } else {
      selected = { kind: 'note', points: [noteEditor.point], text };
      marks.push(selected);
    }
    closeNote();
  }

  function deleteSelected() {
    if (selected) {
      marks.splice(marks.indexOf(selected), 1);
      selected = null;
      cancelGesture(false);
      draw();
    }
  }

  function beginGesture(point) {
    if (!frame) return;
    if (playing) stopCine();
    cursor = null;
    const source = imagePoint(point);
    gesture = { kind: tool, point, source };
    if (tool === 'window') gesture.window = windowValues();
    if (tool === 'edit') {
      const projection = makeTransform(frame, stageSize(), transform);
      let nearest = 16;
      selected = null;
      for (const mark of marks) mark.points.forEach((value, i) => {
        const dist = distance(point, projection.project(value));
        if (dist < nearest) {
          nearest = dist;
          selected = mark;
          gesture.editing = { mark, i, points: [...mark.points] };
        }
      });
      draw();
    }
  }

  function moveGesture(point, delta) {
    if (!gesture || !frame) return;
    switch (gesture.kind) {
      case 'window': {
        const values = gesture.window;
        const scale = values.widthWindow / 200;
        setWindow(values.center - (point.y - gesture.point.y) * scale,
          Math.max(1, values.widthWindow + (point.x - gesture.point.x) * scale));
        break;
      }
      case 'pan': panBy(delta.x, delta.y); break;
      case 'zoom': zoomAt(Math.exp(-delta.y / 150), gesture.point); break;
      case 'distance':
        if (!draft && gesture.source) {
          gesture.preview = imagePoint(point, true);
          draw();
        }
        break;
      case 'edit':
        if (gesture.editing) {
          gesture.editing.points[gesture.editing.i] = imagePoint(point, true) ?? gesture.editing.points[gesture.editing.i];
          draw();
        }
    }
  }

  function endGesture(point, delta) {
    if (!gesture) return;
    const op = gesture;
    gesture = null;
    const dragged = Math.hypot(delta.x, delta.y) >= 5;
    if (op.kind === 'distance' && !draft && op.source && dragged) {
      const end = imagePoint(point, true);
      const candidate = end && { kind: 'distance', points: [op.source, end] };
      if (candidate && validMark(candidate)) marks.push(candidate);
    } else if (['distance', 'angle', 'note', 'inspect'].includes(op.kind) && !dragged) {
      place(imagePoint(point));
    } else if (op.editing && dragged) {
      const { i, mark, points } = op.editing;
      points[i] = imagePoint(point, true) ?? mark.points[i];
      if (validMark({ ...mark, points })) mark.points = points;
    } else if (op.editing?.mark.kind === 'note') {
      openNote(op.editing.mark.points[0], op.editing.mark);
    }
    draw();
  }

  function cancelGesture(refresh = true) {
    draft = gesture = cursor = noteEditor = null;
    if (refresh) draw();
  }

  function keydown(event) {
    if (event.target !== stage) return;
    const { key } = event;
    const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    const measuring = frame && ['distance', 'angle', 'note', 'inspect'].includes(tool);
    if (event.shiftKey && measuring && (arrows[key] || key === 'Enter')) {
      const [x, y] = arrows[key] ?? [0, 0];
      cursor ??= { x: (frame.width - 1) / 2, y: (frame.height - 1) / 2 };
      cursor = { x: clamp(cursor.x + x, -0.5, frame.width - 0.5), y: clamp(cursor.y + y, -0.5, frame.height - 0.5) };
      if (key === 'Enter') place(cursor); else draw();
    } else if (key === 'Enter' && measuring) {
      place(cursor ?? { x: (frame.width - 1) / 2, y: (frame.height - 1) / 2 });
    } else if (key === 'ArrowRight' || key === 'ArrowDown' || key === 'PageDown') step(1);
    else if (key === 'ArrowLeft' || key === 'ArrowUp' || key === 'PageUp') step(-1);
    else if (key === 'Home' || key === 'End') {
      if (playing) stopCine();
      selectFrame(key === 'Home' ? 0 : frames.length - 1);
    } else if (key === ' ') toggleCine();
    else if (key === '+' || key === '=') zoomAt(1.25);
    else if (key === '-') zoomAt(1 / 1.25);
    else if (key === 'Escape') cancelGesture();
    else if (key === 'Delete') deleteSelected();
    else if (key === 'r' && frame && !event.ctrlKey && !event.metaKey) resetView();
    else return;
    event.preventDefault();
  }

  function exportCanvas() {
    return createExportCanvas(doc, frame, raster, transform.rotation, marks);
  }
  function exportImage() {
    if (!raster) return;
    try {
      const link = make('a');
      link.href = exportCanvas().toDataURL('image/png');
      if (link.href === 'data:,') throw new Error('Empty image');
      link.download = `dicom-frame-${index + 1}.png`;
      link.click();
    } catch { statusText('Unable to export this image.'); }
  }
  function printImage() {
    if (!raster) return;
    let preview;
    try {
      const image = exportCanvas();
      preview = view.open('', '_blank');
      if (!preview) throw new Error('Print window blocked');
      preview.opener = null;
      preview.document.title = `DICOM frame ${index + 1}`;
      image.style.maxWidth = '100%';
      image.style.maxHeight = '95vh';
      image.style.objectFit = 'contain';
      preview.document.body.append(image);
      preview.focus();
      preview.print();
    } catch {
      preview?.close();
      statusText('Unable to open print preview. Export the PNG instead.');
    }
  }

  on(windowSelect, 'change', choosePreset);
  for (const input of [centerInput, widthInput]) on(input, 'change', () => {
    if (!centerInput.value || !widthInput.value) return controls();
    setWindow(Number(centerInput.value), Number(widthInput.value));
  });
  on(slider, 'input', () => {
    const target = Number(slider.value) - 1;
    if (playing) stopCine();
    selectFrame(target);
  });
  on(speed, 'change', () => { fps = Number(speed.value); scheduleCine(); });
  on(noteForm, 'submit', event => { event.preventDefault(); saveNote(); });
  on(noteInput, 'keydown', event => {
    if (event.isComposing) return;
    if (event.key === 'Enter' || event.key === 'Escape') {
      event.preventDefault();
      if (event.key === 'Enter') saveNote(); else closeNote();
    }
  });
  on(host, 'slice-jump', event => {
    if (event.target !== host || !Number.isInteger(event.detail?.index)) return;
    if (playing) stopCine();
    selectFrame(event.detail.index, { external: true });
  });
  on(stage, 'keydown', keydown);
  on(canvas, 'pointerdown', () => stage.focus({ preventScroll: true }));
  const unbindGestures = bindGestures(canvas, {
    signal: lifetime.signal, getTool: () => tool,
    start: beginGesture, move: moveGesture, end: endGesture, cancel: () => cancelGesture(),
    step, zoom: zoomAt, pan: panBy,
  });
  const observer = view.ResizeObserver ? new view.ResizeObserver(draw) : null;
  observer?.observe(stage);

  function cleanup() {
    if (disposed) return;
    disposed = true;
    signal?.removeEventListener('abort', cleanup);
    lifetime.abort();
    unbindGestures?.();
    request?.abort();
    observer?.disconnect();
    clearTimer();
    if (paintId !== undefined) view.cancelAnimationFrame(paintId);
    root.remove();
  }
  signal?.addEventListener('abort', cleanup, { once: true });
  if (frames.length) selectFrame(Number.isInteger(initialIndex) ? initialIndex : 0);
  else { statusText('No images in this series.'); draw(); }
  return cleanup;
}
