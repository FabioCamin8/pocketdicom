export function normalizeNote(value) {
  if (typeof value !== 'string') return '';
  return Array.from(value.replace(/[\s\x00-\x1f\x7f-\x9f]+/gu, ' ').trim()).slice(0, 64).join('');
}
