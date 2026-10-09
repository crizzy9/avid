import { ReaderError } from './readerI18n';
import type { Book, BookFile, ReadingAnchor } from './contracts';
export function readerKindForFile(file: BookFile): ReadingAnchor['kind'] {
  return file.format === 'AUDIO' ? 'audio' : file.format === 'PDF' ? 'pdf' : ['CBZ', 'CBR', 'CB7'].includes(file.format) ? 'comic' : 'epub';
}
/** Fail closed on edition/file mismatches instead of applying an anchor to different bytes. */
export function chooseBookFile(book: Book, anchor?: Pick<ReadingAnchor, 'bookId' | 'fileId' | 'kind'>, mode: 'reading' | 'audio' = 'reading'): BookFile | undefined {
  const supportsMode = (file: BookFile) => mode === 'audio' ? file.format === 'AUDIO' : file.format !== 'AUDIO';
  if (anchor) {
    if (anchor.bookId !== book.id) throw new ReaderError('differentBook');
    const file = book.files.find(item => item.id === anchor.fileId);
    if (!file) throw new ReaderError('removedFile');
    if (!supportsMode(file) || readerKindForFile(file) !== anchor.kind) throw new ReaderError('wrongFormat');
    return file;
  }
  return book.files.find(file => supportsMode(file) && file.format === book.format) ?? book.files.find(supportsMode);
}
