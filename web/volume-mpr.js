import {volumeWindow} from './volume-window.js';

const identity = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
const MAX_MPR_AXIS = 1024;
const MAX_NATIVE_MPR_AXIS = 4096;
const MAX_MPR_PIXELS = 4_000_000;
const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

function isNativeGrid({dimensions, sourceDimensions}) {
  if (!Array.isArray(dimensions) || dimensions.length !== 3) return false;
  if (Array.isArray(sourceDimensions)) {
    return sourceDimensions.length === 3 &&
      dimensions.every((size, axis) => size === sourceDimensions[axis]);
  }
  // Sampled in-plane grids stay at or below the legacy 1024 axis bound, so a
  // larger externally supplied section can only be native resolution.
  return dimensions[0] > MAX_MPR_AXIS || dimensions[1] > MAX_MPR_AXIS;
}

export function mprPlanes(volume) {
  const patient = Boolean(volume.calibrated && volume.axes);
  const axes = patient ? volume.axes : identity;
  // Fit the oriented scan box in each patient plane, with square physical units.
  const extents = [0, 1, 2].map(p => axes.reduce(
    (size, axis, i) => size + Math.abs(axis[p]) * volume.extentMm[i], 0));
  const native = isNativeGrid(volume);
  const axisLimit = native ? MAX_NATIVE_MPR_AXIS : MAX_MPR_AXIS;
  const requested = extents.map((size, p) => {
    const density = Math.hypot(...axes.map((axis, i) => axis[p] / volume.spacing[i]));
    return Math.max(1, Math.round(size * density));
  });
  const counts = requested.map(count => clamp(count, 1, axisLimit));
  return [
    ['Axial', 'Acquisition', 0, 1, 2, 1, ['R', 'L', 'A', 'P']],
    ['Coronal', 'Stack X–Z', 0, 2, 1, -1, ['R', 'L', 'S', 'I']],
    ['Sagittal', 'Stack Y–Z', 1, 2, 0, -1, ['A', 'P', 'S', 'I']],
  ].map(([anatomical, local, horizontal, vertical, slice, sign, edges]) => {
    const width = counts[horizontal];
    const height = counts[vertical];
    const pixels = width * height;
    let rasterWidth = width;
    let rasterHeight = height;
    let scaled = false;
    if (pixels > MAX_MPR_PIXELS) {
      // Keep the physical aspect by shrinking both display axes together.
      const factor = Math.sqrt(MAX_MPR_PIXELS / pixels);
      rasterWidth = Math.max(1, Math.floor(width * factor));
      rasterHeight = Math.max(1, Math.floor(height * factor));
      scaled = true;
    }
    const limited = native && (requested[horizontal] > width ||
      requested[vertical] > height || requested[slice] > counts[slice]);
    let note;
    if (scaled || limited) {
      const changes = [];
      if (scaled) {
        changes.push(`raster reduced to ${rasterWidth} × ${rasterHeight}` +
          ` to stay within ${MAX_MPR_PIXELS} pixels per plane`);
      }
      if (limited) changes.push(`axis counts limited to ${axisLimit}`);
      note = `MPR ${changes.join('; ')}.`;
    }
    return {
      name: patient ? anatomical : local,
      axes, extents, counts, horizontal, vertical, slice, sign,
      edges: patient ? edges : [],
      width: rasterWidth, height: rasterHeight, slices: counts[slice],
      aspect: extents[horizontal] / extents[vertical],
      ...(note ? {note, resampled: true} : {}),
    };
  });
}

function fromUnit(plane, axis, unit) {
  const count = plane.counts[axis];
  const index = clamp(Math.floor(unit * count), 0, count - 1);
  return ((index + 0.5) / count - 0.5) * plane.extents[axis];
}

export function mprCrosshair({horizontal, vertical, sign, extents}, cursor) {
  return [0.5 + cursor[horizontal] / extents[horizontal],
    0.5 + sign * cursor[vertical] / extents[vertical]];
}

export function moveMprCrosshair(plane, cursor, x, y) {
  const {horizontal, vertical, sign} = plane;
  const next = [...cursor];
  next[horizontal] = fromUnit(plane, horizontal, x);
  next[vertical] = fromUnit(plane, vertical, 0.5 + sign * (y - 0.5));
  return next;
}

export function mprSliceIndex({slice, extents, slices}, cursor) {
  return clamp(Math.floor((0.5 + cursor[slice] / extents[slice]) * slices), 0, slices - 1);
}

export function setMprSlice(plane, cursor, index) {
  const next = [...cursor];
  next[plane.slice] = fromUnit(plane, plane.slice, (index + 0.5) / plane.slices);
  return next;
}

const mix = (a, b, t) => a + (b - a) * t;

function interpolate(data, nx, ny, nz, x, y, z) {
  x = clamp(x, 0, nx - 1);
  y = clamp(y, 0, ny - 1);
  z = clamp(z, 0, nz - 1);
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const row = nx * ny;
  const a = xi + yi * nx + zi * row;
  const dx = xi + 1 < nx ? 1 : 0;
  const dy = yi + 1 < ny ? nx : 0;
  const dz = zi + 1 < nz ? row : 0;
  const xt = x - xi, yt = y - yi, zt = z - zi;
  const b = a + dz;
  const low = mix(mix(data[a], data[a + dx], xt), mix(data[a + dy], data[a + dy + dx], xt), yt);
  const high = mix(mix(data[b], data[b + dx], xt), mix(data[b + dy], data[b + dy + dx], xt), yt);
  const value = mix(low, high, zt);
  // Use the nearest sample rather than interpolating across a missing voxel.
  return Number.isFinite(value) ? value : data[Math.round(x) + nx * (Math.round(y) + ny * Math.round(z))];
}

export function renderMpr(volume, plane, cursor, {
  center = volume.center, widthWindow = volume.widthWindow, pixels,
} = {}) {
  const {axes, extents, horizontal, vertical, slice, sign, width, height} = plane;
  const {dimensions, spacing, data, invert} = volume;
  const window = volumeWindow(center, widthWindow, invert);
  const [nx, ny, nz] = dimensions;
  const output = pixels ?? new Uint8ClampedArray(width * height * 4);
  const widthMm = extents[horizontal], heightMm = extents[vertical];
  const advance = (p, step) => axes.map((axis, i) => axis[p] * step / spacing[i]);
  const [ix, iy, iz] = advance(horizontal, widthMm / width);
  const [jx, jy, jz] = advance(vertical, sign * heightMm / height);
  const [ox, oy, oz] = axes.map((axis, i) => (axis[horizontal] * (-widthMm / 2) +
    axis[vertical] * (-sign * heightMm / 2) + axis[slice] * cursor[slice]) / spacing[i] +
    (dimensions[i] - 1) / 2);
  let k = 0;
  for (let j = 0; j < height; j++) {
    let x = ox + (j + 0.5) * jx + 0.5 * ix;
    let y = oy + (j + 0.5) * jy + 0.5 * iy;
    let z = oz + (j + 0.5) * jz + 0.5 * iz;
    for (let i = 0; i < width; i++, x += ix, y += iy, z += iz) {
      let gray = 0;
      if (x >= -0.5 && x <= nx - 0.5 && y >= -0.5 && y <= ny - 0.5 && z >= -0.5 && z <= nz - 0.5) {
        const value = interpolate(data, nx, ny, nz, x, y, z);
        if (Number.isFinite(value)) gray = window(value);
      }
      output[k++] = gray;
      output[k++] = gray;
      output[k++] = gray;
      output[k++] = 255;
    }
  }
  return output;
}
