const MAX_AXIS = 192;
const MAX_BYTES = 16 * 1024 * 1024;
const MAX_VOXELS = Math.floor(MAX_BYTES / Float32Array.BYTES_PER_ELEMENT);
const NATIVE_MAX_BYTES = 256 * 1024 * 1024;
const NATIVE_MAX_VOXELS = Math.floor(NATIVE_MAX_BYTES / Float32Array.BYTES_PER_ELEMENT);

function error(message) {
  throw new Error(message);
}

function nativeLimitError(message, cause) {
  const failure = new Error(message);
  failure.code = 'VOLUME_NATIVE_LIMIT';
  if (cause !== undefined) failure.cause = cause;
  return failure;
}

function exceedsNativeBudget(...sizes) {
  let voxels = 1;
  for (const size of sizes) {
    if (!Number.isSafeInteger(size) || size < 1) return true;
    if (voxels > Math.floor(NATIVE_MAX_VOXELS / size)) return true;
    voxels *= size;
  }
  return false;
}

function abortIfNeeded(signal) {
  if (!signal?.aborted) return;
  const aborted = new Error('Volume build was aborted');
  aborted.name = 'AbortError';
  if (signal.reason !== undefined) aborted.cause = signal.reason;
  throw aborted;
}

function finitePositive(value) {
  return Number.isFinite(value) && value > 0;
}

function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function subtract(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function scale(vector, amount) {
  return vector.map((value) => {
    const scaled = value * amount;
    return scaled === 0 ? 0 : scaled;
  });
}

function length(vector) {
  return Math.hypot(...vector);
}

function normalize(vector) {
  const magnitude = length(vector);
  return magnitude ? scale(vector, 1 / magnitude) : null;
}

function cross(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function vector3(value, label) {
  if ((!Array.isArray(value) && !ArrayBuffer.isView(value)) || value.length !== 3 || !Array.from(value).every(Number.isFinite)) {
    error(`${label} must contain three finite coordinates.`);
  }
  return Array.from(value);
}

function readOrientation(value) {
  if (value == null) return null;
  if ((!Array.isArray(value) && !ArrayBuffer.isView(value)) || value.length !== 6 || !Array.from(value).every(Number.isFinite)) {
    error('Image orientation metadata is invalid; expected six finite direction values.');
  }
  const rawX = Array.from(value.slice(0, 3));
  const rawY = Array.from(value.slice(3, 6));
  const xLength = length(rawX);
  const yLength = length(rawY);
  const x = normalize(rawX);
  const rawYUnit = normalize(rawY);
  // Allow DICOM decimal rounding, then remove its shear so the axis transpose is the inverse.
  if (Math.abs(xLength - 1) > 0.01 || Math.abs(yLength - 1) > 0.01 || Math.abs(dot(x, rawYUnit)) > 0.01) {
    error('Image orientation metadata is not orthonormal.');
  }
  const y = normalize(subtract(rawY, scale(x, dot(rawY, x))));
  return { x, y, normal: normalize(cross(x, y)) };
}

function readSpacingZ(value) {
  if (value == null) return null;
  if (!finitePositive(value)) error('Slice spacing metadata must be a positive finite number.');
  return value;
}

function inspectPositions(frames, orientation, declaredSpacing) {
  const present = frames.map((frame) => frame.position != null);
  if (!present.some(Boolean)) return { spacing: declaredSpacing ?? 1, known: declaredSpacing != null, zAxis: null };
  if (!present.every(Boolean)) error('Slice positions are incomplete; volume geometry cannot be verified.');

  const positions = frames.map((frame, i) => vector3(frame.position, `Position for slice ${i + 1}`));
  const direction = orientation?.normal ?? normalize(subtract(positions.at(-1), positions[0]));
  if (!direction) error('Slice positions do not define a slice direction.');

  const projected = positions.map((position) => dot(position, direction));
  const steps = [];
  let orderSign;
  for (let i = 1; i < projected.length; i += 1) {
    const step = projected[i] - projected[i - 1];
    if (Math.abs(step) <= 1e-4) error('Duplicate projected slice positions are not supported.');
    const sign = Math.sign(step);
    if (orderSign === undefined) orderSign = sign;
    else if (sign !== orderSign) error('Slice order is non-monotonic or interleaved.');
    steps.push(Math.abs(step));
  }

  const spacing = steps.reduce((sum, step) => sum + step, 0) / steps.length;
  const spacingTolerance = Math.max(0.001, spacing * 0.005);
  if (steps.some((step) => Math.abs(step - spacing) > spacingTolerance)) {
    error('Non-uniform slice spacing is not supported.');
  }

  const lateralTolerance = Math.max(0.01, spacing * 0.001);
  for (let i = 1; i < positions.length; i += 1) {
    const delta = subtract(positions[i], positions[i - 1]);
    const along = dot(delta, direction);
    const lateral = subtract(delta, scale(direction, along));
    if (length(lateral) > lateralTolerance) {
      error('Lateral slice drift or gantry tilt is not supported.');
    }
  }

  if (declaredSpacing != null && Math.abs(declaredSpacing - spacing) > Math.max(0.01, spacing * 0.01)) {
    error('Declared slice spacing does not match the slice positions.');
  }
  return {
    spacing,
    known: true,
    zAxis: orientation ? scale(orientation.normal, orderSign) : null,
  };
}

function readFrame(frame, index) {
  const name = `Slice ${index + 1}`;
  if (!frame || typeof frame !== 'object') error(`${name} did not decode to a frame.`);
  if (frame.type !== 'f32') error(`${name} is not scalar f32 data; RGB and other pixel types cannot be used in a volume.`);
  if (!Number.isSafeInteger(frame.width) || frame.width < 1 || !Number.isSafeInteger(frame.height) || frame.height < 1) {
    error(`${name} has invalid image dimensions.`);
  }
  if (!(frame.pixels instanceof Float32Array) || frame.pixels.length !== frame.width * frame.height) {
    error(`${name} has malformed pixel data; the decoded pixel count does not match its dimensions.`);
  }
  if (!Number.isFinite(frame.center) || !finitePositive(frame.widthWindow) || typeof frame.invert !== 'boolean') {
    error(`${name} has invalid window or photometric metadata.`);
  }

  let spacing = null;
  if (frame.spacing != null) {
    if ((!Array.isArray(frame.spacing) && !ArrayBuffer.isView(frame.spacing)) || frame.spacing.length !== 2 || !Array.from(frame.spacing).every(finitePositive)) {
      error(`${name} has invalid pixel spacing metadata.`);
    }
    spacing = Array.from(frame.spacing);
  }
  return {
    width: frame.width,
    height: frame.height,
    center: frame.center,
    widthWindow: frame.widthWindow,
    invert: frame.invert,
    spacing,
  };
}

function sameSpacing(a, b) {
  return Math.abs(a - b) <= Math.max(1e-6, Math.abs(a) * 1e-4);
}

function outputDimensions(width, height, depth) {
  const source = [width, height, depth];
  const dimensions = source.map((size) => Math.min(size, MAX_AXIS));
  const minimum = [1, 1, 2];
  const product = () => dimensions[0] * dimensions[1] * dimensions[2];
  if (product() > MAX_VOXELS) {
    const factor = Math.cbrt(MAX_VOXELS / product());
    for (let axis = 0; axis < 3; axis += 1) {
      dimensions[axis] = Math.max(minimum[axis], Math.floor(dimensions[axis] * factor));
    }
    while (product() > MAX_VOXELS) {
      let axis = -1;
      for (let i = 0; i < 3; i += 1) {
        if (dimensions[i] > minimum[i] && (axis < 0 || dimensions[i] > dimensions[axis])) axis = i;
      }
      dimensions[axis] -= 1;
    }
  }
  return dimensions;
}

function fullDepthDimensions(width, height, depth) {
  const nx = Math.min(width, MAX_AXIS);
  const ny = Math.min(height, MAX_AXIS);
  if (depth > MAX_VOXELS) {
    error(`A full-depth volume of ${depth} slices cannot fit the 16 MiB memory limit even at the smallest in-plane grid (1 × 1). Use fast sampling or a shorter series.`);
  }
  if (depth * nx * ny <= MAX_VOXELS) return [nx, ny, depth];

  const budget = Math.floor(MAX_VOXELS / depth);
  const factor = Math.sqrt(budget / (nx * ny));
  let x = Math.max(1, Math.min(nx, Math.floor(nx * factor)));
  let y = Math.max(1, Math.min(ny, Math.floor(ny * factor)));
  while (x * y * depth > MAX_VOXELS) {
    if (x >= y && x > 1) x -= 1;
    else if (y > 1) y -= 1;
    else break;
  }
  if (x * y * depth > MAX_VOXELS) {
    error(`A full-depth volume of ${depth} slices cannot fit the 16 MiB memory limit even at the smallest in-plane grid (1 × 1). Use fast sampling or a shorter series.`);
  }
  return [x, y, depth];
}

function centerSamples(sourceSize, outputSize) {
  return Array.from({ length: outputSize }, (_, i) => Math.min(sourceSize - 1, Math.floor((i + 0.5) * sourceSize / outputSize)));
}

function loadFailure(index) {
  return new Error(`Unable to load slice ${index + 1}. Check local data and retry.`);
}

export async function buildVolume(series, loadFrame, { fullDepth = false, nativeResolution = false, signal, onProgress } = {}) {
  abortIfNeeded(signal);
  if (!series || typeof series !== 'object' || !Array.isArray(series.frames)) {
    error('Invalid series metadata; a frame list is required.');
  }
  if (series.volume === false) {
    error(`This series is not suitable for volume display${series.volumeReason ? `: ${series.volumeReason}` : '.'}`);
  }
  if (series.volume !== true) error('Invalid series metadata; volume eligibility is unknown.');
  if (series.frames.length < 2) error('A volume needs at least two slices.');
  if (typeof loadFrame !== 'function') error('A frame loader is required to build a volume.');
  if (series.frames.some((frame) => !frame || frame.id == null)) error('Every slice must have a frame ID.');

  const orientation = readOrientation(series.orientation);
  const declaredSpacing = readSpacingZ(series.spacingZ);
  const geometry = inspectPositions(series.frames, orientation, declaredSpacing);
  let firstDecoded;
  try {
    firstDecoded = await loadFrame(series.frames[0].id, signal);
  } catch (cause) {
    abortIfNeeded(signal);
    if (cause?.name === 'AbortError') throw cause;
    throw loadFailure(0);
  }
  abortIfNeeded(signal);

  const firstMetadata = readFrame(firstDecoded, 0);
  const sourceDimensions = [firstMetadata.width, firstMetadata.height, series.frames.length];
  const native = Boolean(nativeResolution);
  if (native && exceedsNativeBudget(...sourceDimensions)) {
    throw nativeLimitError(`Native-resolution volume ${sourceDimensions.join(' × ')} exceeds the ${NATIVE_MAX_BYTES / (1024 * 1024)} MiB Float32 budget of ${NATIVE_MAX_VOXELS} voxels. Native resolution is never decimated; use fast sampling or a shorter series.`);
  }
  const dimensions = native
    ? sourceDimensions.slice()
    : fullDepth
      ? fullDepthDimensions(firstMetadata.width, firstMetadata.height, series.frames.length)
      : outputDimensions(firstMetadata.width, firstMetadata.height, series.frames.length);
  const selectedSlices = native || fullDepth ? null : centerSamples(series.frames.length, dimensions[2]);
  if (selectedSlices && selectedSlices[0] !== 0) firstDecoded = null;
  const [nx, ny] = dimensions;
  const sourceXSpacing = firstMetadata.spacing?.[1] ?? 1;
  const sourceYSpacing = firstMetadata.spacing?.[0] ?? 1;
  const spacing = [
    sourceXSpacing * firstMetadata.width / nx,
    sourceYSpacing * firstMetadata.height / ny,
    geometry.spacing * series.frames.length / dimensions[2],
  ];
  let data;
  try {
    data = new Float32Array(nx * ny * dimensions[2]);
  } catch (cause) {
    if (native) {
      throw nativeLimitError(`Unable to allocate the ${dimensions.join(' × ')} native volume within the ${NATIVE_MAX_BYTES / (1024 * 1024)} MiB Float32 budget. Use fast sampling or a shorter series.`, cause);
    }
    const failure = new Error(`Unable to allocate a ${dimensions.join(' × ')} volume grid within the memory limit.`);
    failure.cause = cause;
    throw failure;
  }
  const xSamples = nx === firstMetadata.width ? null : centerSamples(firstMetadata.width, nx);
  const ySamples = ny === firstMetadata.height ? null : centerSamples(firstMetadata.height, ny);
  onProgress?.(0, dimensions[2]);

  let min = Infinity;
  let max = -Infinity;
  let foundNonFinite = false;
  let finiteCount = 0;

  for (let outputZ = 0; outputZ < dimensions[2]; outputZ += 1) {
    abortIfNeeded(signal);
    const sourceZ = selectedSlices ? selectedSlices[outputZ] : outputZ;
    let decoded;
    if (sourceZ === 0) {
      decoded = firstDecoded;
      firstDecoded = null;
    } else {
      firstDecoded = null;
      try {
        decoded = await loadFrame(series.frames[sourceZ].id, signal);
      } catch (cause) {
        abortIfNeeded(signal);
        if (cause?.name === 'AbortError') throw cause;
        throw loadFailure(sourceZ);
      }
    }

    try {
      abortIfNeeded(signal);
      const metadata = sourceZ === 0 ? firstMetadata : readFrame(decoded, sourceZ);
      if (sourceZ !== 0) {
        if (metadata.width !== firstMetadata.width || metadata.height !== firstMetadata.height) {
          error(`Slice ${sourceZ + 1} has dimensions that differ from the first slice.`);
        }
        if (metadata.invert !== firstMetadata.invert) {
          error(`Slice ${sourceZ + 1} has inconsistent photometric polarity.`);
        }
        if ((metadata.spacing == null) !== (firstMetadata.spacing == null)
          || (metadata.spacing && metadata.spacing.some((value, i) => !sameSpacing(value, firstMetadata.spacing[i])))) {
          error(`Slice ${sourceZ + 1} has pixel spacing that differs from the first slice.`);
        }
      }

      abortIfNeeded(signal);
      for (let y = 0; y < ny; y += 1) {
        const sourceRow = (ySamples ? ySamples[y] : y) * metadata.width;
        const outputRow = nx * (y + ny * outputZ);
        for (let x = 0; x < nx; x += 1) {
          let value = decoded.pixels[sourceRow + (xSamples ? xSamples[x] : x)];
          if (!Number.isFinite(value)) {
            value = NaN;
            foundNonFinite = true;
          } else {
            min = Math.min(min, value);
            max = Math.max(max, value);
            finiteCount += 1;
          }
          data[outputRow + x] = value;
        }
      }
      abortIfNeeded(signal);
    } finally {
      decoded = null;
    }

    onProgress?.(outputZ + 1, dimensions[2]);
    if ((outputZ + 1) % 8 === 0 || outputZ + 1 === dimensions[2]) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      abortIfNeeded(signal);
    }
  }
  if (!finiteCount) error('No finite pixel values were found in the sampled volume.');

  const notes = [];
  if (!firstMetadata.spacing) notes.push('Pixel spacing is unknown; 1 mm per source pixel is used for display only.');
  if (!geometry.known) notes.push('Slice spacing is unknown; 1 mm per source slice is used for display only.');
  if (!orientation || !geometry.zAxis) notes.push('Physical orientation is incomplete; direction axes are unavailable.');
  const reducedXY = dimensions[0] !== sourceDimensions[0] || dimensions[1] !== sourceDimensions[1];
  const reducedZ = dimensions[2] !== sourceDimensions[2];
  if (reducedXY || reducedZ) {
    if (fullDepth) {
      notes.push(`Grid reduced from ${sourceDimensions.join(' × ')} to ${dimensions.join(' × ')} to stay within the preview memory budget; all ${sourceDimensions[2]} slices were kept, so only in-plane detail is reduced.`);
    } else {
      notes.push(`Grid reduced from ${sourceDimensions.join(' × ')} to ${dimensions.join(' × ')} to stay within the preview memory budget.`);
    }
  }
  if (foundNonFinite) notes.push('Non-finite pixel values were preserved as NaN (missing samples).');

  return {
    dimensions,
    sourceDimensions,
    data,
    spacing,
    axes: orientation && geometry.zAxis
      ? [orientation.x, orientation.y, geometry.zAxis]
      : null,
    extentMm: dimensions.map((size, axis) => size * spacing[axis]),
    calibrated: firstMetadata.spacing != null && geometry.known,
    center: firstMetadata.center,
    widthWindow: firstMetadata.widthWindow,
    invert: firstMetadata.invert,
    min,
    max,
    notes,
  };
}
