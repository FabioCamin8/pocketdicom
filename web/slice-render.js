import { normalizeNote } from './slice-note.js';

const MAX_EXPORT_EDGE = 8192;
const MAX_EXPORT_PIXELS = 16_777_216;

function dimensions(frame) {
  const columns = Number(frame?.columns ?? frame?.width);
  const rows = Number(frame?.rows ?? frame?.height);
  if (!Number.isInteger(columns) || columns < 1 || !Number.isInteger(rows) || rows < 1) {
    throw new RangeError('Frame must have positive integer columns and rows');
  }
  return { columns, rows };
}

function spacingValues(spacing) {
  const pair = Array.isArray(spacing) || ArrayBuffer.isView(spacing);
  const row = pair ? spacing[0] : spacing?.row ?? spacing?.rowSpacing;
  const column = pair ? spacing[1] : spacing?.column ?? spacing?.columnSpacing;
  const rowSpacing = Number(row);
  const columnSpacing = Number(column);
  return Number.isFinite(rowSpacing) && rowSpacing > 0 && Number.isFinite(columnSpacing) && columnSpacing > 0
    ? { row: rowSpacing, column: columnSpacing }
    : null;
}

function frameSpacing(frame) {
  return spacingValues(frame?.pixelSpacing ?? frame?.spacing) ?? { row: 1, column: 1 };
}

function rotationValues(degrees) {
  const normalized = ((degrees % 360) + 360) % 360;
  if (normalized === 0) return { cos: 1, sin: 0 };
  if (normalized === 90) return { cos: 0, sin: 1 };
  if (normalized === 180) return { cos: -1, sin: 0 };
  if (normalized === 270) return { cos: 0, sin: -1 };
  const radians = normalized * Math.PI / 180;
  return { cos: Math.cos(radians), sin: Math.sin(radians) };
}

function framePixels(frame) {
  const pixels = frame?.pixels ?? frame?.pixelData ?? frame?.data;
  if (!ArrayBuffer.isView(pixels) || pixels instanceof DataView) {
    throw new TypeError('Frame pixels must be a typed array');
  }
  return pixels;
}

function canvasContext(canvas) {
  const context = canvas?.getContext?.('2d');
  if (!context) throw new Error('A 2D canvas context is required');
  return context;
}

function imageData(context, width, height) {
  if (typeof context.createImageData === 'function') return context.createImageData(width, height);
  return new ImageData(width, height);
}

function firstNumber(value) {
  const number = Number(Array.isArray(value) ? value[0] : value);
  return Number.isFinite(number) ? number : null;
}

function windowFor(pixels, frame, center, widthWindow) {
  let c = firstNumber(center ?? frame?.windowCenter ?? frame?.center);
  let w = firstNumber(widthWindow ?? frame?.windowWidth ?? frame?.widthWindow);
  if (c === null || w === null) {
    let min = Infinity;
    let max = -Infinity;
    for (const value of pixels) {
      const sample = Number(value);
      if (Number.isFinite(sample)) {
        min = Math.min(min, sample);
        max = Math.max(max, sample);
      }
    }
    if (!Number.isFinite(min)) min = max = 0;
    c ??= (min + max + 1) / 2;
    w ??= max - min + 1;
  }
  return { center: c, width: Math.max(1, w) };
}

function linearWindow(value, center, width) {
  if (width === 1) return value <= center - 0.5 ? 0 : 255;
  const lower = center - 0.5 - (width - 1) / 2;
  const upper = center - 0.5 + (width - 1) / 2;
  if (value <= lower) return 0;
  if (value > upper) return 255;
  return Math.round((((value - (center - 0.5)) / (width - 1)) + 0.5) * 255);
}

export function createRaster(doc, frame, { center, widthWindow, invert = false } = {}) {
  const { columns, rows } = dimensions(frame);
  const pixels = framePixels(frame);
  const rgb = frame?.type === 'rgb' || String(frame?.photometricInterpretation ?? frame?.photometric ?? '').trim().toUpperCase() === 'RGB';
  const sampleCount = columns * rows * (rgb ? 3 : 1);
  if (pixels.length < sampleCount) throw new RangeError('Frame pixel data is shorter than its dimensions');
  if (rgb && !(pixels instanceof Uint8Array || pixels instanceof Uint8ClampedArray)) {
    throw new TypeError('RGB frame pixels must be interleaved 8-bit values');
  }

  const canvas = doc.createElement('canvas');
  canvas.width = columns;
  canvas.height = rows;
  const context = canvasContext(canvas);
  const output = imageData(context, columns, rows);
  if (rgb) {
    for (let pixel = 0; pixel < columns * rows; pixel += 1) {
      const source = pixel * 3;
      const target = pixel * 4;
      output.data[target] = invert ? 255 - pixels[source] : pixels[source];
      output.data[target + 1] = invert ? 255 - pixels[source + 1] : pixels[source + 1];
      output.data[target + 2] = invert ? 255 - pixels[source + 2] : pixels[source + 2];
      output.data[target + 3] = 255;
    }
  } else {
    const window = windowFor(pixels, frame, center, widthWindow);
    for (let pixel = 0; pixel < columns * rows; pixel += 1) {
      const value = Number(pixels[pixel]);
      let gray = Number.isFinite(value) ? linearWindow(value, window.center, window.width) : 0;
      if (invert) gray = 255 - gray;
      const target = pixel * 4;
      output.data[target] = gray;
      output.data[target + 1] = gray;
      output.data[target + 2] = gray;
      output.data[target + 3] = 255;
    }
  }
  context.putImageData(output, 0, 0);
  return canvas;
}

export function makeTransform(frame, viewport, { zoom = 1, panX = 0, panY = 0, rotation = 0 } = {}) {
  const { columns, rows } = dimensions(frame);
  const width = Number(viewport?.width);
  const height = Number(viewport?.height);
  if (!(width > 0) || !(height > 0) || !Number.isFinite(width) || !Number.isFinite(height)) {
    throw new RangeError('Viewport width and height must be positive');
  }
  const zoomValue = Number(zoom);
  const rotateDegrees = Number(rotation);
  const px = Number(panX);
  const py = Number(panY);
  if (!(zoomValue > 0) || !Number.isFinite(zoomValue) || !Number.isInteger(rotateDegrees) || !Number.isFinite(px) || !Number.isFinite(py)) {
    throw new RangeError('Zoom, pan, or rotation is invalid');
  }

  const spacing = frameSpacing(frame);
  const { cos, sin } = rotationValues(rotateDegrees);
  const unit = Math.max(spacing.row, spacing.column);
  const rowUnit = Math.max(Number.MIN_VALUE, spacing.row / unit);
  const columnUnit = Math.max(Number.MIN_VALUE, spacing.column / unit);
  const physicalWidth = columns * columnUnit;
  const physicalHeight = rows * rowUnit;
  const rotatedWidth = Math.abs(physicalWidth * cos) + Math.abs(physicalHeight * sin);
  const rotatedHeight = Math.abs(physicalWidth * sin) + Math.abs(physicalHeight * cos);
  const scale = Math.min(width / rotatedWidth, height / rotatedHeight) * zoomValue;
  const a = scale * cos * columnUnit;
  const b = scale * sin * columnUnit;
  const c = -scale * sin * rowUnit;
  const d = scale * cos * rowUnit;
  const centerX = (columns - 1) / 2;
  const centerY = (rows - 1) / 2;
  const e = width / 2 + px - a * centerX - c * centerY;
  const f = height / 2 + py - b * centerX - d * centerY;
  const matrix = [a, b, c, d, e, f];
  const determinant = a * d - b * c;

  return {
    matrix,
    project({ x, y }) {
      return { x: a * x + c * y + e, y: b * x + d * y + f };
    },
    unproject({ x, y }) {
      const screenX = x - e;
      const screenY = y - f;
      return {
        x: (d * screenX - c * screenY) / determinant,
        y: (a * screenY - b * screenX) / determinant,
      };
    },
  };
}

export function measureAnnotation({ kind, points } = {}, spacing) {
  if (!Array.isArray(points)) return '';
  const calibrated = spacingValues(spacing);
  const row = calibrated?.row ?? 1;
  const column = calibrated?.column ?? 1;
  if (kind === 'distance' && points.length >= 2) {
    if (!points.slice(0, 2).every(validPoint)) return '';
    const dx = (Number(points[1].x) - Number(points[0].x)) * column;
    const dy = (Number(points[1].y) - Number(points[0].y)) * row;
    const distance = Math.hypot(dx, dy);
    return `${distance.toFixed(1)} ${calibrated ? 'mm' : 'px'}`;
  }
  if (kind === 'angle' && points.length >= 3) {
    if (!points.slice(0, 3).every(validPoint)) return '';
    const vertex = points[1];
    const ax = (Number(points[0].x) - Number(vertex.x)) * column;
    const ay = (Number(points[0].y) - Number(vertex.y)) * row;
    const bx = (Number(points[2].x) - Number(vertex.x)) * column;
    const by = (Number(points[2].y) - Number(vertex.y)) * row;
    const denominator = Math.hypot(ax, ay) * Math.hypot(bx, by);
    const cosine = denominator ? (ax * bx + ay * by) / denominator : 1;
    const degrees = Math.acos(Math.max(-1, Math.min(1, cosine))) * 180 / Math.PI;
    return `${degrees.toFixed(1)}°`;
  }
  return '';
}

function validPoint(point) {
  return point && Number.isFinite(Number(point.x)) && Number.isFinite(Number(point.y));
}

function annotationColor(annotation) {
  if (annotation.selected) return '#ffe45c';
  if (annotation.draft) return '#ff776d';
  return '#00e5ff';
}

function drawAnnotations(context, annotations, project, spacing, { width, height, includeDraft = true, scale = 1 }) {
  for (const annotation of annotations ?? []) {
    if (!includeDraft && annotation.draft) continue;
    const points = annotation.points;
    if (!Array.isArray(points) || !points.length || !points.every(validPoint)) continue;
    const projected = points.map(project);
    if (projected.some((point) => !Number.isFinite(point.x) || !Number.isFinite(point.y))) continue;
    const color = annotationColor(annotation);
    context.save();
    context.strokeStyle = color;
    context.fillStyle = color;
    context.lineWidth = (annotation.selected ? 3 : 2) * scale;
    context.setLineDash?.(annotation.draft ? [6 * scale, 4 * scale] : []);
    if (projected.length > 1) {
      context.beginPath();
      context.moveTo(projected[0].x, projected[0].y);
      for (let i = 1; i < projected.length; i += 1) context.lineTo(projected[i].x, projected[i].y);
      context.stroke();
    }
    context.setLineDash([]);
    context.lineWidth = scale;
    context.strokeStyle = '#000';
    for (const point of projected) {
      context.beginPath();
      context.arc(point.x, point.y, (annotation.selected ? 4 : 3) * scale, 0, Math.PI * 2);
      context.fill();
      context.stroke();
    }

    const label = annotation.kind === 'note'
      ? normalizeNote(annotation.text)
      : measureAnnotation(annotation, spacing);
    if (label) {
      const anchor = annotation.kind === 'note'
        ? projected[0]
        : annotation.kind === 'angle' && projected.length >= 3
          ? projected[1]
          : { x: (projected[0].x + projected[projected.length - 1].x) / 2, y: (projected[0].y + projected[projected.length - 1].y) / 2 };
      if (anchor.x >= 0 && anchor.y >= 0 && anchor.x <= width && anchor.y <= height) {
        const pad = Math.min(3 * scale, width / 4, height / 4);
        const fontSize = Math.min(12 * scale, height - pad * 2);
        context.font = `${fontSize}px sans-serif`;
        const labelWidth = Math.min(context.measureText(label).width, width - pad * 2);
        const x = Math.min(anchor.x + 8 * scale, width - labelWidth - pad);
        const y = Math.max(fontSize + pad, Math.min(anchor.y - 8 * scale, height - pad));
        context.textAlign = 'left';
        context.textBaseline = 'bottom';
        context.lineWidth = Math.min(4 * scale, fontSize / 3);
        context.strokeText(label, x, y, labelWidth);
        context.fillText(label, x, y, labelWidth);
      }
    }
    context.restore();
  }
}

export function drawFrame(canvas, { width, height, dpr = 1 }, raster, transform, annotations = [], spacing) {
  const cssWidth = Number(width);
  const cssHeight = Number(height);
  const pixelRatio = Number(dpr);
  if (!(cssWidth > 0) || !(cssHeight > 0) || !(pixelRatio > 0) || ![cssWidth, cssHeight, pixelRatio].every(Number.isFinite)) {
    throw new RangeError('Canvas size and DPR must be positive');
  }
  const bufferWidth = Math.max(1, Math.round(cssWidth * pixelRatio));
  const bufferHeight = Math.max(1, Math.round(cssHeight * pixelRatio));
  if (canvas.width !== bufferWidth) canvas.width = bufferWidth;
  if (canvas.height !== bufferHeight) canvas.height = bufferHeight;
  const context = canvasContext(canvas);
  context.save();
  context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  context.fillStyle = '#000';
  context.fillRect(0, 0, cssWidth, cssHeight);

  if (raster && transform?.matrix) {
    const [a, b, c, d, e, f] = transform.matrix;
    context.save();
    context.setTransform(pixelRatio * a, pixelRatio * b, pixelRatio * c, pixelRatio * d, pixelRatio * e, pixelRatio * f);
    context.drawImage(raster, -0.5, -0.5, raster.width, raster.height);
    context.restore();
  }
  context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  if (transform?.project) drawAnnotations(context, annotations, transform.project, spacing, { width: cssWidth, height: cssHeight });
  context.restore();
}

export function createExportCanvas(doc, frame, raster, rotation = 0, annotations = []) {
  const { columns, rows } = dimensions(frame);
  const spacing = frameSpacing(frame);
  const degrees = Number(rotation);
  if (!Number.isInteger(degrees) || !Number.isFinite(degrees)) throw new RangeError('Rotation must be an integer');
  const { cos, sin } = rotationValues(degrees);
  const baseWidth = columns;
  const logAspect = Math.log(rows) - Math.log(columns) + Math.log(spacing.row) - Math.log(spacing.column);
  const aspect = Math.exp(Math.max(-Math.log(MAX_EXPORT_EDGE), Math.min(Math.log(MAX_EXPORT_EDGE), logAspect)));
  const baseHeight = baseWidth * aspect;
  const boundsWidth = Math.abs(baseWidth * cos) + Math.abs(baseHeight * sin);
  const boundsHeight = Math.abs(baseWidth * sin) + Math.abs(baseHeight * cos);
  const limitScale = Math.min(
    1,
    MAX_EXPORT_EDGE / boundsWidth,
    MAX_EXPORT_EDGE / boundsHeight,
    Math.sqrt(MAX_EXPORT_PIXELS / (boundsWidth * boundsHeight)),
  );
  const drawWidth = Math.max(1, baseWidth * limitScale);
  const drawHeight = Math.max(1, baseHeight * limitScale);
  const outputWidth = Math.min(MAX_EXPORT_EDGE, Math.max(1, Math.ceil(Math.abs(drawWidth * cos) + Math.abs(drawHeight * sin))));
  const outputHeight = Math.min(MAX_EXPORT_EDGE, Math.max(1, Math.ceil(Math.abs(drawWidth * sin) + Math.abs(drawHeight * cos))));
  const canvas = doc.createElement('canvas');
  canvas.width = outputWidth;
  canvas.height = outputHeight;
  const context = canvasContext(canvas);
  context.fillStyle = '#000';
  context.fillRect(0, 0, outputWidth, outputHeight);
  if (raster) {
    context.save();
    context.translate(outputWidth / 2, outputHeight / 2);
    context.rotate(Math.atan2(sin, cos));
    context.drawImage(raster, -drawWidth / 2, -drawHeight / 2, drawWidth, drawHeight);
    context.restore();
  }
  const project = ({ x, y }) => {
    const physicalX = (x + 0.5) * drawWidth / columns - drawWidth / 2;
    const physicalY = (y + 0.5) * drawHeight / rows - drawHeight / 2;
    return {
      x: outputWidth / 2 + cos * physicalX - sin * physicalY,
      y: outputHeight / 2 + sin * physicalX + cos * physicalY,
    };
  };
  drawAnnotations(context, annotations, project, frame?.pixelSpacing ?? frame?.spacing, {
    width: outputWidth, height: outputHeight, includeDraft: false, scale: Math.max(0.35, limitScale),
  });
  return canvas;
}
