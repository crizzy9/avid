import { describe, expect, it } from 'vitest';
import { clamp, detectContentBounds, imageEntryNames, pageLocator, parsePageAnchor, spreadPages } from './anchors';
describe('publication anchors', () => {
  it('restores a deliberate backward seek and within-page offset', () => {
    expect(parsePageAnchor(pageLocator(4, .72), 120)).toEqual({ page: 4, offset: .72 });
    expect(parsePageAnchor(pageLocator(2, .15), 120)).toEqual({ page: 2, offset: .15 });
  });
  it('bounds malformed or stale locators to the current edition', () => {
    expect(parsePageAnchor('{bad', 4)).toEqual({ page: 1, offset: 0 });
    expect(parsePageAnchor('{"page":999,"offset":4}', 4)).toEqual({ page: 4, offset: 1 });
    expect(parsePageAnchor('{"page":-3,"offset":-2}', 4)).toEqual({ page: 1, offset: 0 });
    expect(clamp(NaN)).toBe(0);
  });
  it('orders comic pages naturally and excludes hidden metadata', () => {
    expect(imageEntryNames(['10.png', '2.jpg', '__MACOSX/3.jpg', '.thumbs/1.png', 'notes.txt', '1.webp'])).toEqual(['1.webp', '2.jpg', '10.png']);
  });
  it('preserves a separate cover and handles final odd spreads', () => {
    expect(spreadPages(1, 6)).toEqual([1]);
    expect(spreadPages(3, 6)).toEqual([2, 3]);
    expect(spreadPages(6, 6)).toEqual([6]);
    expect(spreadPages(4, 5)).toEqual([4, 5]);
  });
  it('detects non-white PDF content while leaving blank pages intact', () => {
    const pixels = new Uint8ClampedArray(100 * 100 * 4).fill(255);
    expect(detectContentBounds(pixels, 100, 100)).toEqual({ left: 0, right: 0, top: 0, bottom: 0 });
    for (let y = 20; y < 80; y++) for (let x = 10; x < 90; x++) pixels[(y * 100 + x) * 4] = 0;
    const bounds = detectContentBounds(pixels, 100, 100);
    expect(bounds.left).toBeCloseTo(.08); expect(bounds.top).toBeCloseTo(.18);
  });
});
