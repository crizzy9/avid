import { useReaderI18n, ReaderError, readerError } from './readerI18n';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { EngineProps } from './contracts';
import { clamp, pageLocator, parsePageAnchor, spreadPages } from './anchors';
import { openComicArchive, type ComicArchive } from './comicArchive';
import { usePageSlide } from './pageSlide';

export function ComicView(props: EngineProps) {
  const { t, locale } = useReaderI18n();
  const [archive, setArchive] = useState<ComicArchive>();
  const [page, setPage] = useState(1);
  const scroll = useRef<HTMLDivElement>(null);
  const pageSurface = useRef<HTMLDivElement>(null);
  const pageDisplayed = usePageSlide(pageSurface, { identity: JSON.stringify([props.book.id, props.file.id, props.settings.comicMode]), enabled: props.settings.animation === 'slide' && props.settings.comicMode !== 'webtoon', direction: props.settings.direction });
  const current = useRef(props); current.current = props;
  const state = useRef({ page, count: archive?.pages.length ?? 0 }); state.current = { page, count: archive?.pages.length ?? 0 };
  const initial = useRef(props.initialAnchor?.locator);
  const rowHeight = () => Math.max(500, (scroll.current?.clientHeight ?? 700) * 1.25);
  const navigate = (requestedPage: number, offset = 0) => {
    const anchor = parsePageAnchor(pageLocator(requestedPage, offset), state.current.count);
    state.current.page = anchor.page;
    setPage(anchor.page); initial.current = pageLocator(anchor.page, anchor.offset);
    if (current.current.settings.comicMode === 'webtoon' && scroll.current) scroll.current.scrollTop = (anchor.page - 1 + anchor.offset) * rowHeight();
  };
  useEffect(() => {
    let cancelled = false, opened: ComicArchive | undefined;
    const abort = new AbortController();
    void (async () => {
      let source = props.source;
      if (!source && props.file.url) {
        const response = await fetch(props.file.url, { signal: abort.signal });
        if (!response.ok) throw new ReaderError('comicDownloadFailed', { status: response.status });
        source = await response.blob();
      }
      if (!source) throw new ReaderError('comicUnavailable');
      const decoded = await openComicArchive(source, props.file.format);
      const cache = new Map<number, Promise<Blob>>();
      opened = {
        pages: decoded.pages.map((entry, index) => ({ name: entry.name, load: () => {
          for (const key of cache.keys()) if (Math.abs(key - index) > 4) cache.delete(key);
          if (!cache.has(index)) cache.set(index, entry.load());
          return cache.get(index)!;
        } })),
        close: () => { cache.clear(); decoded.close(); },
      };
      if (cancelled) { opened.close(); return; }
      setArchive(opened); setPage(parsePageAnchor(props.initialAnchor?.locator, opened.pages.length).page);
      current.current.onReady({
        next: () => navigate(state.current.page + (current.current.settings.comicMode === 'spread' && state.current.page > 1 ? 2 : 1)),
        prev: () => navigate(state.current.page - (current.current.settings.comicMode === 'spread' ? 2 : 1)),
        goTo: locator => {
          const anchor = typeof locator === 'number' ? { page: locator, offset: 0 } : parsePageAnchor(locator, state.current.count);
          navigate(anchor.page, anchor.offset);
        },
        search: async query => opened!.pages.map((entry, index) => ({ label: t('page', { number: index + 1 }), pageNumber: index + 1, locator: pageLocator(index + 1), excerpt: entry.name })).filter(result => result.excerpt.toLowerCase().includes(query.toLowerCase())),
        selection: () => ({ quote: t('page', { number: state.current.page }), locator: pageLocator(state.current.page) }),
      }, opened.pages.map((entry, index) => ({ label: `${t('page', { number: index + 1 })} · ${entry.name.split('/').at(-1)}`, pageNumber: index + 1, fileName: entry.name.split('/').at(-1), href: pageLocator(index + 1) })));
    })().catch(error => { if (!cancelled) current.current.onError(readerError(error, 'comicFailed')); });
    return () => { cancelled = true; abort.abort(); opened?.close(); };
  }, [props.book.id, props.file.id, props.file.url, props.source]);
  useEffect(() => {
    if (archive && props.settings.comicMode !== 'webtoon') props.onLocation(pageLocator(page), (page - 1) / Math.max(1, archive.pages.length - 1), t('pageOf', { number: page, count: archive.pages.length }));
  }, [page, archive, props.settings.comicMode, locale]);
  useEffect(() => {
    const next = archive?.pages[page + (props.settings.comicMode === 'spread' ? 1 : 0)];
    if (next) void next.load().catch(() => {});
  }, [archive, page, props.settings.comicMode]);
  useEffect(() => {
    if (props.settings.comicMode === 'webtoon' && scroll.current && archive) {
      const anchor = parsePageAnchor(initial.current || pageLocator(page), archive.pages.length);
      scroll.current.scrollTop = (anchor.page - 1 + anchor.offset) * rowHeight(); initial.current = undefined;
    }
  }, [props.settings.comicMode, archive]);
  const count = archive?.pages.length ?? 0;
  const visible = props.settings.comicMode === 'spread' ? spreadPages(page, count) : [page];
  const visibleKey = JSON.stringify([props.book.id, props.file.id, props.settings.comicMode, ...visible]);
  const decoded = useRef({ key: visibleKey, pages: new Set<number>() });
  if (decoded.current.key !== visibleKey) decoded.current = { key: visibleKey, pages: new Set() };
  const imageDisplayed = useCallback((number: number) => {
    if (decoded.current.key !== visibleKey) return;
    decoded.current.pages.add(number);
    if (visible.every(number => decoded.current.pages.has(number))) pageDisplayed(page);
  }, [visibleKey, page, pageDisplayed]);
  if (!archive) return <div className="avid-reader-loading">{t('unpacking')}</div>;
  if (props.settings.comicMode === 'webtoon') {
    const first = Math.max(0, page - 3), last = Math.min(count, page + 3), height = rowHeight();
    return <div className="avid-webtoon" ref={scroll} onScroll={() => {
      const top = scroll.current!.scrollTop;
      const index = Math.floor(top / rowHeight()); const offset = clamp(top / rowHeight() - index);
      setPage(Math.min(count, index + 1));
      current.current.onLocation(pageLocator(index + 1, offset), clamp((index + offset) / count), t('pageOf', { number: index + 1, count }));
    }}><div style={{ height: first * height }} />{archive.pages.slice(first, last).map((entry, index) => <div key={entry.name} style={{ height }} className="avid-webtoon-page"><ComicImage entry={entry} number={first + index + 1} onError={props.onError} /></div>)}<div style={{ height: (count - last) * height }} /></div>;
  }
  return <div className={`avid-comic-pages ${props.settings.comicMode}`} dir={props.settings.direction}><div className="avid-comic-sheet" ref={pageSurface}>{visible.map(number => <ComicImage key={number} entry={archive.pages[number - 1]!} number={number} onError={props.onError} onDisplayed={imageDisplayed} />)}</div></div>;
}
function ComicImage({ entry, number, onError, onDisplayed }: { entry: ComicArchive['pages'][number]; number: number; onError: (message: string) => void; onDisplayed?: (number: number) => void }) {
  const { t } = useReaderI18n();
  const [image, setImage] = useState<{ entry: ComicArchive['pages'][number]; url: string; decoded: boolean }>();
  const shown = image?.entry === entry ? image : undefined;
  useEffect(() => { if (shown?.decoded) onDisplayed?.(number); }, [shown?.decoded, onDisplayed, number]);
  useEffect(() => {
    let cancelled = false, asset = '';
    void entry.load().then(blob => { if (!cancelled) { asset = URL.createObjectURL(blob); setImage({ entry, url: asset, decoded: false }); } }).catch(error => { if (!cancelled) onError(readerError(error, 'pageFailed')); });
    return () => { cancelled = true; if (asset) URL.revokeObjectURL(asset); };
  }, [entry]);
  return shown ? <img src={shown.url} alt={t('comicPage', { number })} draggable={false} onLoad={() => setImage(value => value?.entry === entry ? { ...value, decoded: true } : value)} /> : <div className="avid-reader-loading">{t('loadingPage', { number })}</div>;
}
