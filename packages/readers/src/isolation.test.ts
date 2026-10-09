// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { sanitizeBookDocument, BOOK_CSP } from './isolation';
import * as CFI from '../vendor/foliate/epubcfi.js';
import { createDemoEpub } from './demo';
import { unzipSync, strFromU8 } from 'fflate';
describe('untrusted publication boundary', () => {
  it('removes executable and embedded content before iframe navigation', () => {
    const html = sanitizeBookDocument('<html><head><base href="https://evil.test/"><meta http-equiv="refresh" content="0;url=https://evil.test/"></head><body onload="steal()"><script>parent.evil=1</script><iframe src="https://evil.test"></iframe><object data="x"></object><a href="javascript:steal()">word</a><p onclick="steal()">Safe passage</p></body></html>');
    const doc = new DOMParser().parseFromString(html, 'text/html');
    expect(doc.querySelector('script,iframe,object,base,[onclick],[onload]')).toBeNull();
    expect(doc.querySelector('a')?.hasAttribute('href')).toBe(false);
    expect(doc.querySelector('meta')?.getAttribute('content')).toBe(BOOK_CSP);
    expect(doc.body.textContent).toContain('Safe passage');
    expect(BOOK_CSP).toContain("script-src 'none'");
    expect(BOOK_CSP).toContain("connect-src 'none'");
  });
  it('keeps EPUB CFIs on the same text after typography changes', () => {
    const doc = new DOMParser().parseFromString(sanitizeBookDocument('<html><head></head><body><p>A remembered sentence remains here.</p></body></html>'), 'text/html');
    const text = doc.querySelector('p')!.firstChild!;
    const range = doc.createRange(); range.setStart(text, 2); range.setEnd(text, 21);
    const cfi = CFI.fromRange(range);
    doc.body.style.fontSize = '32px'; doc.body.style.lineHeight = '2';
    const restored = CFI.toRange(doc, CFI.parse(cfi));
    expect(restored.toString()).toBe(range.toString());
  });
  it('builds an actual EPUB container containing clearly labeled original content', async () => {
    const file = createDemoEpub();
    const bytes = await new Promise<ArrayBuffer>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result as ArrayBuffer); reader.onerror = reject; reader.readAsArrayBuffer(file); });
    const entries = unzipSync(new Uint8Array(bytes));
    expect(strFromU8(entries.mimetype!)).toBe('application/epub+zip');
    expect(strFromU8(entries['book.opf']!)).toContain('avid-original-demo');
    expect(strFromU8(entries['c0.xhtml']!)).toContain('not an excerpt from the library title');
  });
});
