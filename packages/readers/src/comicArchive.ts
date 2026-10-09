import { unzipSync } from 'fflate';
import { imageEntryNames } from './anchors';
export interface ComicPage { name: string; load: () => Promise<Blob> }
export interface ComicArchive { pages: ComicPage[]; close: () => void }
const MAX_ARCHIVE_BYTES = 150 * 1024 * 1024;
const MAX_PAGE_BYTES = 40 * 1024 * 1024;
const MAX_TOTAL_BYTES = 350 * 1024 * 1024;
const MAX_PAGES = 2500;
export async function openComicArchive(source: Blob, format: string): Promise<ComicArchive> {
  if (source.size > MAX_ARCHIVE_BYTES) throw new Error('This archive exceeds the 150 MB browser limit. Split it into smaller volumes.');
  if (format === 'CBZ') {
    let total = 0, count = 0;
    const files = unzipSync(new Uint8Array(await source.arrayBuffer()), { filter: entry => {
      if (!imageEntryNames([entry.name]).length) return false;
      total += entry.originalSize; count++;
      if (entry.originalSize > MAX_PAGE_BYTES || total > MAX_TOTAL_BYTES || count > MAX_PAGES) throw new Error('Comic archive exceeds the safe browser extraction limit.');
      return true;
    } });
    const pages = imageEntryNames(Object.keys(files)).map(name => ({ name, load: async () => new Blob([files[name] as Uint8Array<ArrayBuffer>], { type: imageMime(name) }) }));
    if (!pages.length) throw new Error('No supported image pages were found in this archive.');
    return { pages, close: () => { for (const name of Object.keys(files)) delete files[name]; } };
  }
  const [{ Archive }, { default: workerSource }, { default: wasmUrl }] = await Promise.all([
    import('libarchive.js'), import('libarchive.js/dist/worker-bundle.js?raw'), import('libarchive.js/dist/libarchive.wasm?url'),
  ]);
  // Keep the worker self-contained while giving its WASM dependency a Vite-managed asset URL.
  const sourceCode = workerSource.replaceAll('"libarchive.wasm"', JSON.stringify(new URL(wasmUrl, location.href).href));
  const workerUrl = URL.createObjectURL(new Blob([sourceCode], { type: 'text/javascript' }));
  Archive.init({ getWorker: () => new Worker(workerUrl, { type: 'module' }) });
  let archive: Awaited<ReturnType<typeof Archive.open>> | undefined;
  try {
    archive = await Archive.open(new File([source], `book.${format.toLowerCase()}`));
    if (await archive.hasEncryptedData()) throw new Error('Password-protected comic archives are not supported.');
    const entries = await archive.getFilesArray();
    const map = new Map(entries.map(entry => [`${entry.path ?? ''}${entry.file.name}`, entry.file]));
    const names = imageEntryNames([...map.keys()]);
    if (!names.length) throw new Error('No image pages were found, or this archive variant is not supported by libarchive.');
    if (names.length > MAX_PAGES || names.some(name => map.get(name).size > MAX_PAGE_BYTES)) throw new Error('Comic archive exceeds the safe browser extraction limit.');
    return { pages: names.map(name => ({ name, load: () => map.get(name).extract() as Promise<Blob> })), close: () => { void archive?.close(); URL.revokeObjectURL(workerUrl); } };
  } catch (error) { void archive?.close(); URL.revokeObjectURL(workerUrl); throw error; }
}
function imageMime(name: string) {
  const extension = name.split('.').at(-1)?.toLowerCase();
  return extension === 'jpg' || extension === 'jpeg' ? 'image/jpeg' : `image/${extension}`;
}
