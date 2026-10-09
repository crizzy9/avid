import { describe, expect, it } from 'vitest';
import { chooseBookFile, readerKindForFile } from './bookFile';
import type { Book } from './contracts';
const book: Book = { id: 'book', title: 'Multi-format', authors: [], description: '', format: 'EPUB', color: '#aaa', progress: 0, status: 'unread', genres: [], addedAt: '', files: [{ id: 'epub', name: 'book.epub', format: 'EPUB' }, { id: 'pdf', name: 'book.pdf', format: 'PDF' }, { id: 'audio1', name: 'first.mp3', format: 'AUDIO' }, { id: 'audio2', name: 'second.mp3', format: 'AUDIO' }] };
describe('file-identity-aware reading actions', () => {
  it('opens the exact file named by the saved anchor', () => {
    expect(chooseBookFile(book, { bookId: 'book', fileId: 'pdf', kind: 'pdf' })?.id).toBe('pdf');
    expect(chooseBookFile(book, { bookId: 'book', fileId: 'audio2', kind: 'audio' }, 'audio')?.id).toBe('audio2');
  });
  it('rejects removed editions, cross-book anchors, and locator-format mismatches', () => {
    expect(() => chooseBookFile(book, { bookId: 'book', fileId: 'removed', kind: 'epub' })).toThrow('no longer attached');
    expect(() => chooseBookFile(book, { bookId: 'other', fileId: 'epub', kind: 'epub' })).toThrow('different book');
    expect(() => chooseBookFile(book, { bookId: 'book', fileId: 'pdf', kind: 'epub' })).toThrow('does not match');
  });
  it('derives locator kind from the exact file, independent of book primary format', () => {
    expect(readerKindForFile(book.files[1]!)).toBe('pdf');
    expect(chooseBookFile(book)?.id).toBe('epub');
  });
});
