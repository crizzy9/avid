import { getLocale, LOCALES, useI18n, type Locale } from '../../i18n/src';
import { readerMessages, type ReaderMessageKey } from './readerMessages';
export type ReaderParameters = Record<string, string | number>;
export function readerTranslate(key: ReaderMessageKey, parameters: ReaderParameters = {}, locale: Locale = getLocale()): string {
  const index = LOCALES.findIndex(item => item.code === locale);
  return readerMessages[key][index < 0 ? 0 : index].replace(/\{(\w+)\}/g, (token, name: string) => {
    const value = parameters[name];
    return value === undefined ? token : typeof value === 'number' ? new Intl.NumberFormat(locale, { maximumFractionDigits: 2, useGrouping: false }).format(value) : value;
  });
}
/** Subscribe the view, while event handlers always read the current language without reloading a book. */
export function useReaderI18n() { const { locale } = useI18n(); return { locale, t: readerTranslate }; }
export class ReaderError extends Error {
  constructor(public readonly key: ReaderMessageKey, public readonly parameters: ReaderParameters = {}) { super(readerTranslate(key, parameters)); this.name = 'ReaderError'; }
}
export function readerError(error: unknown, fallback: ReaderMessageKey): string {
  if (error instanceof ReaderError) return readerTranslate(error.key, error.parameters);
  if (error instanceof Error && error.message === readerMessages.drm[0]) return readerTranslate('drm');
  // Preserve diagnostics from decoders without pretending they are translated application copy.
  return error instanceof Error && error.message ? `${readerTranslate(fallback)} ${error.message}` : readerTranslate(fallback);
}
