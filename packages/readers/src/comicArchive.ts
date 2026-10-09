import { ReaderError } from './readerI18n';
import { unzipSync } from 'fflate';
import { imageEntryNames } from './anchors';
export interface ComicPage { name: string; load: () => Promise<Blob> }
export interface ComicArchive { pages: ComicPage[]; close: () => void }
const MAX_ARCHIVE_BYTES = 150 * 1024 * 1024;
const MAX_PAGE_BYTES = 40 * 1024 * 1024;
const MAX_TOTAL_BYTES = 350 * 1024 * 1024;
const MAX_PAGES = 2500;
export async function openComicArchive(source: Blob, format: string): Promise<ComicArchive> {
  if (source.size > MAX_ARCHIVE_BYTES) throw new ReaderError('archiveTooLarge');
  if (format === 'CBZ') {
    let total = 0, count = 0;
    const files = unzipSync(new Uint8Array(await source.arrayBuffer()), { filter: entry => {
      if (!imageEntryNames([entry.name]).length) return false;
      total += entry.originalSize; count++;
      if (entry.originalSize > MAX_PAGE_BYTES || total > MAX_TOTAL_BYTES || count > MAX_PAGES) throw new ReaderError('archiveLimit');
      return true;
    } });
    const pages = imageEntryNames(Object.keys(files)).map(name => ({ name, load: async () => new Blob([files[name] as Uint8Array<ArrayBuffer>], { type: imageMime(name) }) }));
    if (!pages.length) throw new ReaderError('archiveNoImages');
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
    if (await archive.hasEncryptedData()) throw new ReaderError('archiveEncrypted');
    const entries = await archive.getFilesArray();
    const map = new Map(entries.map(entry => [`${entry.path ?? ''}${entry.file.name}`, entry.file]));
    const names = imageEntryNames([...map.keys()]);
    if (!names.length) throw new ReaderError('archiveVariant');
    if (names.length > MAX_PAGES || names.some(name => map.get(name).size > MAX_PAGE_BYTES)) throw new ReaderError('archiveLimit');
    return { pages: names.map(name => ({ name, load: () => map.get(name).extract() as Promise<Blob> })), close: () => { void archive?.close(); URL.revokeObjectURL(workerUrl); } };
  } catch (error) { void archive?.close(); URL.revokeObjectURL(workerUrl); throw error; }
}
function imageMime(name: string) {
  const extension = name.split('.').at(-1)?.toLowerCase();
  return extension === 'jpg' || extension === 'jpeg' ? 'image/jpeg' : `image/${extension}`;
}
