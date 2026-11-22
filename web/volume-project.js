import {volumeWindow} from './volume-window.js';

// Bound one completed projection raster so callers can safely target the displayed
// device-pixel square. At 4096² the RGBA image and the canvas backing store are about
// 64 MiB each; row scheduling and the small interactive preview keep CPU time bounded.
// This still covers ordinary 1x and 2x desktop displays without clamping.
export const MAX_PROJECTION_SIZE = 4096;

export function projectVolume(volume, {
  yaw = 0,
  pitch = 0,
  zoom = 1,
  center = volume?.center,
  widthWindow = volume?.widthWindow,
  threshold = volume?.min,
  width,
  height = width,
  pixels,
  startRow = 0,
  endRow = height,
  maxSubpixels = 4,
} = {}) {
  if (!volume || typeof volume !== 'object') throw new TypeError('volume must be an object.');
  const dimensions = volume?.dimensions;
  const spacing = volume?.spacing;
  let voxelCount = 1;
  if (!Array.isArray(dimensions) || dimensions.length !== 3) {
    throw new RangeError('Volume dimensions must be three positive integers with an addressable voxel count.');
  }
  for (let axis = 0; axis < 3; axis += 1) {
    const size = dimensions[axis];
    if (!Number.isSafeInteger(size) || size < 1 ||
        voxelCount > Math.floor(Number.MAX_SAFE_INTEGER / size)) {
      throw new RangeError('Volume dimensions must be three positive integers with an addressable voxel count.');
    }
    voxelCount *= size;
  }
  if (!(volume.data instanceof Float32Array) || volume.data.length !== voxelCount) {
    throw new RangeError('Volume data length must match its dimensions.');
  }
  if (!Array.isArray(spacing) || spacing.length !== 3 ||
      !spacing.every(n => Number.isFinite(n) && n > 0)) {
    throw new RangeError('Volume spacing must contain three positive millimetre values.');
  }
  if (!Array.isArray(volume.extentMm) || volume.extentMm.length !== 3 ||
      !volume.extentMm.every(Number.isFinite) ||
      dimensions.some((n, i) => Math.abs(volume.extentMm[i] - n * spacing[i]) > n * spacing[i] * 1e-6)) {
    throw new RangeError('Volume extents must match dimensions and spacing.');
  }
  if (![yaw, pitch].every(Number.isFinite) || !Number.isFinite(zoom) || zoom <= 0) {
    throw new RangeError('View angles must be finite and zoom must be positive.');
  }
  if (![center, widthWindow, threshold].every(Number.isFinite) || widthWindow <= 0) {
    throw new RangeError('Window, level, and raw threshold must be finite; window must be positive.');
  }
  if (!Number.isSafeInteger(width) || width < 1 || width > MAX_PROJECTION_SIZE ||
      !Number.isSafeInteger(height) || height < 1 || height > MAX_PROJECTION_SIZE) {
    throw new RangeError(`Output width and height must be integers from 1 to ${MAX_PROJECTION_SIZE}.`);
  }
  if (!Number.isInteger(startRow) || !Number.isInteger(endRow) || startRow < 0 || endRow < startRow || endRow > height ||
      !Number.isInteger(maxSubpixels) || maxSubpixels < 1 || maxSubpixels > 4) {
    throw new RangeError('Projection row bounds or sampling limit are invalid.');
  }
  const outputLength = width * height * 4;
  if (pixels !== undefined && (!(pixels instanceof Uint8ClampedArray) || pixels.length < outputLength)) {
    throw new TypeError('pixels must be a Uint8ClampedArray large enough for the RGBA image.');
  }

  const [nx, ny, nz] = dimensions;
  const [dx, dy, dz] = spacing;
  const lengthX = nx * dx, lengthY = ny * dy, lengthZ = nz * dz;
  const halfX = lengthX / 2, halfY = lengthY / 2, halfZ = lengthZ / 2;
  const radius = Math.hypot(halfX, halfY, halfZ);
  const mmPerPixel = 2 * radius * 1.02 / (Math.min(width, height) * zoom);
  if (!(mmPerPixel > 0) || !Number.isFinite(mmPerPixel)) {
    throw new RangeError('View scale is outside the supported numeric range.');
  }

  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  const dirX = -sy * cp, dirY = sp, dirZ = cy * cp;
  const cameraDistance = 2 * radius;
  const deltaX = dirX === 0 ? Infinity : dx / Math.abs(dirX);
  const deltaY = dirY === 0 ? Infinity : dy / Math.abs(dirY);
  const deltaZ = dirZ === 0 ? Infinity : dz / Math.abs(dirZ);
  const stepX = Math.sign(dirX), stepY = Math.sign(dirY), stepZ = Math.sign(dirZ);
  // shortcut: subpixel sampling caps at 4x4 to bound CPU time; raise it for thinner features at coarse output sizes.
  const subpixels = Math.min(maxSubpixels, Math.max(1, Math.ceil(mmPerPixel / Math.min(dx, dy, dz))));
  const data = volume.data;
  const image = pixels ?? new Uint8ClampedArray(outputLength);
  const window = volumeWindow(center, widthWindow, volume.invert);
  let out = startRow * width * 4;

  for (let py = startRow; py < endRow; py++) {
    const pixelY = (py + 0.5 - height / 2) * mmPerPixel;
    for (let px = 0; px < width; px++) {
      let maximum = -Infinity;
      for (let syPixel = 0; syPixel < subpixels; syPixel++) {
        const screenY = pixelY + ((syPixel + 0.5) / subpixels - 0.5) * mmPerPixel;
        for (let sxPixel = 0; sxPixel < subpixels; sxPixel++) {
          const screenX = (px + 0.5 - width / 2) * mmPerPixel +
            ((sxPixel + 0.5) / subpixels - 0.5) * mmPerPixel;
          const originX = cy * screenX + sy * sp * screenY + sy * cp * cameraDistance;
          const originY = cp * screenY - sp * cameraDistance;
          const originZ = sy * screenX - cy * sp * screenY - cy * cp * cameraDistance;

          let enter = -Infinity, exit = Infinity;
          let near = (-halfX - originX) / dirX, far = (halfX - originX) / dirX;
          if (dirX === 0) {
            if (originX < -halfX || originX > halfX) { enter = Infinity; }
          } else {
            if (near > far) { const swap = near; near = far; far = swap; }
            enter = Math.max(enter, near); exit = Math.min(exit, far);
          }
          if (enter !== Infinity) {
            near = (-halfY - originY) / dirY; far = (halfY - originY) / dirY;
            if (dirY === 0) {
              if (originY < -halfY || originY > halfY) enter = Infinity;
            } else {
              if (near > far) { const swap = near; near = far; far = swap; }
              enter = Math.max(enter, near); exit = Math.min(exit, far);
            }
          }
          if (enter !== Infinity) {
            near = (-halfZ - originZ) / dirZ; far = (halfZ - originZ) / dirZ;
            if (dirZ === 0) {
              if (originZ < -halfZ || originZ > halfZ) enter = Infinity;
            } else {
              if (near > far) { const swap = near; near = far; far = swap; }
              enter = Math.max(enter, near); exit = Math.min(exit, far);
            }
          }

          if (enter !== Infinity && exit >= enter) {
            const x = originX + dirX * enter, y = originY + dirY * enter, z = originZ + dirZ * enter;
            let ix = stepX < 0 ? Math.ceil((x + halfX) / dx) - 1 : Math.floor((x + halfX) / dx);
            let iy = stepY < 0 ? Math.ceil((y + halfY) / dy) - 1 : Math.floor((y + halfY) / dy);
            let iz = stepZ < 0 ? Math.ceil((z + halfZ) / dz) - 1 : Math.floor((z + halfZ) / dz);
            ix = Math.max(0, Math.min(nx - 1, ix));
            iy = Math.max(0, Math.min(ny - 1, iy));
            iz = Math.max(0, Math.min(nz - 1, iz));
            let maxX = stepX === 0 ? Infinity : (-halfX + (stepX > 0 ? ix + 1 : ix) * dx - originX) / dirX;
            let maxY = stepY === 0 ? Infinity : (-halfY + (stepY > 0 ? iy + 1 : iy) * dy - originY) / dirY;
            let maxZ = stepZ === 0 ? Infinity : (-halfZ + (stepZ > 0 ? iz + 1 : iz) * dz - originZ) / dirZ;
            if (maxX < enter) maxX = enter;
            if (maxY < enter) maxY = enter;
            if (maxZ < enter) maxZ = enter;

            while (ix >= 0 && ix < nx && iy >= 0 && iy < ny && iz >= 0 && iz < nz) {
              const value = data[ix + nx * (iy + ny * iz)];
              if (Number.isFinite(value) && value >= threshold && value > maximum) maximum = value;

              const next = Math.min(maxX, maxY, maxZ);
              if (next > exit) break;
              const tolerance = 1e-12 * Math.max(1, Math.abs(next));
              if (maxX <= next + tolerance) { ix += stepX; maxX += deltaX; }
              if (maxY <= next + tolerance) { iy += stepY; maxY += deltaY; }
              if (maxZ <= next + tolerance) { iz += stepZ; maxZ += deltaZ; }
            }
          }
        }
      }

      const gray = maximum === -Infinity ? 0 : window(maximum);
      image[out++] = gray;
      image[out++] = gray;
      image[out++] = gray;
      image[out++] = 255;
    }
  }
  return image;
}
