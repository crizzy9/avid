export interface PageAnchor { page: number; offset: number }
export function clamp(value: number, min = 0, max = 1) {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : min;
}
export function parsePageAnchor(locator: string | undefined, pageCount: number): PageAnchor {
  try {
    const value = JSON.parse(locator || '{}') as Partial<PageAnchor>;
    return { page: Math.floor(clamp(Number(value.page) || 1, 1, Math.max(pageCount, 1))), offset: clamp(Number(value.offset) || 0) };
  } catch { return { page: 1, offset: 0 }; }
}
export function pageLocator(page: number, offset = 0) { return JSON.stringify({ page, offset: clamp(offset) }); }
export function imageEntryNames(names: string[]): string[] {
  return names.filter(name => !name.startsWith('__MACOSX/') && !name.split('/').some(part => part.startsWith('.')) && /\.(jpe?g|png|webp|gif|avif|bmp)$/i.test(name))
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' }));
}
export function spreadPages(page: number, count: number): number[] {
  if (page <= 1) return count ? [1] : [];
  const first = page % 2 === 0 ? page : page - 1;
  return first + 1 <= count ? [first, first + 1] : [first];
}
export function detectContentBounds(data: Uint8ClampedArray, width: number, height: number) {
  let left = width, right = 0, top = height, bottom = 0;
  const step = Math.max(1, Math.floor(Math.min(width, height) / 800));
  for (let y = 0; y < height; y += step) for (let x = 0; x < width; x += step) {
    const index = (y * width + x) * 4;
    if (data[index + 3]! > 30 && Math.min(data[index]!, data[index + 1]!, data[index + 2]!) < 220) {
      left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
    }
  }
  if (left > right || top > bottom) return { left: 0, right: 0, top: 0, bottom: 0 };
  const padding = .02;
  return { left: clamp(left / width - padding, 0, .4), right: clamp(1 - right / width - padding, 0, .4), top: clamp(top / height - padding, 0, .4), bottom: clamp(1 - bottom / height - padding, 0, .4) };
}
