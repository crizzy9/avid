import { describe, expect, it } from 'vitest';
import { publicationSource } from './publicationSource';
describe('ebook source normalization', () => {
  it('gives authenticated downloaded Blobs the filename required by format sniffing', async () => {
    const result = publicationSource(new Blob(['bytes'], { type: 'application/epub+zip' }), 'server-book.epub', 'EPUB') as File;
    expect(result.name).toBe('server-book.epub'); expect(result.type).toBe('application/epub+zip'); expect(await result.text()).toBe('bytes');
  });
  it('retains explicit File and URL inputs', () => {
    const file = new File(['bytes'], 'book.mobi');
    expect(publicationSource(file, '', 'MOBI')).toBe(file);
    expect(publicationSource('https://books.example/book.epub', '', 'EPUB')).toBe('https://books.example/book.epub');
  });
});
