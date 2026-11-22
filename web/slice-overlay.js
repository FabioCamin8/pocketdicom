export function drawSourceOverlays(raster, entries) {
  if (!entries.length) return;
  const context = raster.getContext('2d');
  context.save();
  context.fillStyle = '#ffcb57';
  context.globalAlpha = 0.85;
  for (const entry of entries) {
    if (!entry) continue;
    const { x, y, width, height, mask } = entry;
    const bits = width * height;
    if (![x, y, width, height, bits, x + width, y + height].every(Number.isSafeInteger) ||
        width <= 0 || height <= 0 || typeof mask !== 'string') continue;
    const left = Math.max(0, x), right = Math.min(raster.width, x + width);
    const top = Math.max(0, y), bottom = Math.min(raster.height, y + height);
    const bytes = Math.ceil(bits / 8);
    if (left >= right || top >= bottom || mask.length !== Math.ceil(bytes / 3) * 4) continue;
    let data;
    try { data = atob(mask); } catch { continue; }
    if (data.length !== bytes) continue;
    for (let row = top; row < bottom; row++) {
      let bit = (row - y) * width + left - x;
      let run = -1;
      for (let col = left; col < right; col++, bit++) {
        if (data.charCodeAt(Math.floor(bit / 8)) & (1 << (bit % 8))) {
          if (run < 0) run = col;
        } else if (run >= 0) {
          context.fillRect(run, row, col - run, 1);
          run = -1;
        }
      }
      if (run >= 0) context.fillRect(run, row, right - run, 1);
    }
  }
  context.restore();
}
