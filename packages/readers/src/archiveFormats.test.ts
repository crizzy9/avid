import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
// Node and browser builds execute the same libarchive WASM decoder.
// @ts-expect-error Upstream does not ship declarations for its Node build.
import { Archive } from 'libarchive.js/dist/libarchive-node.mjs';
describe('real comic format fixtures', () => {
  for (const extension of ['cbr', 'cb7']) it(`decodes the actual ${extension} fixture without converting it to ZIP`, async () => {
    const bytes = await readFile(new URL(`../fixtures/sample.${extension}`, import.meta.url));
    const archive = await Archive.open(new File([bytes], `sample.${extension}`));
    try {
      const entries = await archive.getFilesArray();
      expect(entries.map((entry: { file: File }) => entry.file.name)).toEqual(['page1.png', 'page2.png', 'page3.png']);
      const page = await entries[1].file.extract();
      expect([...new Uint8Array(await page.arrayBuffer()).slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    } finally { await archive.close(); }
  });
});
