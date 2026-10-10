import type { Book } from '../../core/src/types';
import { ReaderError } from './readerI18n';
export type ComicDirectionMode = 'auto' | 'rtl' | 'ltr';
export type MangaRuleField = 'genres' | 'title' | 'series';
export interface MangaRule { keywords: string[]; fields: MangaRuleField[] }
type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem' | 'removeItem'>;
export const defaultMangaRule: MangaRule = { keywords: ['manga'], fields: ['genres'] };
const normalize = (text: string) => text.normalize('NFKC').trim().toLocaleLowerCase('en');
const preferenceKey = (scope: string, bookId: string) => `avid.reader.comic-direction.v1.${encodeURIComponent(scope)}.${encodeURIComponent(bookId)}`;
const ruleKey = (scope: string) => `avid.reader.manga-rule.v1.${encodeURIComponent(scope)}`;
export function normalizeMangaRule(input: MangaRule): MangaRule {
  const keywords = [...new Set(input.keywords.filter(value => typeof value === 'string').map(normalize).filter(Boolean))];
  const fields = [...new Set(input.fields.filter(value => ['genres', 'title', 'series'].includes(value)))];
  if (keywords.length > 100 || keywords.some(value => value.length > 80)) throw new ReaderError('mangaKeywordsLimit');
  return { keywords, fields };
}
export function resolveComicDirection(book: Pick<Book, 'genres' | 'title' | 'series'>, mode: ComicDirectionMode, input: MangaRule = defaultMangaRule): 'rtl' | 'ltr' {
  if (mode !== 'auto') return mode;
  const rule = normalizeMangaRule(input);
  const values = rule.fields.flatMap(field => field === 'genres' ? book.genres : [book[field] ?? '']).map(normalize);
  return rule.keywords.some(keyword => values.some(value => value.includes(keyword))) ? 'rtl' : 'ltr';
}
export function getComicDirectionMode(storage: Storage, scope: string, bookId: string): ComicDirectionMode {
  try { const mode = storage.getItem(preferenceKey(scope, bookId)); return mode === 'rtl' || mode === 'ltr' ? mode : 'auto'; } catch { return 'auto'; }
}
export function setComicDirectionMode(storage: Storage, scope: string, bookId: string, mode: ComicDirectionMode): void {
  if (mode === 'auto') storage.removeItem(preferenceKey(scope, bookId));
  else if (mode === 'rtl' || mode === 'ltr') storage.setItem(preferenceKey(scope, bookId), mode);
  else throw new Error('Invalid comic direction preference.');
}
export function getMangaRule(storage: Storage, scope: string): MangaRule {
  try {
    const value: unknown = JSON.parse(storage.getItem(ruleKey(scope)) || 'null');
    if (value && typeof value === 'object' && 'keywords' in value && Array.isArray(value.keywords) && 'fields' in value && Array.isArray(value.fields)) return normalizeMangaRule(value as MangaRule);
  } catch { /* Corrupt or unavailable preference storage uses the conservative genre rule. */ }
  return { keywords: [...defaultMangaRule.keywords], fields: [...defaultMangaRule.fields] };
}
export function setMangaRule(storage: Storage, scope: string, rule: MangaRule): void { storage.setItem(ruleKey(scope), JSON.stringify(normalizeMangaRule(rule))); }
