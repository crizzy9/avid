// @vitest-environment jsdom
import { act, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOCALES, setLocale } from '../../i18n/src';
import { readerMessages, type ReaderMessageKey } from './readerMessages';
import { readerError, ReaderError, readerTranslate } from './readerI18n';
import { Reader } from './Reader';
const engine = vi.hoisted(() => ({ mount: vi.fn(), unmount: vi.fn() }));
vi.mock('./EbookView', () => ({ EbookView: () => { useEffect(() => { engine.mount(); return () => { engine.unmount(); }; }, []); return <div>Original publication text</div>; } }));
vi.mock('./PdfView', () => ({ PdfView: () => null }));
vi.mock('./ComicView', () => ({ ComicView: () => null }));
const parameters = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort();
beforeEach(() => { setLocale('en'); Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); });
afterEach(() => { setLocale('en'); document.body.replaceChildren(); });
describe('reader localization', () => {
  it('provides every reader message and the same placeholders in all seven languages', () => {
    expect(LOCALES.map(item => item.code)).toEqual(['en', 'fi', 'fr', 'de', 'pl', 'zh-Hans', 'es']);
    for (const [key, values] of Object.entries(readerMessages)) {
      expect(values, key).toHaveLength(7);
      values.forEach((value, index) => {
        expect(value.trim().length, `${key}/${LOCALES[index]!.code}`).toBeGreaterThan(0);
        expect(parameters(value), `${key}/${LOCALES[index]!.code}`).toEqual(parameters(values[0]));
      });
    }
  });
  it('interpolates localized numbers and preserves publication text as data', () => {
    expect(readerTranslate('speechSpeed', { rate: 1.5 }, 'de')).toBe('Sprechtempo · 1,5×');
    expect(readerTranslate('readingTitle', { title: 'A {strange} title' }, 'zh-Hans')).toBe('正在阅读《A {strange} title》');
    for (const { code } of LOCALES) {
      for (const key of Object.keys(readerMessages) as ReaderMessageKey[]) {
        const supplied = Object.fromEntries(parameters(readerMessages[key][0]).map(name => [name!, 'value']));
        expect(readerTranslate(key, supplied, code)).not.toMatch(/\{\w+\}/);
      }
    }
  });
  it('localizes typed recovery errors and keeps unknown decoder diagnostics available', () => {
    const error = new ReaderError('archiveEncrypted');
    setLocale('es');
    expect(readerError(error, 'comicFailed')).toBe(readerMessages.archiveEncrypted[6]);
    expect(readerError(new Error('Decoder code 17'), 'comicFailed')).toBe(`${readerMessages.comicFailed[6]} Decoder code 17`);
  });
  it('updates reader settings, notes, search and accessibility controls in every locale', async () => {
    HTMLDialogElement.prototype.showModal = function () { this.open = true; };
    HTMLDialogElement.prototype.close = function () { this.open = false; };
    const element = document.createElement('div'); document.body.append(element);
    const root = createRoot(element);
    await act(async () => { root.render(<Reader book={{ id: 'i18n-book', title: 'Original title', authors: [], description: '', format: 'EPUB',
      files: [{ id: 'file', name: 'book.epub', format: 'EPUB' }], color: '#aaa', progress: 0, status: 'unread', genres: [], addedAt: '' }}
      annotations={[]} onClose={() => {}} onAnchor={() => {}} onAnnotation={() => {}} />); });
    const click = async (key: ReaderMessageKey) => {
      const button = [...element.querySelectorAll('button')].find(item => item.getAttribute('aria-label') === readerTranslate(key));
      expect(button, key).toBeDefined();
      await act(async () => { button!.click(); });
    };
    for (const { code } of LOCALES) {
      await act(async () => { setLocale(code); });
      expect(element.querySelector('dialog')?.lang).toBe(code);
      expect(element.querySelector('dialog')?.getAttribute('aria-label')).toBe(readerTranslate('readingTitle', { title: 'Original title' }));
      await click('readingSettings');
      expect(element.textContent).toContain(readerTranslate('pageFlow'));
      expect(element.textContent).toContain(readerTranslate('noVoices'));
      await click('highlightsNotes');
      expect(element.querySelector('textarea')?.getAttribute('placeholder')).toBe(readerTranslate('notePlaceholder'));
      expect(element.textContent).toContain(readerTranslate('saveNote'));
      await click('searchBook');
      expect(element.querySelector('input[placeholder]')?.getAttribute('placeholder')).toBe(readerTranslate('searchPassage'));
      expect(element.textContent).toContain(readerTranslate('matches', { count: 0 }));
      await click('closePanel');
      expect(element.textContent).toContain('Original publication text');
    }
    expect(engine.mount).toHaveBeenCalledTimes(1);
    expect(engine.unmount).not.toHaveBeenCalled();
    await act(async () => { root.unmount(); });
  });
});
