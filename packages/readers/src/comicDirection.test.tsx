// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Reader } from './Reader';
import { getComicDirectionMode, setComicDirectionMode, getMangaRule, setMangaRule, resolveComicDirection } from './comicDirection';
import type { Book } from '../../core/src/types';
vi.mock('./EbookView', () => ({ EbookView: () => null }));
vi.mock('./PdfView', () => ({ PdfView: () => null }));
vi.mock('./ComicView', () => ({ ComicView: ({ settings }: { settings: { direction: string } }) => <div data-comic-direction={settings.direction} /> }));
const book: Book = { id: 'one', title: 'An ordinary adventure', authors: [], description: '', format: 'CBZ', color: '', progress: 0, status: 'unread', genres: [], addedAt: '', files: [{ id: 'comic-file', name: 'comic.cbz', format: 'CBZ' }] };
beforeEach(() => { localStorage.clear(); Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); });
afterEach(() => document.body.replaceChildren());
describe('per-title comic direction and configurable manga rule', () => {
  it('defaults manga genres to RTL without classifying all comics or titles as manga', () => {
    expect(resolveComicDirection({ ...book, genres: ['Graphic novels', 'MANGA'] }, 'auto')).toBe('rtl');
    expect(resolveComicDirection({ ...book, title: 'Manga history', genres: ['Comics'] }, 'auto')).toBe('ltr');
  });
  it('matches literal Unicode-normalized keywords in only the configured metadata fields', () => {
    const rule = { keywords: [' ＳＨＯＮＥＮ ', 'Magic academy'], fields: ['genres', 'series'] as const };
    setMangaRule(localStorage, 'a', { ...rule, fields: [...rule.fields] });
    expect(getMangaRule(localStorage, 'a')).toEqual({ keywords: ['shonen', 'magic academy'], fields: ['genres', 'series'] });
    expect(resolveComicDirection({ ...book, series: 'The MAGIC ACADEMY' }, 'auto', getMangaRule(localStorage, 'a'))).toBe('rtl');
    expect(resolveComicDirection({ ...book, title: 'Magic academy' }, 'auto', getMangaRule(localStorage, 'a'))).toBe('ltr');
    expect(resolveComicDirection({ ...book, title: 'a.*' }, 'auto', { keywords: ['.*'], fields: ['title'] })).toBe('rtl');
    expect(resolveComicDirection(book, 'auto', { keywords: ['.*'], fields: ['title'] })).toBe('ltr');
  });
  it('keeps explicit direction scoped to account and title even after rule changes', () => {
    setComicDirectionMode(localStorage, 'a', 'one', 'ltr');
    setMangaRule(localStorage, 'a', { keywords: ['adventure'], fields: ['title'] });
    expect(resolveComicDirection(book, getComicDirectionMode(localStorage, 'a', 'one'), getMangaRule(localStorage, 'a'))).toBe('ltr');
    expect(getComicDirectionMode(localStorage, 'a', 'two')).toBe('auto');
    expect(getComicDirectionMode(localStorage, 'b', 'one')).toBe('auto');
    expect(getMangaRule(localStorage, 'b')).toEqual({ keywords: ['manga'], fields: ['genres'] });
    setComicDirectionMode(localStorage, 'a', 'one', 'auto');
    expect(resolveComicDirection(book, getComicDirectionMode(localStorage, 'a', 'one'), getMangaRule(localStorage, 'a'))).toBe('rtl');
  });
  it('allows disabling classification and falls back safely for malformed storage', () => {
    setMangaRule(localStorage, 'a', { keywords: [], fields: [] });
    expect(resolveComicDirection({ ...book, genres: ['Manga'] }, 'auto', getMangaRule(localStorage, 'a'))).toBe('ltr');
    localStorage.setItem('avid.reader.manga-rule.v1.a', '{broken');
    expect(getMangaRule(localStorage, 'a')).toEqual({ keywords: ['manga'], fields: ['genres'] });
  });
  it('opens a classified manga RTL, exposes semantic overrides, and prevents old global RTL leaking to another book', async () => {
    HTMLDialogElement.prototype.showModal = function () { this.open = true; };
    HTMLDialogElement.prototype.close = function () { this.open = false; };
    localStorage.setItem('avid.reader.settings.v1.a', JSON.stringify({ direction: 'rtl' }));
    const element = document.createElement('div'); document.body.append(element); const root = createRoot(element);
    const render = async (current: Book, scope = 'a') => act(async () => root.render(<Reader book={current} accountScope={scope} annotations={[]} onClose={() => {}} onAnchor={() => {}} onAnnotation={() => {}} />));
    await render({ ...book, genres: ['Manga'] });
    expect(element.querySelector('[data-comic-direction]')?.getAttribute('data-comic-direction')).toBe('rtl');
    await act(async () => (element.querySelector('button[aria-label="Reading settings"]') as HTMLButtonElement).click());
    const select = [...element.querySelectorAll('select')].find(item => [...item.options].some(option => option.text === 'Automatic'))!;
    expect([...select.options].map(option => option.text)).toEqual(['Automatic', 'Manga (right to left)', 'Comic (left to right)']);
    await act(async () => { select.value = 'ltr'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(getComicDirectionMode(localStorage, 'a', 'one')).toBe('ltr');
    expect(element.querySelector('[data-comic-direction]')?.getAttribute('data-comic-direction')).toBe('ltr');
    await render({ ...book, id: 'two' });
    expect(element.querySelector('[data-comic-direction]')?.getAttribute('data-comic-direction')).toBe('ltr');
    await render({ ...book, genres: ['Manga'] }, 'b');
    expect(element.querySelector('[data-comic-direction]')?.getAttribute('data-comic-direction')).toBe('rtl');
    await act(async () => root.unmount());
  });
});
