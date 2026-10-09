import { describe, expect, it } from 'vitest';
import { zipSync } from 'fflate';
import { openComicArchive } from './comicArchive';
describe('comic archive adapter', () => {
  it('extracts actual image bytes in natural page order', async () => {
    const bytes = zipSync({ 'page10.jpg': new Uint8Array([10]), 'page2.png': new Uint8Array([2]), 'page1.jpg': new Uint8Array([1]), 'metadata.txt': new Uint8Array([99]) });
    const archive = await openComicArchive(new Blob([bytes as Uint8Array<ArrayBuffer>]), 'CBZ');
    expect(archive.pages.map(page => page.name)).toEqual(['page1.jpg', 'page2.png', 'page10.jpg']);
    expect([...new Uint8Array(await (await archive.pages[1]!.load()).arrayBuffer())]).toEqual([2]);
    archive.close();
  });
  it('rejects archives without image pages', async () => {
    const bytes = zipSync({ 'script.js': new Uint8Array([1]) });
    await expect(openComicArchive(new Blob([bytes as Uint8Array<ArrayBuffer>]), 'CBZ')).rejects.toThrow('No supported image');
  });
});
