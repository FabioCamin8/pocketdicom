import { matchStacks } from './client.js';
import { createRaster } from './slice-render.js';
import { installResizeGrip } from './view-resize.js';

const MAX_NORMAL_ANGLE = 0.1;
const MAX_FIELD_DRIFT_MM = 0.5;
const MAX_PLANE_SEPARATION_MM = 1.0;
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const dot = (a, b) => a.reduce((sum, value, index) => sum + value * b[index], 0);
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const finiteVector = (value, length) => Array.isArray(value) && value.length === length && value.every(Number.isFinite);

function orientationGeometry(value) {
  if (!finiteVector(value, 6)) return null;
  const column = value.slice(0, 3);
  const row = value.slice(3, 6);
  const columnLength = Math.hypot(...column);
  const rowLength = Math.hypot(...row);
  if (Math.abs(columnLength - 1) > 1e-3 || Math.abs(rowLength - 1) > 1e-3 || Math.abs(dot(column, row)) > 1e-3) return null;
  const normal = cross(column, row);
  const length = Math.hypot(...normal);
  if (!(length > 0)) return null;
  return { column: column.map(value => value / columnLength), row: row.map(value => value / rowLength), normal: normal.map(value => value / length) };
}

function spacingPair(value) {
  if (!(Array.isArray(value) || ArrayBuffer.isView(value)) || value.length !== 2) return null;
  const spacing = Array.from(value, Number);
  return spacing.every(value => Number.isFinite(value) && value > 0) ? spacing : null;
}

function normalAngle(a, b) {
  return Math.acos(clamp(Math.abs(dot(a, b)), -1, 1)) * 180 / Math.PI;
}

function stackProblem(series, name) {
  if (String(series?.modality ?? '').toUpperCase() !== 'CT') return `${name} series is not CT.`;
  if (series.volume !== true || !Array.isArray(series.frames) || series.frames.length < 2) return `${name} series is not a regular spatial stack.`;
  if (typeof series.frameOfReference !== 'string' || !series.frameOfReference.trim()) return `${name} series has no Frame of Reference.`;
  const seriesOrientation = orientationGeometry(series.orientation);
  if (!seriesOrientation) return `${name} series has no valid orientation.`;
  for (const frame of series.frames) {
    if (!frame?.id || !finiteVector(frame.position, 3)) return `${name} series has missing frame positions.`;
    const frameOrientation = orientationGeometry(frame.orientation ?? series.orientation);
    if (!frameOrientation || normalAngle(seriesOrientation.normal, frameOrientation.normal) > MAX_NORMAL_ANGLE) {
      return `${name} series has incompatible frame orientation.`;
    }
    if (frame.pixelSpacing != null && !spacingPair(frame.pixelSpacing)) return `${name} series has invalid per-frame PixelSpacing.`;
  }
  return null;
}

function frameGeometry(record, series, frame) {
  const photometric = frame?.photometricInterpretation ?? frame?.photometric;
  if (frame?.type !== 'f32' || !(frame.pixels instanceof Float32Array) ||
      (photometric != null && !['MONOCHROME1', 'MONOCHROME2'].includes(String(photometric).toUpperCase())) ||
      !Number.isSafeInteger(frame.width) || frame.width < 1 ||
      !Number.isSafeInteger(frame.height) || frame.height < 1 ||
      frame.pixels.length !== frame.width * frame.height) {
    throw new TypeError('The decoded frame is not a complete scalar monochrome image.');
  }
  const orientation = orientationGeometry(record.orientation ?? series.orientation);
  const spacing = spacingPair(record.pixelSpacing ?? frame.spacing);
  if (!orientation || !spacing || !finiteVector(record.position, 3)) {
    throw new TypeError('The frame has missing or invalid DICOM position, orientation, or PixelSpacing.');
  }
  return {
    position: record.position,
    orientation,
    rowSpacing: spacing[0],
    columnSpacing: spacing[1],
    width: frame.width,
    height: frame.height,
  };
}

function corners(geometry) {
  const points = [];
  for (const row of [0, geometry.height - 1]) for (const column of [0, geometry.width - 1]) {
    points.push(geometry.position.map((value, axis) => value +
      geometry.orientation.column[axis] * column * geometry.columnSpacing +
      geometry.orientation.row[axis] * row * geometry.rowSpacing));
  }
  return points;
}

function planeRange(points, plane) {
  const values = points.map(point => dot(point.map((value, axis) => value - plane.position[axis]), plane.orientation.normal));
  return Math.max(...values) - Math.min(...values);
}

function planeDrift(a, b) {
  return Math.max(planeRange(corners(a), b), planeRange(corners(b), a));
}

function planeSeparation(a, b) {
  const distances = [
    ...corners(a).map(point => dot(point.map((value, axis) => value - b.position[axis]), b.orientation.normal)),
    ...corners(b).map(point => dot(point.map((value, axis) => value - a.position[axis]), a.orientation.normal)),
  ];
  return Math.max(...distances.map(Math.abs));
}

function inPlaneOffset(a, b) {
  const delta = b.position.map((value, axis) => value - a.position[axis]);
  const normalDistance = dot(delta, a.orientation.normal);
  return Math.hypot(...delta.map((value, axis) => value - normalDistance * a.orientation.normal[axis]));
}

function sample(data, width, height, x, y, channel) {
  if (x < 0 || y < 0 || x > width - 1 || y > height - 1) return null;
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const x1 = Math.min(width - 1, x0 + 1), y1 = Math.min(height - 1, y0 + 1);
  const tx = x - x0, ty = y - y0;
  const at = (column, row) => data[(row * width + column) * 4 + channel];
  const top = at(x0, y0) * (1 - tx) + at(x1, y0) * tx;
  const bottom = at(x0, y1) * (1 - tx) + at(x1, y1) * tx;
  return top * (1 - ty) + bottom * ty;
}

function falseColor(value) {
  if (value < 128) return [0, value * 2, 255 - value * 2];
  return [(value - 128) * 2, 255 - (value - 128) * 2, 0];
}

function blendCanvas(doc, canvas, primaryFrame, primaryGeometry, secondFrame, secondGeometry, opacity, display) {
  const baseCanvas = createRaster(doc, primaryFrame, { invert: primaryFrame.invert });
  const base = baseCanvas.getContext('2d').getImageData(0, 0, primaryFrame.width, primaryFrame.height);
  canvas.width = primaryFrame.width;
  canvas.height = primaryFrame.height;
  const context = canvas.getContext('2d');
  if (secondFrame && secondGeometry) {
    const angle = normalAngle(primaryGeometry.orientation.normal, secondGeometry.orientation.normal);
    const drift = planeDrift(primaryGeometry, secondGeometry);
    const separation = planeSeparation(primaryGeometry, secondGeometry);
    if (angle > MAX_NORMAL_ANGLE || drift > MAX_FIELD_DRIFT_MM || separation > MAX_PLANE_SEPARATION_MM) {
      throw new RangeError(`The selected frame planes exceed blend limits (${angle.toFixed(3)}° normal angle, ${separation.toFixed(2)} mm separation, ${drift.toFixed(2)} mm field drift).`);
    }
    const sourceCanvas = createRaster(doc, secondFrame, { invert: secondFrame.invert });
    const source = sourceCanvas.getContext('2d').getImageData(0, 0, secondFrame.width, secondFrame.height).data;
    const alpha = clamp(opacity, 0, 1);
    const delta = primaryGeometry.position.map((value, axis) => value - secondGeometry.position[axis]);
    for (let row = 0; row < primaryFrame.height; row++) for (let column = 0; column < primaryFrame.width; column++) {
      const point = delta.map((value, axis) => value +
        primaryGeometry.orientation.column[axis] * column * primaryGeometry.columnSpacing +
        primaryGeometry.orientation.row[axis] * row * primaryGeometry.rowSpacing);
      const sourceColumn = dot(point, secondGeometry.orientation.column) / secondGeometry.columnSpacing;
      const sourceRow = dot(point, secondGeometry.orientation.row) / secondGeometry.rowSpacing;
      const index = (row * primaryFrame.width + column) * 4;
      const gray = sample(source, secondFrame.width, secondFrame.height, sourceColumn, sourceRow, 0);
      if (gray === null) continue;
      const color = display === 'false-color' ? falseColor(gray) : [gray, gray, gray];
      for (let channel = 0; channel < 3; channel++) {
        base.data[index + channel] = base.data[index + channel] * (1 - alpha) + color[channel] * alpha;
      }
    }
  }
  context.putImageData(base, 0, 0);
}

export async function mountBlend(host, { series, second, loadFrame, signal, initialIndex = 0 }) {
  const noop = () => {};
  if (signal?.aborted) return noop;
  const doc = host.ownerDocument;
  const life = new AbortController();
  const listen = (target, type, callback) => target.addEventListener(type, callback, { signal: life.signal });
  const root = doc.createElement('section');
  root.className = 'blend-view';
  const controls = doc.createElement('div');
  controls.className = 'blend-controls';
  const field = (labelText, control) => {
    const label = doc.createElement('label');
    label.className = 'blend-field';
    const text = doc.createElement('span');
    text.textContent = labelText;
    label.append(text, control);
    return label;
  };
  const slider = doc.createElement('input');
  slider.type = 'range'; slider.min = '1'; slider.max = String(Math.max(1, series?.frames?.length || 1)); slider.step = '1';
  slider.setAttribute('aria-label', 'Source slice');
  const opacity = doc.createElement('input');
  opacity.type = 'range'; opacity.min = '0'; opacity.max = '100'; opacity.step = '5'; opacity.value = '50';
  opacity.setAttribute('aria-label', 'Overlay opacity');
  const display = doc.createElement('select');
  display.setAttribute('aria-label', 'Blend display');
  for (const [value, label] of [['grayscale', 'Grayscale'], ['false-color', 'False color']]) {
    const option = doc.createElement('option'); option.value = value; option.textContent = label; display.append(option);
  }
  controls.append(field('Source slice', slider), field('Overlay opacity', opacity), field('Display', display));
  const warning = doc.createElement('p');
  warning.className = 'blend-warning';
  warning.setAttribute('aria-label', 'Blend geometry caution');
  warning.textContent = 'No motion correction. Plane separation and in-plane offset are different measurements.';
  const status = doc.createElement('p');
  status.className = 'blend-status';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-label', 'Blend status');
  const retry = doc.createElement('button');
  retry.type = 'button'; retry.textContent = 'Retry'; retry.hidden = true;
  retry.setAttribute('aria-label', 'Retry blend');
  const canvas = doc.createElement('canvas');
  canvas.className = 'blend-canvas';
  canvas.setAttribute('aria-label', 'Blended CT image');
  const stage = doc.createElement('div');
  stage.className = 'blend-stage';
  stage.setAttribute('role', 'region');
  stage.setAttribute('aria-label', 'CT blend viewport');
  stage.append(canvas, status, retry);
  root.append(controls, warning, stage);
  host.replaceChildren(root);
  installResizeGrip(stage);

  let index = clamp(Number.isInteger(initialIndex) ? initialIndex : 0, 0, Math.max(0, (series?.frames?.length || 1) - 1));
  let request, generation = 0, disposed = false, current;
  let map = null;
  let problem = stackProblem(series, 'Source') || stackProblem(second, 'Secondary');
  if (!problem && series.frameOfReference !== second.frameOfReference) problem = 'The stacks do not share a Frame of Reference.';
  if (!problem && normalAngle(orientationGeometry(series.orientation).normal, orientationGeometry(second.orientation).normal) > MAX_NORMAL_ANGLE) {
    problem = 'The stack plane orientations differ by too much.';
  }
  if (!problem) {
    try { map = matchStacks(series, second); } catch { map = null; }
    if (!map) problem = 'The stacks do not have matching spatial geometry.';
  }
  if (typeof loadFrame !== 'function' && !problem) problem = 'The frame loader is unavailable.';
  slider.value = String(index + 1);
  opacity.setAttribute('aria-valuetext', '50 percent');

  function showStatus(message, retryable = false) {
    status.textContent = message;
    retry.hidden = !retryable;
  }

  function paint() {
    if (!current) return;
    blendCanvas(doc, canvas, current.primary, current.primaryGeometry, current.secondary,
      current.secondaryGeometry, Number(opacity.value) / 100, display.value);
  }

  async function selectFrame(selected) {
    if (disposed || problem) return;
    index = clamp(selected, 0, series.frames.length - 1);
    slider.value = String(index + 1);
    request?.abort();
    current = null;
    canvas.width = canvas.height = 0;
    const controller = new AbortController();
    request = controller;
    const token = ++generation;
    const primaryRecord = series.frames[index];
    let secondIndex = null;
    try { secondIndex = map(index); } catch { secondIndex = null; }
    const live = () => !disposed && token === generation && !controller.signal.aborted && !signal?.aborted;
    warning.textContent = 'No motion correction. Plane separation and in-plane offset are different measurements.';
    showStatus(`Loading source slice ${index + 1} of ${series.frames.length}…`);
    const tasks = [Promise.resolve().then(() => loadFrame(primaryRecord.id, controller.signal))];
    if (Number.isInteger(secondIndex) && second.frames[secondIndex]) {
      tasks.push(Promise.resolve().then(() => loadFrame(second.frames[secondIndex].id, controller.signal)));
    }
    const results = await Promise.allSettled(tasks);
    if (!live()) return;
    if (results[0].status === 'rejected') {
      current = null;
      showStatus(`Could not load source slice: ${results[0].reason?.message || 'image unavailable.'}`, true);
      return;
    }
    let primaryGeometry;
    try { primaryGeometry = frameGeometry(primaryRecord, series, results[0].value); }
    catch (error) {
      current = null;
      showStatus(error.message, true);
      return;
    }
    let secondaryFrame = null, secondaryGeometry = null, secondaryMetrics = null;
    let secondaryError = '';
    if (!Number.isInteger(secondIndex) || !second.frames[secondIndex]) {
      secondaryError = 'No nearby secondary slice at this source position.';
    } else if (results[1].status === 'rejected') {
      secondaryError = `Secondary image unavailable: ${results[1].reason?.message || 'load failed.'}`;
    } else {
      try {
        secondaryFrame = results[1].value;
        secondaryGeometry = frameGeometry(second.frames[secondIndex], second, secondaryFrame);
        const angle = normalAngle(primaryGeometry.orientation.normal, secondaryGeometry.orientation.normal);
        const drift = planeDrift(primaryGeometry, secondaryGeometry);
        const separation = planeSeparation(primaryGeometry, secondaryGeometry);
        secondaryMetrics = { angle, drift, separation, inPlaneOffset: inPlaneOffset(primaryGeometry, secondaryGeometry) };
        if (angle > MAX_NORMAL_ANGLE || drift > MAX_FIELD_DRIFT_MM || separation > MAX_PLANE_SEPARATION_MM) {
          secondaryFrame = secondaryGeometry = null;
          secondaryError = separation > MAX_PLANE_SEPARATION_MM
            ? `Plane separation ${separation.toFixed(2)} mm exceeds the ${MAX_PLANE_SEPARATION_MM.toFixed(2)} mm blend limit.`
            : angle > MAX_NORMAL_ANGLE
              ? `Normal angle ${angle.toFixed(3)}° exceeds the ${MAX_NORMAL_ANGLE.toFixed(2)}° blend limit.`
              : `The selected frame planes differ too much across the image (${drift.toFixed(2)} mm field drift).`;
        }
      } catch (error) {
        secondaryFrame = secondaryGeometry = null;
        secondaryError = error.message;
      }
    }
    current = { primary: results[0].value, primaryGeometry, secondary: secondaryFrame, secondaryGeometry };
    try { paint(); }
    catch (error) {
      current = null;
      showStatus(error.message || 'Unable to draw this blend.', true);
      return;
    }
    if (secondaryFrame && secondaryGeometry) {
      const delta = secondaryGeometry.position.map((value, axis) => value - primaryGeometry.position[axis]);
      const originSeparation = Math.abs(dot(delta, primaryGeometry.orientation.normal));
      warning.textContent = `No motion correction. Plane separation at image origins: ${originSeparation.toFixed(2)} mm; maximum separation across both fields: ${secondaryMetrics.separation.toFixed(2)} mm; in-plane origin offset: ${secondaryMetrics.inPlaneOffset.toFixed(2)} mm; across-field plane drift: ${secondaryMetrics.drift.toFixed(2)} mm; normal angle difference: ${secondaryMetrics.angle.toFixed(3)}°.`;
      showStatus(`Source slice ${index + 1} of ${series.frames.length}; secondary slice ${secondIndex + 1} of ${second.frames.length}.`);
    } else {
      if (secondaryMetrics) {
        warning.textContent = `No motion correction. Blend refused. Maximum plane separation across both fields: ${secondaryMetrics.separation.toFixed(2)} mm (limit ${MAX_PLANE_SEPARATION_MM.toFixed(2)} mm); in-plane origin offset: ${secondaryMetrics.inPlaneOffset.toFixed(2)} mm; across-field plane drift: ${secondaryMetrics.drift.toFixed(2)} mm; normal angle difference: ${secondaryMetrics.angle.toFixed(3)}°.`;
      } else {
        warning.textContent = `No motion correction. Plane separation and in-plane offset are different measurements. ${secondaryError}`;
      }
      showStatus(`${secondaryError} Showing the source slice only.`, Boolean(results[1]?.status === 'rejected' || secondaryError && results[1]?.status === 'fulfilled'));
    }
  }

  listen(slider, 'input', () => selectFrame(Number(slider.value) - 1));
  listen(opacity, 'input', () => {
    opacity.setAttribute('aria-valuetext', `${opacity.value} percent`);
    try { paint(); } catch (error) { showStatus(error.message, true); }
  });
  listen(display, 'change', () => { try { paint(); } catch (error) { showStatus(error.message, true); } });
  listen(retry, 'click', () => selectFrame(index));
  const cleanup = () => {
    if (disposed) return;
    disposed = true;
    generation++;
    request?.abort();
    life.abort();
    signal?.removeEventListener('abort', cleanup);
    root.remove();
  };
  signal?.addEventListener('abort', cleanup, { once: true });
  if (signal?.aborted) cleanup();
  else if (problem) {
    slider.disabled = opacity.disabled = display.disabled = true;
    showStatus(problem);
  }
  else void selectFrame(index);
  return cleanup;
}
