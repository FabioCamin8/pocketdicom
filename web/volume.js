import {buildVolume} from './volume-data.js';
import {mprPlanes, mprCrosshair, moveMprCrosshair, mprSliceIndex, setMprSlice, renderMpr} from './volume-mpr.js';
import {projectVolume, MAX_PROJECTION_SIZE} from './volume-project.js';

import {installResizeGrip} from './view-resize.js';

const stylesheet = new URL('./volume.css', import.meta.url).href;
const clamp = (n, min, max) => Math.min(max, Math.max(min, n));
const format = value => String(Number(value.toPrecision(5)));
// The default projection is deliberately quick: a tiny interactive raster while
// gesturing and a small idle raster even for a native source. Full-size actions
// render the displayed device-pixel square, bounded by MAX_PROJECTION_SIZE.
const PREVIEW_RASTER = 96;
const LARGE_VOLUME_PREVIEW_RASTER = 72;
const IDLE_PREVIEW_RASTER = 176;
const MIN_PROJECTION_RASTER = 64;
const PROJECTION_MODES = new Set(['preview', 'current', 'sticky']);

const ORIGINAL_CAMERA = Object.freeze({yaw: 0.45, pitch: -0.3, zoom: 1});

function abortFailure(message = 'Volume build was aborted') {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

function aborted(signal, error) {
  return Boolean(signal?.aborted) || error?.name === 'AbortError';
}

function nativeLimit(error) {
  return error?.code === 'VOLUME_NATIVE_LIMIT';
}

function validDimensions(value) {
  return Array.isArray(value) && value.length === 3 &&
    value.every(size => Number.isSafeInteger(size) && size > 0);
}

function sourceGrid(volume, series) {
  if (validDimensions(volume?.sourceDimensions)) return volume.sourceDimensions.slice();
  const dimensions = validDimensions(volume?.dimensions) ? volume.dimensions.slice() : [1, 1, 1];
  const frameCount = Array.isArray(series?.frames) ? series.frames.length : dimensions[2];
  return [dimensions[0], dimensions[1], Math.max(dimensions[2], frameCount)];
}

function gridIsNative(volume, series) {
  const source = sourceGrid(volume, series);
  return Array.isArray(volume?.dimensions) && volume.dimensions.length === 3
    && volume.dimensions.every((size, axis) => size === source[axis]);
}

// Resize grips set only inline dimensions on these stable containers. Replaying them
// on a remounted source keeps an explicitly resized projection or section panel.
function applyPanelStyles(styles, widthNode, heightNode) {
  if (!styles) return;
  if (styles.width && widthNode) widthNode.style.cssText = styles.width;
  if (styles.height && heightNode) heightNode.style.cssText = styles.height;
}

export async function mountVolume(host, {
  series, loadFrame, signal, build = buildVolume, project = projectVolume,
}) {
  const life = new AbortController();
  const reading = new AbortController();
  if (signal?.aborted) return () => {};

  const element = host.ownerDocument.createElement('div');
  const shadow = element.attachShadow({mode: 'open'});
  shadow.innerHTML = `
    <link rel="stylesheet">
    <section class="pdv" aria-label="Multiplanar and 3D viewer">
      <div class="pdv-loading">
        <p role="status">Preparing volume…</p>
        <progress aria-label="Loading volume"></progress>
        <button type="button">Cancel loading</button>
      </div>
      <div class="pdv-body" hidden></div>
    </section>`;
  shadow.querySelector('link').href = stylesheet;
  const loading = shadow.querySelector('.pdv-loading');
  const status = loading.querySelector('p');
  const progress = loading.querySelector('progress');
  const cancel = loading.querySelector('button');
  const body = shadow.querySelector('.pdv-body');
  let quickSource;
  let nativeSource;
  let clearView;
  const show = (volume, carry = null) => {
    clearView?.();
    const mounted = showVolume(body, volume, series, life.signal, unavailable, {
      loadFrame,
      build,
      project,
      carry,
      quickVolume: quickSource,
      cachedNative: () => nativeSource,
      rememberNative: full => { nativeSource = full; },
      switchTo: (next, patch = {}) => {
        if (life.signal.aborted) return;
        show(next, {...mounted.capture(), ...patch});
      },
    });
    clearView = mounted.cleanup;
  };
  const cleanup = () => {
    if (life.signal.aborted) return;
    life.abort();
    reading.abort();
    clearView?.();
    clearView = null;
    quickSource = null;
    nativeSource = null;
    element.remove();
  };
  const unavailable = message => {
    body.hidden = true;
    body.replaceChildren();
    loading.hidden = false;
    status.textContent = `${message} The 2D viewer is still available.`;
    progress.hidden = true;
    cancel.hidden = true;
  };
  host.append(element);
  signal?.addEventListener('abort', cleanup, {once: true, signal: life.signal});
  cancel.addEventListener('click', () => {
    reading.abort();
    unavailable('Volume loading canceled.');
  }, {signal: life.signal});

  if (!series?.volume) {
    unavailable(series?.volumeReason || 'This series cannot be reconstructed as a volume.');
  } else if (typeof build !== 'function' || typeof project !== 'function') {
    unavailable('The volume renderer is unavailable.');
  } else {
    const report = (label, done, total) => {
      if (reading.signal.aborted) return;
      progress.max = total;
      progress.value = done;
      status.textContent = `Loading ${label} (${done} of ${total})…`;
    };
    // Every screen starts from the quick sampled build. Full source grids are only
    // requested by the explicit quality actions or a full-size projection, and the
    // original quick volume stays cached for instant Restore preview.
    void (async () => {
      const volume = await build(series, loadFrame, {
        signal: reading.signal,
        onProgress: (done, total) => report('quick preview', done, total),
      });
      if (reading.signal.aborted) return;
      quickSource = volume;
      show(volume);
      body.hidden = false;
      loading.hidden = true;
    })().catch(error => {
      if (!reading.signal.aborted) unavailable(error?.message || 'The volume could not be prepared.');
    });
  }
  return cleanup;
}

function showVolume(body, volume, series, signal, unavailable, {
  loadFrame, build = buildVolume, project = projectVolume, switchTo, quickVolume = volume,
  cachedNative = () => null, rememberNative = () => {}, carry = null,
}) {
  const {min, max, dimensions} = volume;
  const sourceDimensions = sourceGrid(volume, series);
  const nativeQuality = dimensions.every((size, axis) => size === sourceDimensions[axis]);
  const viewLife = new AbortController();
  const state = {
    center: Number.isFinite(carry?.center) ? carry.center : volume.center,
    widthWindow: Number.isFinite(carry?.widthWindow) && carry.widthWindow > 0 ? carry.widthWindow : Math.max(1, volume.widthWindow),
    threshold: Number.isFinite(carry?.threshold) ? carry.threshold : min,
    yaw: Number.isFinite(carry?.yaw) ? carry.yaw : ORIGINAL_CAMERA.yaw,
    pitch: Number.isFinite(carry?.pitch) ? carry.pitch : ORIGINAL_CAMERA.pitch,
    zoom: Number.isFinite(carry?.zoom) && carry.zoom > 0 ? carry.zoom : ORIGINAL_CAMERA.zoom,
  };
  const planes = mprPlanes(volume);
  let cursor = Array.isArray(carry?.cursor) && carry.cursor.length === 3 && carry.cursor.every(Number.isFinite)
    ? [...carry.cursor]
    : planes.reduce((point, plane) => setMprSlice(plane, point, Math.floor(plane.slices / 2)), [0, 0, 0]);
  const totalSections = sourceDimensions[2];
  const skippedSections = dimensions[2] < totalSections;
  const resolutionPending = dimensions.some((size, axis) => size !== sourceDimensions[axis]);
  const summaryParts = [];
  if (skippedSections) {
    summaryParts.push(`Loaded ${dimensions[2]} of ${totalSections} sections. Loading all sections may reduce XY detail to fit memory.`);
  }
  if (resolutionPending) {
    summaryParts.push(`Showing ${dimensions.join(' × ')} of ${sourceDimensions.join(' × ')} source voxels. Load full resolution requests the exact source grid.`);
  }
  const quickSummary = summaryParts.join(' ');

  body.innerHTML = `
    <p class="pdv-note pdv-volume-note" role="status"></p>
    <div class="pdv-modes" role="group" aria-label="Volume view">
      <button type="button" data-mode="rotate" aria-pressed="true">Rotate volume</button>
      <button type="button" data-mode="sections" aria-pressed="false">Explore sections</button>
    </div>
    <div class="pdv-upgrade" hidden>
      <p class="pdv-upgrade-note" role="status"></p>
      <div class="pdv-controls pdv-upgrade-actions">
        <button type="button" class="pdv-load-all">Load all sections</button>
        <button type="button" class="pdv-load-native">Load full resolution</button>
        <button type="button" class="pdv-cancel-all" hidden>Cancel loading all sections</button>
      </div>
      <progress class="pdv-upgrade-progress" aria-label="Loading volume upgrade" hidden></progress>
    </div>
    <p class="pdv-unavailable" role="alert" hidden></p>
    <section class="pdv-rotate" aria-label="Rotate volume">
      <div class="pdv-stage"><div class="pdv-image pdv-projection"><canvas tabindex="0"
        aria-label="3D maximum intensity projection. Drag to rotate. Arrow keys rotate, plus and minus zoom, and Home resets the view."></canvas></div></div>
      <p class="pdv-hint">Drag to rotate. Scroll or pinch to zoom.</p>
      <div class="pdv-controls">
        <label>Zoom <output></output><input type="range" aria-label="3D zoom"></label>
        <button type="button" class="pdv-reset">Reset view</button>
      </div>
      <div class="pdv-controls pdv-projection-actions" role="group" aria-label="Projection size">
        <button type="button" class="pdv-full-current" aria-pressed="false">Full-size current view</button>
        <button type="button" class="pdv-full-sticky" aria-pressed="false">Full-size 3D</button>
        <button type="button" class="pdv-restore-preview" aria-pressed="true">Restore preview</button>
      </div>
      <p class="pdv-help">Full-size current view sharpens this angle. Full-size 3D keeps full detail as you rotate. Restore preview switches back to the lightweight volume.</p>
    </section>
    <section class="pdv-sections" aria-label="Explore sections" hidden>
      <div class="pdv-plane-tabs" role="group" aria-label="Section plane" hidden></div>
      <p class="pdv-hint">Tap or click a point to locate it in the other sections.</p>
      <div class="pdv-grid"></div>
    </section>
    <details class="pdv-settings">
      <summary>Display settings</summary>
      <div class="pdv-controls">
        <label>Window level <output></output><input type="range" aria-label="Window level"></label>
        <label>Window width <output></output><input type="range" aria-label="Window width"></label>
      </div>
      <p class="pdv-help" id="pdv-threshold-help">3D threshold determines which intensities contribute to the projection.</p>
      <div class="pdv-controls">
        <label>Threshold <output></output><input type="range" aria-label="3D threshold"
          aria-describedby="pdv-threshold-help"></label>
      </div>
    </details>`;
  const settings = body.querySelector('.pdv-settings');
  settings.open = Boolean(carry?.settingsOpen);
  const grid = body.querySelector('.pdv-grid');
  const document = body.ownerDocument;
  const window = document.defaultView;
  const modeButtons = [...body.querySelectorAll('[data-mode]')];
  const rotateButton = modeButtons.find(button => button.dataset.mode === 'rotate');
  const rotatePanel = body.querySelector('.pdv-rotate');
  const sectionsPanel = body.querySelector('.pdv-sections');
  const planeTabs = body.querySelector('.pdv-plane-tabs');
  const unavailableNote = body.querySelector('.pdv-unavailable');
  let mode = carry?.mode === 'sections' ? 'sections' : 'rotate';
  let selectedPlane = Number.isInteger(carry?.selectedPlane) ? clamp(carry.selectedPlane, 0, 2) : 0;
  let projectionMode = PROJECTION_MODES.has(carry?.projectionMode) ? carry.projectionMode : 'preview';

  const layoutMedia = window.matchMedia?.('(max-width: 650px)');
  let narrow = Boolean(layoutMedia?.matches);

  const panel = html => {
    const div = document.createElement('div');
    div.className = 'pdv-panel pdv-plane';
    div.innerHTML = html;
    grid.append(div);
    return div;
  };
  const say = body.querySelector('.pdv-volume-note');
  const guidance = planes[0].edges.length ? 'Radiological patient views.'
    : 'Acquisition-aligned views. Patient orientation or physical spacing is incomplete.';
  const quality = nativeQuality
    ? `Full resolution source volume ${dimensions.join(' × ')} voxels.`
    : `Sampled preview source volume ${dimensions.join(' × ')} of ${sourceDimensions.join(' × ')} source voxels.`;
  body.dataset.quality = nativeQuality ? 'native' : 'sampled';
  say.dataset.quality = body.dataset.quality;
  say.textContent = [`Loaded ${dimensions[2]} of ${totalSections} sections.`, quality, guidance,
    ...(volume.notes || [])].filter(Boolean).join(' ');

  function on(node, event, callback, options) {
    node.addEventListener(event, callback, {...options, signal: viewLife.signal});
  }

  const slices = planes.map((plane, index) => {
    const box = panel(`
      <h3></h3>
      <div class="pdv-stage"><div class="pdv-image pdv-slice">
        <canvas role="img"></canvas><div class="pdv-crosshair" aria-hidden="true"></div>
      </div></div>
      <label class="pdv-slice-control">Slice <output></output><input type="range" min="1" step="1"></label>`);
    const heading = box.querySelector('h3');
    heading.textContent = plane.name;
    if (plane.note) {
      const note = document.createElement('span');
      note.className = 'pdv-plane-note';
      note.dataset.mprNote = plane.resampled ? 'reduced-raster' : 'limited';
      note.textContent = plane.note;
      heading.append(' ', note);
    }
    installResizeGrip(box.querySelector('.pdv-stage'));
    applyPanelStyles(carry?.panels?.slices?.[index], box, box.querySelector('.pdv-stage'));
    const image = box.querySelector('.pdv-image');
    image.style.setProperty('--pdv-ratio', plane.aspect);
    plane.edges.forEach((value, i) => {
      const mark = document.createElement('span');
      mark.dataset.edge = ['left', 'right', 'top', 'bottom'][i];
      mark.textContent = value;
      image.append(mark);
    });
    const canvas = box.querySelector('canvas');
    canvas.setAttribute('aria-label', plane.edges.length ? `${plane.name} view. Left ${plane.edges[0]}, right ${plane.edges[1]}, top ${plane.edges[2]}, bottom ${plane.edges[3]}.` : `${plane.name} view`);
    canvas.width = plane.width;
    canvas.height = plane.height;
    const context = canvas.getContext('2d', {alpha: false});
    if (!context) throw new Error('This browser does not support multiplanar canvas rendering.');
    on(canvas, 'contextlost', () => unavailable('Slice rendering is unavailable in this browser.'));
    const pixels = context.createImageData(plane.width, plane.height);
    const crosshair = image.querySelector('.pdv-crosshair');
    const input = box.querySelector('input');
    const output = box.querySelector('output');
    input.max = plane.slices;
    input.disabled = plane.slices < 2;
    input.setAttribute('aria-label', `${plane.name} slice`);
    on(input, 'input', () => {
      cursor = setMprSlice(plane, cursor, Number(input.value) - 1);
      schedule(true);
    });

    let pointer;
    const select = event => {
      const bounds = image.getBoundingClientRect();
      if (!bounds.width || !bounds.height) return;
      cursor = moveMprCrosshair(plane, cursor, (event.clientX - bounds.left) / bounds.width,
        (event.clientY - bounds.top) / bounds.height);
      schedule(true);
    };
    on(image, 'pointerdown', event => {
      if (pointer !== undefined || event.button !== 0) return;
      image.setPointerCapture(event.pointerId);
      pointer = event.pointerId;
      select(event);
    });
    on(image, 'pointermove', event => { if (pointer === event.pointerId) select(event); });
    on(image, 'lostpointercapture', event => { if (pointer === event.pointerId) pointer = undefined; });

    let lastCenter, lastWidth, lastSlice;
    const draw = () => {
      const [x, y] = mprCrosshair(plane, cursor);
      crosshair.style.setProperty('--pdv-x', `${x * 100}%`);
      crosshair.style.setProperty('--pdv-y', `${y * 100}%`);
      const index = mprSliceIndex(plane, cursor);
      input.value = index + 1;
      output.value = `${index + 1} / ${plane.slices}`;
      input.setAttribute('aria-valuetext', `${index + 1} of ${plane.slices}`);
      if (box.hidden) {
        // Force a fresh full render when this plane is shown again.
        lastSlice = undefined;
        return;
      }
      if (index === lastSlice && state.center === lastCenter && state.widthWindow === lastWidth) return;
      lastSlice = index;
      lastCenter = state.center;
      lastWidth = state.widthWindow;
      renderMpr(volume, plane, cursor, {...state, pixels: pixels.data});
      context.putImageData(pixels, 0, 0);
    };
    return {box, draw};
  });

  const planeButtons = planes.map((plane, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = plane.name;
    button.setAttribute('aria-pressed', String(index === selectedPlane));
    on(button, 'click', () => {
      selectedPlane = index;
      updatePlaneVisibility();
      schedule(true);
    });
    planeTabs.append(button);
    return button;
  });

  const projection = rotatePanel;
  const canvas = projection.querySelector('canvas');
  const stage = projection.querySelector('.pdv-stage');
  installResizeGrip(stage);
  applyPanelStyles(carry?.panels?.projection, projection, stage);
  const projectionControls = projection.querySelector('.pdv-controls');
  const hint = projection.querySelector('.pdv-hint');
  const fullCurrentButton = projection.querySelector('.pdv-full-current');
  const fullStickyButton = projection.querySelector('.pdv-full-sticky');
  const restorePreviewButton = projection.querySelector('.pdv-restore-preview');
  const upgradeBox = body.querySelector('.pdv-upgrade');
  const upgradeNote = body.querySelector('.pdv-upgrade-note');
  const loadAllButton = body.querySelector('.pdv-load-all');
  const loadNativeButton = body.querySelector('.pdv-load-native');
  const cancelAllButton = body.querySelector('.pdv-cancel-all');
  const upgradeProgress = body.querySelector('.pdv-upgrade-progress');
  const hasUpgrade = skippedSections || resolutionPending;
  if (hasUpgrade) {
    upgradeBox.hidden = false;
    upgradeNote.textContent = quickSummary;
    loadAllButton.hidden = !skippedSections;
    loadNativeButton.hidden = !resolutionPending;
    if (!skippedSections && !resolutionPending) {
      loadAllButton.hidden = true;
      loadNativeButton.hidden = true;
    }
  } else {
    upgradeBox.remove();
  }
  let upgradeAttempt = null;
  let context;
  try {
    context = canvas.getContext('2d', {alpha: false});
  } catch {
    context = null;
  }
  let projectionPixels;
  let projectionJob;
  let projectionVersion = 0;
  // A one-shot full-size view can fall back to the cached quick source while a gesture
  // is still active. The projection then renders quick voxels immediately, but the DOM
  // source is only remounted once the pointer/interaction has ended.
  let projectionQuick = false;
  let projectionSourceSerial = 0;
  let quickRemountPending = false;
  let quickRemountTimer = null;
  let controlDragging = null;
  const projectionUnavailable = () => {
    context = null;
    projectionPixels = undefined;
    projectionJob = null;
    projectionDirty = false;
    draft = false;
    canvas.dataset.renderState = 'unavailable';
    stage.hidden = true;
    projectionControls.hidden = true;
    hint.hidden = true;
    fullCurrentButton.disabled = true;
    fullStickyButton.disabled = true;
    restorePreviewButton.disabled = true;
    fullCurrentButton.setAttribute('aria-pressed', 'false');
    fullStickyButton.setAttribute('aria-pressed', 'false');
    unavailableNote.hidden = false;
    unavailableNote.textContent = '3D rendering is unavailable in this browser. The slice views are still available.';
    rotateButton.disabled = true;
    rotateButton.setAttribute('aria-pressed', 'false');
    if (mode !== 'sections') setMode('sections');
    else ensureFocus();
  };
  on(canvas, 'contextlost', projectionUnavailable);

  const pointers = new Map();
  let pending = null;
  let refineTimer = null;
  let resizeTimer = null;
  let mprDirty = false;
  let projectionDirty = false;
  let draft = false;
  let lastRenderedRaster = 0;
  let lastRenderedSignature = '';
  let lastRenderedPreview = false;
  let lastRenderedAnimated = false;

  function rasterTarget(full = false) {
    // The projection image is square; measure the square the CSS actually draws rather
    // than assuming the stage dimensions are equal. devicePixelRatio turns that CSS
    // square into the backing-store raster shown on the display.
    const bounds = canvas.getBoundingClientRect();
    const display = Math.min(Number(bounds?.width) || 0, Number(bounds?.height) || 0);
    if (!full || !(display > 0)) return {width: IDLE_PREVIEW_RASTER, requested: IDLE_PREVIEW_RASTER};
    const dpr = Number(window.devicePixelRatio) || 1;
    const requested = Math.max(1, Math.round(display * dpr));
    const width = Math.round(clamp(requested, MIN_PROJECTION_RASTER, MAX_PROJECTION_SIZE));
    return {width, requested};
  }

  function activeProjectionVolume() {
    return projectionQuick && quickVolume ? quickVolume : volume;
  }

  function previewRaster() {
    return activeProjectionVolume().data.length > 2000000
      ? LARGE_VOLUME_PREVIEW_RASTER : PREVIEW_RASTER;
  }

  function projectionSignature(preview, size) {
    // Preview and full-size frames are distinct outputs even when only their raster differs.
    // The source serial keeps an in-place quick gesture distinct from the native source it
    // temporarily replaces before the deferred remount.
    return `${preview ? 'preview' : 'full'}:${projectionSourceSerial}:${size}:${
      state.yaw}:${state.pitch}:${state.zoom}:${
      state.center}:${state.widthWindow}:${state.threshold}`;
  }

  function updateProjectionSurface(job) {
    const {width, height} = job.options;
    const raster = job.raster;
    const limit = !job.preview && raster.requested > MAX_PROJECTION_SIZE
      ? ` Display requested ${raster.requested} px; clamped to the ${MAX_PROJECTION_SIZE} px safety ceiling.`
      : '';
    const label = job.mode === 'current' ? 'Full-size current view'
      : job.mode === 'sticky' ? 'Full-size 3D' : 'Projection preview';
    const active = activeProjectionVolume();
    const activeSource = sourceGrid(active, series);
    const source = gridIsNative(active, series)
      ? `Source volume: full resolution ${active.dimensions.join(' × ')} voxels.`
      : `Source volume: sampled preview ${active.dimensions.join(' × ')} of ${activeSource.join(' × ')} voxels.`;
    // Keep the source volume grid distinct from the rendered projection raster.
    const description = `${label}: ${width} × ${height} rendered pixels. ${source}`;
    hint.textContent = `Drag to rotate. Scroll or pinch to zoom. ${description}${limit}`;
    canvas.dataset.projectionRaster = `${width}×${height}`;
    canvas.dataset.projectionMode = job.mode;
    canvas.dataset.projectionSource = gridIsNative(active, series) ? 'native' : 'sampled';
    canvas.setAttribute('aria-label', `3D maximum intensity projection. ${description} Drag to rotate. Arrow keys rotate, plus and minus zoom, and Home resets the view.${limit}`);
  }

  function queueRasterRefresh() {
    if (!context || viewLife.signal.aborted) return;
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => {
      resizeTimer = null;
      if (!context || mode !== 'rotate' || viewLife.signal.aborted) return;
      if (projectionMode === 'preview') return;
      const target = rasterTarget(true);
      if (target.width === lastRenderedRaster && !projectionJob) return;
      schedule(false, true);
    }, 160);
  }

  function schedule(mpr = false, threeD = false, preview = false) {
    if (viewLife.signal.aborted) return;
    mprDirty ||= mpr;
    if (threeD) {
      projectionDirty = true;
      draft = preview;
      projectionVersion += 1;
      if (context) canvas.dataset.renderState = mode === 'rotate' ? 'rendering' : 'paused';
    }
    if (pending !== null) return;
    pending = window.requestAnimationFrame(() => {
      pending = null;
      if (viewLife.signal.aborted) return;
      if (mprDirty) {
        mprDirty = false;
        try {
          for (const slice of slices) slice.draw();
        } catch {
          unavailable('Slice rendering is unavailable in this browser.');
          return;
        }
      }
      if (!context) return;
      if (mode !== 'rotate') {
        projectionDirty = false;
        projectionJob = null;
        canvas.dataset.renderState = 'paused';
        return;
      }
      try {
        if (projectionDirty) {
          const active = activeProjectionVolume();
          const activeNative = gridIsNative(active, series);
          const full = activeNative && projectionMode !== 'preview';
          const renderedMode = full ? projectionMode : 'preview';
          const animated = !full && Boolean(pointers.size || draft);
          const raster = full ? rasterTarget(true) : {width: IDLE_PREVIEW_RASTER, requested: IDLE_PREVIEW_RASTER};
          const size = full ? raster.width : (animated ? previewRaster() : IDLE_PREVIEW_RASTER);
          const preview = !full;
          const signature = projectionSignature(preview, size);
          if (projectionJob && projectionJob.signature === signature) {
            // The running frame already covers the newest request. Mark it as latest
            // rather than discarding the work or rendering the same pixels again.
            projectionJob.version = projectionVersion;
            projectionJob.mode = renderedMode;
            projectionDirty = false;
          } else if (lastRenderedSignature === signature) {
            // A stale full frame may still be running; the canvas already matches.
            projectionJob = null;
            projectionDirty = false;
            updateProjectionSurface({mode: renderedMode, preview, raster, options: {width: size, height: size}});
            canvas.dataset.renderState = lastRenderedPreview && lastRenderedAnimated ? 'preview' : 'ready';
          } else if (!projectionJob || projectionJob.preview !== preview || projectionJob.animated !== animated) {
            // Switch quality immediately, but complete a moving frame at the selected
            // quality before taking the most recent camera state.
            projectionDirty = false;
            updateZoom();
            if (projectionPixels?.width !== size) projectionPixels = context.createImageData(size, size);
            projectionJob = {row: 0, preview, animated, mode: renderedMode, version: projectionVersion,
              raster, signature,
              options: {...state, width: size, height: size,
                // A native frame keeps one subpixel per ray; the full source grid still
                // supplies every MIP sample along the ray. Preview frames stay tiny.
                maxSubpixels: preview ? 1 : (activeNative ? 1 : 2), pixels: projectionPixels.data}};
          }
        }
        if (!projectionJob) return;
        const {options} = projectionJob;
        const deadline = window.performance.now() + 10;
        try {
          do {
            const startRow = projectionJob.row;
            // Keep each scheduled slice of rows small enough that a large device-pixel
            // raster cannot monopolise the main thread between animation frames.
            const rows = Math.max(1, Math.min(8, Math.floor(16384 / options.width)));
            projectionJob.row = Math.min(options.height, startRow + rows);
            project(activeProjectionVolume(), {...options, startRow, endRow: projectionJob.row});
          } while (projectionJob.row < options.height && window.performance.now() < deadline);
        } catch {
          projectionUnavailable();
          return;
        }
        if (projectionJob.row < options.height) {
          schedule();
        } else {
          const finished = projectionJob;
          projectionJob = null;
          if (canvas.width !== options.width) canvas.width = canvas.height = options.width;
          context.putImageData(projectionPixels, 0, 0);
          lastRenderedRaster = options.width;
          lastRenderedSignature = finished.signature;
          lastRenderedPreview = finished.preview;
          lastRenderedAnimated = finished.animated;
          const latest = finished.version === projectionVersion && !projectionDirty;
          // Publish what is actually on the canvas, but only call it ready when it
          // also represents the newest requested state.
          updateProjectionSurface(finished);
          canvas.dataset.renderState = latest
            ? (finished.preview && finished.animated ? 'preview' : 'ready')
            : 'rendering';
          if (!latest) schedule();
        }
      } catch {
        projectionUnavailable();
      }
    });
  }

  function syncProjectionButtons() {
    fullCurrentButton.setAttribute('aria-pressed', String(projectionMode === 'current'));
    fullStickyButton.setAttribute('aria-pressed', String(projectionMode === 'sticky'));
    restorePreviewButton.setAttribute('aria-pressed', String(projectionMode === 'preview'));
    projection.dataset.projectionMode = projectionMode;
  }

  function cancelProjectionUpgrade() {
    const attempt = upgradeAttempt;
    if (!attempt || attempt.cancelled || !attempt.projection) return;
    attempt.cancelled = true;
    attempt.controller.abort();
    restoreUpgrade('', true);
  }

  function cancelAnyUpgrade() {
    const attempt = upgradeAttempt;
    if (!attempt || attempt.cancelled) return;
    attempt.cancelled = true;
    attempt.controller.abort();
    restoreUpgrade('', true);
  }

  function requestNativeSource() {
    if (nativeQuality || !resolutionPending || viewLife.signal.aborted || upgradeAttempt) return;
    beginUpgrade('native', {projection: true});
  }

  function cancelQuickRemount() {
    window.clearTimeout(quickRemountTimer);
    quickRemountTimer = null;
    quickRemountPending = false;
  }

  function setProjectionQuick(next) {
    if (projectionQuick === next) return;
    projectionQuick = next;
    projectionSourceSerial += 1;
    projectionJob = null;
    projectionDirty = true;
    projectionVersion += 1;
    if (context) canvas.dataset.renderState = mode === 'rotate' ? 'rendering' : 'paused';
  }

  function finishQuickSwitch() {
    if (viewLife.signal.aborted || pointers.size > 0 || controlDragging) return;
    if (!quickRemountPending) return;
    window.clearTimeout(quickRemountTimer);
    quickRemountTimer = null;
    if (volume === quickVolume) {
      quickRemountPending = false;
      setProjectionQuick(false);
      schedule(false, true);
      return;
    }
    quickRemountPending = false;
    switchTo?.(quickVolume, {projectionMode: 'preview'});
  }

  function scheduleQuickRemount(delay) {
    window.clearTimeout(quickRemountTimer);
    quickRemountTimer = window.setTimeout(() => {
      quickRemountTimer = null;
      finishQuickSwitch();
    }, delay);
  }

  // The one-shot Full-size current view is native only for the pose it was requested
  // at. As soon as the camera, threshold, or window actually changes, projection frames
  // use the cached quick volume. A DOM remount waits for a pointer release, a committed
  // control change, or an idle wheel/key pause so the active input keeps its capture.
  function beginQuickProjection(reason = 'change') {
    if (projectionMode !== 'current') return;
    if (volume === quickVolume) {
      setProjectionMode('preview', {render: false});
      return;
    }
    if (!quickRemountPending) {
      quickRemountPending = true;
      setProjectionQuick(true);
      cancelProjectionUpgrade();
      projectionMode = 'preview';
      syncProjectionButtons();
    }
    window.clearTimeout(quickRemountTimer);
    quickRemountTimer = null;
    if (reason === 'pointer') return;
    if (reason === 'control') {
      // The committed change event remounts immediately. A slow fallback also covers
      // programmatic input while the drag guard above prevents a mid-drag remount.
      scheduleQuickRemount(700);
      return;
    }
    scheduleQuickRemount(reason === 'wheel' ? 160 : reason === 'key' ? 220 : 0);
  }

  function restorePreview() {
    cancelAnyUpgrade();
    cancelQuickRemount();
    setProjectionQuick(false);
    projectionMode = 'preview';
    syncProjectionButtons();
    if (volume !== quickVolume && quickVolume) {
      // Explicitly requested: remount the cached quick volume on the tap itself.
      switchTo?.(quickVolume, {projectionMode: 'preview'});
    } else {
      schedule(false, true);
    }
  }

  function setProjectionMode(next, {render = true} = {}) {
    if (!PROJECTION_MODES.has(next)) return;
    if (next !== 'preview' && !context) next = 'preview';
    // A full-size choice keeps the native source on screen and abandons a deferred
    // quick remount that was waiting for the previous one-shot gesture to finish.
    if (next !== 'preview') {
      cancelQuickRemount();
      setProjectionQuick(false);
    }
    const changed = next !== projectionMode;
    projectionMode = next;
    syncProjectionButtons();
    if (next === 'preview') cancelProjectionUpgrade();
    else requestNativeSource();
    if (render && changed) schedule(false, true);
  }

  function projectionChanged(reason = 'change') {
    if (projectionMode === 'current') beginQuickProjection(reason);
    else if (quickRemountPending && (reason === 'wheel' || reason === 'key')) {
      scheduleQuickRemount(reason === 'wheel' ? 160 : 220);
    }
  }

  function upgradeButtons(waiting = false) {
    loadAllButton.hidden = !skippedSections;
    loadNativeButton.hidden = !resolutionPending;
    if (!skippedSections && !resolutionPending) {
      loadAllButton.hidden = true;
      loadNativeButton.hidden = true;
    }
    loadAllButton.disabled = waiting;
    loadNativeButton.disabled = waiting;
  }

  function restoreUpgrade(message, waiting = false) {
    if (!hasUpgrade) return;
    upgradeNote.textContent = message || quickSummary;
    upgradeButtons(waiting);
    cancelAllButton.hidden = true;
    cancelAllButton.disabled = false;
    upgradeProgress.hidden = true;
  }

  function beginUpgrade(kind, {projection = false} = {}) {
    if (upgradeAttempt) return;
    if (kind === 'depth' && !skippedSections) return;
    if (kind === 'native' && !resolutionPending) return;
    const attempt = {controller: new AbortController(), cancelled: false, kind, projection};
    upgradeAttempt = attempt;
    loadAllButton.hidden = true;
    loadNativeButton.hidden = true;
    cancelAllButton.hidden = false;
    cancelAllButton.textContent = kind === 'native' ? 'Cancel loading full resolution' : 'Cancel loading all sections';
    upgradeProgress.hidden = false;
    upgradeProgress.max = kind === 'native' ? sourceDimensions[2] : totalSections;
    upgradeProgress.value = 0;
    upgradeProgress.setAttribute('aria-label', kind === 'native' ? 'Loading full resolution' : 'Loading all sections');
    upgradeNote.textContent = kind === 'native'
      ? `Loading full resolution (0 of ${sourceDimensions[2]})…`
      : `Loading all sections (0 of ${totalSections})…`;
    const options = kind === 'native' ? {nativeResolution: true} : {fullDepth: true};
    const cached = kind === 'native' ? cachedNative() : null;
    const request = cached ? Promise.resolve(cached) : build(series, loadFrame, {
      ...options,
      signal: attempt.controller.signal,
      onProgress(done, total) {
        if (attempt.cancelled || attempt !== upgradeAttempt || viewLife.signal.aborted) return;
        const fallback = kind === 'native' ? sourceDimensions[2] : totalSections;
        const maximum = Number.isFinite(total) && total > 0 ? total : fallback;
        upgradeProgress.max = maximum;
        upgradeProgress.value = done;
        upgradeNote.textContent = kind === 'native'
          ? `Loading full resolution (${done} of ${maximum})…`
          : `Loading all sections (${done} of ${maximum})…`;
      },
    });
    void request.then(full => {
      if (attempt.cancelled || attempt !== upgradeAttempt || viewLife.signal.aborted
        || attempt.controller.signal.aborted) return;
      if (!full || !validDimensions(full.dimensions)) {
        throw new Error('The upgraded volume has invalid dimensions.');
      }
      if (kind === 'depth' && full.dimensions[2] !== totalSections) {
        throw new Error('The full stack was not loaded at its expected depth.');
      }
      if (kind === 'native') {
        const nextSource = sourceGrid(full, series);
        if (!full.dimensions.every((size, axis) => size === nextSource[axis])) {
          throw new Error('The renderer did not return the exact source grid.');
        }
        rememberNative(full);
      }
      upgradeAttempt = null;
      switchTo?.(full);
    }).catch(error => {
      if (attempt !== upgradeAttempt || viewLife.signal.aborted) return;
      if (attempt.cancelled || attempt.controller.signal.aborted || aborted(null, error)) return;
      const returnToPreview = projectionMode !== 'preview';
      upgradeAttempt = null;
      if (returnToPreview) setProjectionMode('preview', {render: false});
      const reason = error?.message ? ` ${error.message}` : '';
      if (kind === 'native') {
        const limit = nativeLimit(error)
          ? 'Full resolution is unavailable within the volume memory limit.'
          : 'Loading full resolution failed.';
        restoreUpgrade(`${limit}${reason} Showing ${dimensions.join(' × ')} voxels.`);
      } else {
        restoreUpgrade(`Loading all sections failed.${reason} Showing ${dimensions[2]} of ${totalSections} sections.`);
      }
      if (returnToPreview) schedule(false, true);
    }).finally(() => {
      if (attempt !== upgradeAttempt) return;
      upgradeAttempt = null;
      upgradeButtons(false);
      if (projectionMode !== 'preview' && !nativeQuality) requestNativeSource();
    });
  }

  on(loadAllButton, 'click', () => beginUpgrade('depth'));
  on(loadNativeButton, 'click', () => beginUpgrade('native'));
  on(cancelAllButton, 'click', () => {
    const attempt = upgradeAttempt;
    if (!attempt || attempt.cancelled) return;
    attempt.cancelled = true;
    attempt.controller.abort();
    const returnToPreview = projectionMode !== 'preview';
    if (returnToPreview) setProjectionMode('preview', {render: false});
    const label = attempt.kind === 'native' ? 'full resolution' : 'all sections';
    restoreUpgrade(`Loading ${label} canceled. Showing ${dimensions[2]} of ${totalSections} sections.`, true);
    if (returnToPreview) schedule(false, true);
  });
  on(fullCurrentButton, 'click', () => setProjectionMode('current'));
  on(fullStickyButton, 'click', () => setProjectionMode('sticky'));
  on(restorePreviewButton, 'click', () => restorePreview());

  function control(label, key, low, high, mpr, step = 'any') {
    const input = body.querySelector(`input[aria-label="${label}"]`);
    const output = input.parentElement.querySelector('output');
    input.min = low;
    input.max = high;
    input.step = step;
    input.disabled = !(high > low);
    const display = () => {
      input.value = state[key];
      output.value = format(state[key]);
    };
    display();
    on(input, 'input', () => {
      const before = state[key];
      state[key] = Number(input.value);
      output.value = format(state[key]);
      if (state[key] !== before) projectionChanged('control');
      schedule(mpr, true, true);
    });
    // Settle on the small idle raster after the control stops changing, even when
    // the source volume is already at native resolution.
    on(input, 'change', () => {
      schedule(mpr, true);
      finishQuickSwitch();
    });
    // A range drag keeps its implicit pointer capture until release. Defer the quick
    // source remount until then so the thumb cannot disappear mid-drag.
    on(input, 'pointerdown', () => { controlDragging = input; });
    const endControlDrag = () => {
      if (controlDragging !== input) return;
      controlDragging = null;
      finishQuickSwitch();
    };
    on(input, 'pointerup', endControlDrag);
    on(input, 'pointercancel', endControlDrag);
    on(window, 'pointerup', endControlDrag, {passive: true});
    on(window, 'pointercancel', endControlDrag, {passive: true});
    return display;
  }

  const span = Math.max(max - min, state.widthWindow);
  control('Window level', 'center', Math.min(min, state.center - span / 2), Math.max(max, state.center + span / 2), true);
  control('Window width', 'widthWindow', 1, span * 2, true);
  control('3D threshold', 'threshold', Math.min(min, state.threshold), Math.max(max, state.threshold), false);
  const updateZoom = control('3D zoom', 'zoom', 0.5, 4, false, 0.01);

  const cameraState = () => `${state.yaw}|${state.pitch}|${state.zoom}`;
  const rotate = (yaw, pitch) => {
    state.yaw = (state.yaw + yaw) % (2 * Math.PI);
    state.pitch = clamp(state.pitch + pitch, -Math.PI / 2, Math.PI / 2);
  };
  const zoomBy = factor => { state.zoom = clamp(state.zoom * factor, 0.5, 4); };
  const reset = (reason = 'button') => {
    const before = cameraState();
    Object.assign(state, ORIGINAL_CAMERA);
    if (cameraState() !== before) projectionChanged(reason);
    schedule(false, true);
  };
  on(projection.querySelector('.pdv-reset'), 'click', () => reset('button'));
  on(canvas, 'keydown', event => {
    const before = cameraState();
    switch (event.key) {
      case 'ArrowLeft': rotate(-0.15, 0); break;
      case 'ArrowRight': rotate(0.15, 0); break;
      case 'ArrowUp': rotate(0, -0.15); break;
      case 'ArrowDown': rotate(0, 0.15); break;
      case '+': case '=': zoomBy(1.12); break;
      case '-': zoomBy(1 / 1.12); break;
      case 'Home': reset('key'); break;
      default: return;
    }
    event.preventDefault();
    if (cameraState() !== before) projectionChanged('key');
    schedule(false, true);
  });
  on(canvas, 'wheel', event => {
    event.preventDefault();
    const before = cameraState();
    const delta = event.deltaY * (event.deltaMode ? 16 : 1);
    zoomBy(Math.exp(clamp(-delta * 0.002, -1, 1)));
    if (cameraState() !== before) projectionChanged('wheel');
    schedule(false, true, true);
    window.clearTimeout(refineTimer);
    refineTimer = null;
    // Only the default preview needs a separate idle frame after the wheel stops.
    if (projectionMode === 'preview') {
      refineTimer = window.setTimeout(() => schedule(false, true), 130);
    }
  }, {passive: false});
  on(canvas, 'pointerdown', event => {
    if (event.button !== 0 || pointers.size >= 2) return;
    window.clearTimeout(refineTimer);
    canvas.setPointerCapture(event.pointerId);
    pointers.set(event.pointerId, [event.clientX, event.clientY]);
  });
  on(canvas, 'pointermove', event => {
    const old = pointers.get(event.pointerId);
    if (!old) return;
    const before = cameraState();
    const x = event.clientX, y = event.clientY;
    if (pointers.size === 1) {
      rotate((x - old[0]) * 0.012, (y - old[1]) * 0.012);
    } else {
      const other = [...pointers].find(([id]) => id !== event.pointerId)[1];
      const was = Math.hypot(old[0] - other[0], old[1] - other[1]);
      if (was >= 1) zoomBy(Math.hypot(x - other[0], y - other[1]) / was);
    }
    pointers.set(event.pointerId, [x, y]);
    if (cameraState() !== before) projectionChanged('pointer');
    schedule(false, true, true);
  });
  const releasePointer = event => {
    if (!pointers.delete(event.pointerId)) return;
    // Settle at the intended raster once every gesture pointer is gone, even if
    // pointerup arrives without a follow-up lostpointercapture event.
    if (pointers.size === 0 && quickRemountPending) {
      finishQuickSwitch();
      return;
    }
    schedule(false, true, pointers.size > 0);
  };
  on(canvas, 'pointerup', releasePointer);
  on(canvas, 'pointercancel', releasePointer);
  on(canvas, 'lostpointercapture', releasePointer);

  const resizeObserver = typeof window.ResizeObserver === 'function'
    ? new window.ResizeObserver(() => queueRasterRefresh())
    : null;
  resizeObserver?.observe(canvas.parentElement || stage);
  on(window, 'resize', queueRasterRefresh, {passive: true});

  function focusTarget() {
    if (mode === 'sections' && narrow) return planeButtons[selectedPlane];
    return modeButtons.find(button => button.dataset.mode === mode && !button.disabled) ||
      modeButtons.find(button => !button.disabled);
  }

  function ensureFocus(active = body.getRootNode().activeElement) {
    if (!active || !active.closest?.('[hidden]')) return;
    focusTarget()?.focus({preventScroll: true});
  }

  function updatePlaneVisibility(active = body.getRootNode().activeElement) {
    planeTabs.hidden = !narrow;
    slices.forEach((slice, index) => {
      slice.box.hidden = mode !== 'sections' || (narrow && index !== selectedPlane);
    });
    planeButtons.forEach((button, index) => {
      button.setAttribute('aria-pressed', String(index === selectedPlane));
    });
    ensureFocus(active);
  }

  function setMode(next) {
    if (next === 'rotate' && !context) return;
    if (mode === next) return;
    const active = body.getRootNode().activeElement;
    mode = next;
    if (next === 'sections' && quickRemountPending) {
      restorePreview();
      return;
    }
    rotatePanel.hidden = mode !== 'rotate';
    sectionsPanel.hidden = mode !== 'sections';
    for (const button of modeButtons) {
      button.setAttribute('aria-pressed', String(button.dataset.mode === mode));
    }
    if (mode === 'sections') {
      if (projectionJob) {
        projectionJob = null;
        canvas.dataset.renderState = 'paused';
      }
      updatePlaneVisibility(active);
      schedule(true);
    } else {
      updatePlaneVisibility(active);
      schedule(false, true);
    }
    ensureFocus(active);
  }

  for (const button of modeButtons) {
    on(button, 'click', () => setMode(button.dataset.mode));
  }
  layoutMedia?.addEventListener('change', () => {
    narrow = layoutMedia.matches;
    updatePlaneVisibility();
    if (mode === 'sections') schedule(true);
  }, {signal: viewLife.signal});

  if (mode === 'sections') {
    rotatePanel.hidden = true;
    sectionsPanel.hidden = false;
    for (const button of modeButtons) {
      button.setAttribute('aria-pressed', String(button.dataset.mode === mode));
    }
  }
  updatePlaneVisibility();
  syncProjectionButtons();
  if (context) {
    if (mode === 'rotate') schedule(true, true);
    else schedule(true);
    if (projectionMode !== 'preview' && !nativeQuality) requestNativeSource();
    // A source switch triggered by an active pointer or control can remount the panel.
    // Carry focus back so keyboard rotation and a committed range control keep working.
    if (carry?.focus === 'projection' && !rotatePanel.hidden) {
      canvas.focus({preventScroll: true});
    } else if (carry?.focus) {
      const target = [...body.querySelectorAll('[aria-label]')]
        .find(node => node.getAttribute('aria-label') === carry.focus);
      target?.focus?.({preventScroll: true});
    }
  } else {
    projectionUnavailable();
  }

  const capture = () => {
    const active = body.getRootNode().activeElement;
    const focus = active === canvas ? 'projection'
      : active && active !== body ? (active.getAttribute?.('aria-label') || '') : '';
    return {
      mode,
      selectedPlane,
      projectionMode,
      center: state.center,
      widthWindow: state.widthWindow,
      threshold: state.threshold,
      yaw: state.yaw,
      pitch: state.pitch,
      zoom: state.zoom,
      cursor: [...cursor],
      focus,
      settingsOpen: settings.open,
      panels: {
        projection: {width: projection.style.cssText, height: stage.style.cssText},
        slices: slices.map(({box}) => {
          const sliceStage = box.querySelector('.pdv-stage');
          return {width: box.style.cssText, height: sliceStage?.style.cssText || ''};
        }),
      },
    };
  };

  const cleanup = () => {
    if (viewLife.signal.aborted) return;
    viewLife.abort();
    const attempt = upgradeAttempt;
    upgradeAttempt = null;
    attempt?.controller.abort();
    if (pending !== null) window.cancelAnimationFrame(pending);
    window.clearTimeout(refineTimer);
    window.clearTimeout(resizeTimer);
    window.clearTimeout(quickRemountTimer);
    quickRemountTimer = null;
    quickRemountPending = false;
    controlDragging = null;
    projectionJob = null;
    projectionPixels = undefined;
    resizeObserver?.disconnect();
    for (const item of body.querySelectorAll('canvas')) item.width = item.height = 1;
  };
  return {cleanup, capture};
}
