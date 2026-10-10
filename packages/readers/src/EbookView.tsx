import { useReaderI18n, ReaderError, readerError } from './readerI18n';
import { useEffect, useRef } from 'react';
import type { EngineProps, SearchResult, SelectionAnchor, TocItem } from './contracts';
import { themeColors } from './contracts';
import { createDemoEpub } from './demo';
import { sanitizeBookDocument } from './isolation';
import { fontRules } from './fonts';
import { clamp } from './anchors';
import { publicationSource } from './publicationSource';
import { buildSpeechText, speechBoundaryRange, nextLinearSection } from './speechText';
import { alignedPassageAtRange, verifyPublicationAudiobook } from './alignedPassage';
import { alignmentSha256 } from '../../playback/src/standalone-alignment';
import { speechProvider } from '../../playback/src/speechRuntime';
import '../vendor/foliate/view.js';
import { makeBook } from '../vendor/foliate/view.js';
import { Overlayer } from '../vendor/foliate/overlayer.js';

// Foliate has no stable TypeScript surface. Keep its untyped API at this boundary.
type FoliateView = HTMLElement & { [key: string]: any };
export function EbookView(props: EngineProps) {
  const { t, locale } = useReaderI18n();
  const container = useRef<HTMLDivElement>(null);
  const viewRef = useRef<FoliateView | null>(null);
  const current = useRef(props); current.current = props;
  const stopSpeech = useRef<() => void>(() => {});
  useEffect(() => {
    let cancelled = false;
    let loadedBook: any;
    let handoffLocator = props.initialAnchor?.kind === 'epub' ? props.initialAnchor.locator : undefined;
    const isolatedUrls = new Map<number, string>();
    const view = document.createElement('foliate-view') as FoliateView;
    view.setAttribute('aria-label', t('readingArea'));
    container.current?.append(view); viewRef.current = view;
    const selection = (): SelectionAnchor | undefined => {
      for (const { doc, index } of view.renderer?.getContents?.() ?? []) {
        const selected = doc.getSelection();
        if (selected?.rangeCount && !selected.isCollapsed && selected.toString().trim()) return { quote: selected.toString().trim(), locator: view.getCFI(index, selected.getRangeAt(0)) };
      }
    };
    const applyAnnotations = () => {
      for (const annotation of current.current.annotations.filter(item => item.bookId === props.book.id && item.fileId === props.file.id)) {
        if (!annotation.locator.startsWith('epubcfi(')) continue;
        Promise.resolve(annotation.deleted ? view.deleteAnnotation({ value: annotation.locator }) : view.addAnnotation({ value: annotation.locator, color: annotation.color })).catch(() => {});
      }
    };
    view.addEventListener('relocate', ((event: CustomEvent) => {
      const detail = event.detail;
      current.current.onLocation(detail.cfi, clamp(detail.fraction ?? 0), detail.tocItem?.label || t('reading'));
    }) as EventListener);
    view.addEventListener('load', ((event: CustomEvent) => {
      const { doc } = event.detail;
      doc.addEventListener('selectionchange', () => current.current.onSelection(selection()));
      doc.addEventListener('keydown', (event: KeyboardEvent) => {
        if (event.key === 'ArrowRight') void view.goRight();
        if (event.key === 'ArrowLeft') void view.goLeft();
      });
      applyAnnotations();
    }) as EventListener);
    view.addEventListener('create-overlay', () => queueMicrotask(applyAnnotations));
    view.addEventListener('external-link', event => event.preventDefault());
    view.addEventListener('draw-annotation', ((event: CustomEvent) => event.detail.draw(Overlayer.highlight, { color: event.detail.annotation.color || '#d2aa59' })) as EventListener);
    let speaking = false;
    let speechGeneration = 0;
    const speechService = speechProvider();
    const speaker = speechService.createPlayer();
    const stop = () => { speaking = false; speechGeneration++; speaker.cancel(); current.current.onSpeaking(false); };
    stopSpeech.current = stop;
    const speakSection = async (startFromSelection = true) => {
      if (!speechService.available) { current.current.onNotice(t('speechUnavailable')); return; }
      const generation = ++speechGeneration;
      speaking = true;
      const { doc, index } = view.renderer.getContents()[0] ?? {};
      if (!doc) return stop();
      const selected = startFromSelection ? doc.getSelection() : undefined;
      const selectedRange = selected?.rangeCount ? selected.getRangeAt(0) : undefined;
      const startRange = selectedRange && !selectedRange.collapsed ? selectedRange : startFromSelection ? view.lastLocation?.range : undefined;
      const speech = buildSpeechText(doc, startRange);
      const continueSection = async () => {
        if (!speaking || generation !== speechGeneration) return;
        const next = nextLinearSection(view.book.sections, index);
        if (next === undefined) return stop();
        await view.goTo(next);
        if (!speaking || generation !== speechGeneration) return;
        if (view.renderer.getContents()[0]?.index !== next) { stop(); current.current.onNotice(t('speechNextFailed')); return; }
        void speakSection(false);
      };
      if (!speech.text.trim()) { await continueSection(); return; }
      const fullText = speech.text;
      speaker.speak({
        text: fullText,
        rate: current.current.settings.speechRate,
        voiceURI: current.current.settings.voice,
        lang: doc.documentElement.lang || (Array.isArray(view.book.metadata?.language) ? view.book.metadata.language[0] : view.book.metadata?.language),
        onBoundary: event => {
        if (!speaking || generation !== speechGeneration || event.kind !== 'word') return;
        const range = speechBoundaryRange(doc, speech, event.start, event.end - event.start);
        if (!range) return;
        const selection = doc.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
        view.renderer.scrollToAnchor?.(range, true);
      },
      onStart: () => { if (speaking && generation === speechGeneration) current.current.onSpeaking(true); },
      onError: error => {
        if (generation !== speechGeneration) return;
        stop();
        if (error !== 'canceled' && error !== 'interrupted') current.current.onNotice(t('speechFailed', { reason: error }));
      },
      onEnd: continueSection,
      });
    };
    const open = async () => {
      const source = props.source ?? props.file.url ?? (props.book.id.startsWith('demo-') ? createDemoEpub() : undefined);
      if (!source) throw new ReaderError('fileUnavailable');
      const input = publicationSource(source, props.file.name, props.file.format);
      loadedBook = await makeBook(input); if (cancelled) { loadedBook.destroy?.(); return; }
      // A URL fetched later could contain a different edition. Only hash the exact Blob
      // passed to the parser; root normally supplies its authenticated/cached source Blob.
      if (input instanceof Blob) {
        let digest: Promise<string> | undefined;
        current.current.onAlignmentReady?.({ pauseNarration: () => { if (!cancelled) { stop(); view.mediaOverlay?.pause(); } }, verifyAudiobook: async (playlist, manifest, audioFileId, assets) => {
          if (cancelled || props.file.format !== 'EPUB') throw new Error('The aligned EPUB reader is no longer available.');
          const map = await verifyPublicationAudiobook(input, loadedBook, { accountScope: props.accountScope ?? 'local', bookId: props.book.id, textFileId: props.file.id, audioFileId }, playlist, manifest, assets);
          if (cancelled) throw new Error('The reader closed before alignment verification completed.');
          return map;
        }, currentPassage: async (map, edition) => {
          digest ??= input.arrayBuffer().then(alignmentSha256);
          const actualHash = await digest;
          if (cancelled || edition.bookId !== props.book.id || edition.textFileId !== props.file.id || edition.accountScope !== (props.accountScope ?? 'local') || edition.textSha256 !== actualHash) {
            throw new Error('The open reader does not match the verified text and audio edition.');
          }
          const contents = view.renderer?.getContents?.() ?? [];
          const selected = contents.map((item: { doc: Document }) => item.doc.getSelection()).find((value: Selection | null) => value?.rangeCount && !value.isCollapsed);
          if (!selected && handoffLocator) {
            const navigation = view.resolveNavigation(handoffLocator);
            const content = contents.find((item: { index: number }) => item.index === navigation?.index);
            const target = content && navigation?.anchor?.(content.doc);
            if (target && typeof target === 'object') {
              const point = 'startContainer' in target ? target.cloneRange() as Range : content.doc.createRange() as Range;
              if (!('startContainer' in target)) point.selectNodeContents(target);
              const passage = alignedPassageAtRange(map, edition, content.doc, content.index, point);
              if (passage) return passage;
            }
          }
          const range = (selected?.getRangeAt(0) ?? view.lastLocation?.range) as Range | undefined;
          if (!range) return null;
          const content = contents.find((item: { doc: Document }) => item.doc === range.startContainer.ownerDocument);
          return content ? alignedPassageAtRange(map, edition, content.doc, content.index, range) : null;
        } });
      } else current.current.onAlignmentReady?.(null);
      loadedBook.transformTarget?.addEventListener('load', (event: CustomEvent) => { if (event.detail.isScript) event.detail.allow = false; });
      for (const [index, section] of loadedBook.sections.entries()) {
        const originalLoad = section.load.bind(section);
        const originalDocument = section.createDocument?.bind(section);
        const originalUnload = section.unload?.bind(section);
        section.unload = () => { const url = isolatedUrls.get(index); if (url) URL.revokeObjectURL(url); isolatedUrls.delete(index); originalUnload?.(); };
        section.load = async () => {
          if (isolatedUrls.has(index)) return isolatedUrls.get(index);
          const originalUrl = await originalLoad(); const response = await fetch(originalUrl);
          const html = await response.text();
          const type = response.headers.get('content-type')?.split(';')[0] || 'text/html';
          const url = URL.createObjectURL(new Blob([sanitizeBookDocument(html, type)], { type: 'application/xhtml+xml' }));
          isolatedUrls.set(index, url); return url;
        };
        if (originalDocument) section.createDocument = async () => {
          const doc = await originalDocument();
          return new DOMParser().parseFromString(sanitizeBookDocument(new XMLSerializer().serializeToString(doc)), 'application/xhtml+xml');
        };
      }
      loadedBook.media ??= {};
      loadedBook.media.activeClass ||= 'avid-narration-active';
      await view.open(loadedBook); if (cancelled) return;
      view.renderer.addEventListener('relocate', (event: CustomEvent) => {
        if (['page', 'scroll', 'snap'].includes(event.detail.reason)) handoffLocator = undefined;
      });
      applyStyle(view, current.current.settings, props.accountScope);
      await view.init({ lastLocation: props.initialAnchor?.kind === 'epub' ? props.initialAnchor.locator : undefined, showTextStart: true });
      if (cancelled) { view.close(); loadedBook.destroy?.(); return; }
      const overlay = view.mediaOverlay;
      let overlayStarted = false;
      if (overlay) {
        const update = () => { if (overlay.state === 'stopped') overlayStarted = false; current.current.onMediaState({ available: true, playing: overlay.state === 'playing', seconds: overlay.currentTime ?? 0 }); };
        overlay.addEventListener('timeupdate', update);
        overlay.addEventListener('statechange', update);
        overlay.addEventListener('highlight', update);
        overlay.addEventListener('error', (event: CustomEvent) => current.current.onNotice(t('narrationFailed')));
        update();
      } else current.current.onMediaState({ available: false, playing: false, seconds: 0 });
      current.current.onReady({
        next: () => { handoffLocator = undefined; void view.next(); }, prev: () => { handoffLocator = undefined; void view.prev(); },
        goTo: locator => { stop(); handoffLocator = typeof locator === 'string' ? locator : undefined; void view.goTo(locator); }, selection,
        search: async query => {
          const results: SearchResult[] = [];
          for await (const item of view.search({ query, matchCase: false })) {
            for (const result of item?.subitems ?? (item?.cfi ? [item] : [])) results.push({ locator: result.cfi, label: item.label || t('match'), excerpt: typeof result.excerpt === 'string' ? result.excerpt : `${result.excerpt?.pre ?? ''}${result.excerpt?.match ?? ''}${result.excerpt?.post ?? ''}` });
            if (results.length >= 150) break;
          }
          return results;
        },
        speak: () => { overlay?.pause(); void speakSection(); }, stopSpeaking: stop,
        ...(overlay ? {
          playMedia: () => {
            stop();
            if (overlayStarted) overlay.resume();
            else {
              overlayStarted = true;
              overlay.resume();
              const { index, doc } = view.renderer.getContents()[0] ?? {};
              const range = view.lastLocation?.range;
              void overlay.start(index ?? 0, (item: { text: string }) => {
                if (!range || !doc) return true;
                try { const resolved = view.resolveNavigation(item.text); const element = resolved?.anchor?.(doc); return !element || element.contains(range.startContainer) || range.comparePoint(element, 0) >= 0; } catch { return true; }
              });
            }
          },
          pauseMedia: () => overlay.pause(),
          mediaPrevious: () => { if (overlayStarted) overlay.prev(); }, mediaNext: () => { if (overlayStarted) overlay.next(); },
          setMediaFollow: (follow: boolean) => { view.mediaOverlayFollow = follow; },
          setMediaRate: (rate: number) => overlay.setRate(rate),
        } : {}),
      }, loadedBook.toc as TocItem[] ?? []);
    };
    void open().catch(error => { if (!cancelled) current.current.onError(readerError(error, 'ebookFailed')); });
    return () => { cancelled = true; current.current.onAlignmentReady?.(null); stop(); speaker.destroy(); view.mediaOverlay?.stop(); view.close?.(); view.remove(); loadedBook?.destroy?.(); for (const url of isolatedUrls.values()) URL.revokeObjectURL(url); viewRef.current = null; };
  }, [props.book.id, props.file.id, props.file.url, props.source, props.accountScope]);
  useEffect(() => { viewRef.current?.setAttribute('aria-label', t('readingArea')); }, [locale]);
  useEffect(() => { if (viewRef.current?.renderer) applyStyle(viewRef.current, props.settings, props.accountScope); }, [props.settings, props.accountScope]);
  useEffect(() => {
    const view = viewRef.current;
    if (!view?.renderer) return;
    for (const annotation of props.annotations.filter(item => item.bookId === props.book.id && item.fileId === props.file.id && item.locator.startsWith('epubcfi('))) {
      Promise.resolve(annotation.deleted ? view.deleteAnnotation({ value: annotation.locator }) : view.addAnnotation({ value: annotation.locator, color: annotation.color })).catch(() => {});
    }
  }, [props.annotations, props.book.id, props.file.id]);
  return <div className="avid-ebook" ref={container} />;
}
function applyStyle(view: FoliateView, settings: EngineProps['settings'], scope = 'local') {
  const colors = themeColors(settings);
  view.renderer.setAttribute('flow', settings.flow);
  view.renderer.setAttribute('gap', `${settings.margin}%`);
  view.renderer.setAttribute('margin', '36px');
  view.renderer.setAttribute('max-inline-size', '740px');
  view.renderer.setAttribute('max-column-count', '2');
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  view.renderer.toggleAttribute('animated', settings.animation === 'slide' && !reduced);
  const family = settings.font.replace(/["\\;{}]/g, '');
  view.renderer.setStyles(`${fontRules(scope)} html { color: ${colors.foreground}; background: ${colors.background}; } body { font-family: "${family}", Georgia, serif !important; font-size: ${settings.fontSize}px !important; line-height: ${settings.lineHeight} !important; } p { line-height: inherit !important; } h1, h2 { line-height: 1.3; font-weight: 500; } a { color: inherit; } ::selection { background: #d9b97188; } img { max-width:100%; } .${CSS.escape(view.book.media?.activeClass || "avid-narration-active")} { background: #d6b96e88 !important; color: inherit !important; }`);
}
