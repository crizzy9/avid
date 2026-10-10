import type { Annotation, Book, BookFile, ReadingAnchor } from '../../core/src/types';
import type { ReaderAlignmentHandle } from './alignedPassage';
import type { ReactNode } from 'react';
export type { Annotation, Book, BookFile, ReadingAnchor };
export interface ReaderProps {
  book: Book;
  accountScope?: string;
  preferences?: ReaderPreferencePort;
  onActivity?: (activity: 'reading' | 'speech' | 'listening') => void;
  onAlignmentReady?: (handle: ReaderAlignmentHandle | null) => void;
  modeControls?: ReactNode;
  file?: BookFile;
  source?: Blob;
  initialAnchor?: ReadingAnchor;
  annotations: Annotation[];
  onClose: () => void;
  onAnchor: (anchor: ReadingAnchor) => void;
  onAnnotation: (annotation: Annotation) => void;
}
export type ReaderPreferenceValues = Partial<Omit<ReaderSettings,'direction'>> & { comicDirection?: 'auto' | 'ltr' | 'rtl' };
export interface ReaderPreferencePort {
  /** Immutable account and file identity; never a token. */
  id: string;
  readOnly: boolean;
  load: () => Promise<ReaderPreferenceValues>;
  patch: (values: ReaderPreferenceValues) => Promise<void>;
}
export interface TocItem { label: string; href: string | number; subitems?: TocItem[]; pageNumber?: number; fileName?: string }
export interface SearchResult { label: string; locator: string; excerpt: string; pageNumber?: number }
export interface SelectionAnchor { quote: string; locator: string }
export interface ReaderPageInfo {
  /** Publication page-list label, including Roman numerals; never an estimated location. */
  pageLabel?: string;
  pageNumber?: number;
  pageCount?: number;
  /** Actual remaining paginator screens in the current spine section. */
  sectionRemaining?: number;
}
export interface ReaderSettings {
  theme: 'light' | 'warm' | 'dark' | 'custom';
  background: string; foreground: string;
  font: string; fontSize: number; lineHeight: number; margin: number;
  flow: 'paginated' | 'scrolled'; animation: 'none' | 'slide' | 'fade' | 'fast-fade';
  comicMode: 'paged' | 'spread' | 'webtoon'; direction: 'ltr' | 'rtl';
  voice: string; speechRate: number;
}
export interface EngineHandle {
  next: () => void; prev: () => void;
  goTo: (locator: string | number) => void;
  search: (query: string) => Promise<SearchResult[]>;
  selection: () => SelectionAnchor | undefined;
  speak?: () => void; stopSpeaking?: () => void;
  playMedia?: () => void; pauseMedia?: () => void;
  mediaPrevious?: () => void; mediaNext?: () => void;
  setMediaFollow?: (follow: boolean) => void; setMediaRate?: (rate: number) => void;
  autoCrop?: () => void; resetCrop?: () => void;
}
export interface EngineProps extends ReaderProps {
  file: BookFile;
  settings: ReaderSettings;
  onReady: (handle: EngineHandle, toc: TocItem[]) => void;
  onLocation: (locator: string, progress: number, label: string, pageInfo?: ReaderPageInfo) => void;
  onReadingTap?: () => void;
  onReadingEscape?: () => void;
  onError: (error: string) => void;
  onNotice: (message: string) => void;
  onSelection: (selection: SelectionAnchor | undefined) => void;
  onSpeaking: (active: boolean) => void;
  onMediaState: (state: { available: boolean; playing: boolean; seconds: number }) => void;
}
export const defaultSettings: ReaderSettings = {
  theme: 'light', background: '#f5eddb', foreground: '#302b22', font: 'Georgia',
  fontSize: 18, lineHeight: 1.55, margin: 6, flow: 'paginated', animation: 'none',
  comicMode: 'paged', direction: 'ltr', voice: '', speechRate: 1,
};
export function themeColors(settings: ReaderSettings) {
  return settings.theme === 'dark' ? { background: '#17191c', foreground: '#d8d8d3' }
    : settings.theme === 'light' ? { background: '#fcfcfa', foreground: '#262626' }
    : settings.theme === 'custom' ? { background: settings.background, foreground: settings.foreground }
    : { background: '#f5eddb', foreground: '#302b22' };
}
