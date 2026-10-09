// @vitest-environment jsdom
import { File as NodeFile } from 'node:buffer';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { unzlibSync } from 'fflate';
import { MOBI, isMOBI } from '../vendor/foliate/mobi.js';
describe('original MOBI6 publication', () => {
  it('parses a real PalmDB/MOBI file with byte-offset chapter navigation', async () => {
    const bytes = await readFile('packages/readers/fixtures/sample.mobi');
    const file = new NodeFile([bytes], 'original.mobi');
    expect(await isMOBI(file as unknown as Blob)).toBe(true);
    const book = await new MOBI({ unzlib: unzlibSync }).open(file);
    expect(book.metadata.title).toBe('A Quiet Hour - Avid MOBI fixture');
    expect(book.sections).toHaveLength(3);
    const chapter = await book.sections[1].createDocument();
    expect(chapter.body.textContent).toContain('The reading room was quiet');
    expect(book.toc).toHaveLength(2);
    const second = book.resolveHref(book.toc[1].href);
    expect(second.index).toBe(2);
    expect((await book.sections[second.index].createDocument()).body.textContent).toContain('Mara chose the path');
  });
  it('rejects DRM flags before attempting to render protected content', async () => {
    const bytes = await readFile('packages/readers/fixtures/sample.mobi');
    bytes.writeUInt16BE(2, bytes.readUInt32BE(78) + 12);
    await expect(new MOBI({ unzlib: unzlibSync }).open(new NodeFile([bytes], 'protected.mobi'))).rejects.toThrow('DRM-protected');
  });
});
