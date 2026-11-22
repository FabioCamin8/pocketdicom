export function volumeWindow(center, width, invert) {
  const range = Math.max(1, width) - 1;
  const midpoint = center - 0.5;
  return value => {
    const level = range ? Math.min(1, Math.max(0, 0.5 + (value - midpoint) / range))
      : Number(value > midpoint);
    const gray = Math.round(level * 255);
    return invert ? 255 - gray : gray;
  };
}
