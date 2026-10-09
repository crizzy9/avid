import { useEffect, useRef } from 'react';
import type { EngineProps, SearchResult, SelectionAnchor, TocItem } from './contracts';
import { themeColors } from './contracts';
import { createDemoEpub } from './demo';
import { sanitizeBookDocument } from './isolation';
import { fontRules } from './fonts';
import { publicationSource } from './publicationSource';
import '../vendor/foliate/view.js';
import { makeBook } from '../vendor/foliate/view.js';
import { Overlayer } from '../vendor/foliate/overlayer.js';

// Foliate has no stable TypeScript surface. Keep its untyped API at this boundary.
type FoliateView = HTMLElement & { [key: string]: any };
export function EbookView(props: EngineProps) {
  const container = useRef<HTMLDivElement>(null);
  const viewRef = useRef<FoliateView | null>(null);
  const current = useRef(props); current.current = props;
  const stopSpeech = useRef<() => void>(() => {});
  useEffect(() => {
    let cancelled = false;
    let loadedBook: any;
    const isolatedUrls = new Map<number, string>();
    const view = document.createElement('foliate-view') as FoliateView;
    view.setAttribute('aria-label', 'Book reading area');
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
      current.current.onLocation(detail.cfi, Math.max(0, Math.min(1, detail.fraction ?? 0)), detail.tocItem?.label || 'Reading');
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
    const stop = () => { speaking = false; speechGeneration++; globalThis.speechSynthesis?.cancel(); current.current.onSpeaking(false); };
    stopSpeech.current = stop;
    const speakSection = async (startFromSelection = true) => {
      if (!('speechSynthesis' in window)) { current.current.onError('This browser does not provide installed speech voices.'); return; }
      const generation = ++speechGeneration;
      speaking = true;
      const { doc, index } = view.renderer.getContents()[0] ?? {};
      if (!doc) return stop();
      const selected = startFromSelection ? doc.getSelection() : undefined;
      const selectedRange = selected?.rangeCount ? selected.getRangeAt(0) : undefined;
      const startRange = selectedRange && !selectedRange.collapsed ? selectedRange : startFromSelection ? view.lastLocation?.range : undefined;
      const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
      const nodes: Text[] = [];
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (node.textContent?.trim() && !node.parentElement?.closest('script,style,head')) nodes.push(node as Text);
      }
      let started = !startRange;
      const parts: { node: Text; start: number; text: string }[] = [];
      for (const node of nodes) {
        let start = 0;
        if (!started && startRange) {
          const range = doc.createRange(); range.selectNodeContents(node);
          if (range.compareBoundaryPoints(Range.END_TO_START, startRange) <= 0) continue;
          started = true;
          if (node === startRange.startContainer) start = startRange.startOffset;
        }
        parts.push({ node, start, text: node.data.slice(start) });
      }
      const fullText = parts.map(part => part.text).join(' ');
      if (!fullText.trim()) return stop();
      const utterance = new SpeechSynthesisUtterance(fullText);
      utterance.rate = current.current.settings.speechRate;
      utterance.voice = speechSynthesis.getVoices().find(voice => voice.voiceURI === current.current.settings.voice) ?? null;
      utterance.onboundary = event => {
        if (!speaking || generation !== speechGeneration || event.name !== 'word') return;
        let offset = 0;
        for (const part of parts) {
          if (event.charIndex < offset + part.text.length) {
            const range = doc.createRange();
            const start = part.start + event.charIndex - offset;
            range.setStart(part.node, Math.max(0, start));
            const length = event.charLength || part.node.data.slice(start).match(/^\S+/)?.[0].length || 1;
            range.setEnd(part.node, Math.min(part.node.length, start + length));
            const selection = doc.getSelection(); selection.removeAllRanges(); selection.addRange(range);
            view.renderer.scrollToAnchor?.(range, true);
            break;
          }
          offset += part.text.length + 1;
        }
      };
      utterance.onstart = () => { if (speaking && generation === speechGeneration) current.current.onSpeaking(true); };
      utterance.onerror = () => stop();
      utterance.onend = async () => {
        if (!speaking || generation !== speechGeneration) return;
        if (index + 1 < view.book.sections.length) { await view.goTo(index + 1); if (speaking) void speakSection(false); }
        else stop();
      };
      speechSynthesis.cancel(); speechSynthesis.speak(utterance);
    };
    const open = async () => {
      const source = props.source ?? props.file.url ?? (props.book.id.startsWith('demo-') ? createDemoEpub() : undefined);
      if (!source) throw new Error('This file is not available. Connect to its server or import the book again.');
      const input = publicationSource(source, props.file.name, props.file.format);
      loadedBook = await makeBook(input); if (cancelled) { loadedBook.destroy?.(); return; }
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
      await view.open(loadedBook); if (cancelled) return;
      applyStyle(view, current.current.settings, props.accountScope);
      await view.init({ lastLocation: props.initialAnchor?.kind === 'epub' ? props.initialAnchor.locator : undefined, showTextStart: true });
      if (cancelled) return;
      const overlay = view.mediaOverlay;
      let overlayStarted = false;
      if (overlay) {
        const update = () => current.current.onMediaState({ available: true, playing: overlay.state === 'playing', seconds: overlay.currentTime ?? 0 });
        overlay.addEventListener('timeupdate', update);
        overlay.addEventListener('statechange', update);
        overlay.addEventListener('highlight', update);
        overlay.addEventListener('error', (event: CustomEvent) => current.current.onError(event.detail?.message || 'Aligned narration could not play.'));
        update();
      } else current.current.onMediaState({ available: false, playing: false, seconds: 0 });
      current.current.onReady({
        next: () => { void view.next(); }, prev: () => { void view.prev(); },
        goTo: locator => { stop(); void view.goTo(locator); }, selection,
        search: async query => {
          const results: SearchResult[] = [];
          for await (const item of view.search({ query, matchCase: false })) {
            for (const result of item?.subitems ?? (item?.cfi ? [item] : [])) results.push({ locator: result.cfi, label: item.label || 'Match', excerpt: typeof result.excerpt === 'string' ? result.excerpt : `${result.excerpt?.pre ?? ''}${result.excerpt?.match ?? ''}${result.excerpt?.post ?? ''}` });
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
          mediaPrevious: () => overlay.prev(), mediaNext: () => overlay.next(),
          setMediaFollow: (follow: boolean) => { view.mediaOverlayFollow = follow; },
          setMediaRate: (rate: number) => overlay.setRate(rate),
        } : {}),
      }, loadedBook.toc as TocItem[] ?? []);
    };
    void open().catch(error => { if (!cancelled) current.current.onError(error instanceof Error ? error.message : 'Unable to open this ebook.'); });
    return () => { cancelled = true; stop(); view.mediaOverlay?.stop(); view.close?.(); view.remove(); loadedBook?.destroy?.(); for (const url of isolatedUrls.values()) URL.revokeObjectURL(url); viewRef.current = null; };
  }, [props.book.id, props.file.id, props.file.url, props.source]);
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
  view.renderer.setAttribute('gap', String(settings.margin));
  view.renderer.setAttribute('margin', '36');
  view.renderer.setAttribute('max-inline-size', '740');
  view.renderer.setAttribute('max-column-count', '2');
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  view.renderer.toggleAttribute('animated', settings.animation === 'slide' && !reduced);
  const family = settings.font.replace(/["\\;{}]/g, '');
  view.renderer.setStyles(`${fontRules(scope)} html { color: ${colors.foreground}; background: ${colors.background}; } body { font-family: "${family}", Georgia, serif !important; font-size: ${settings.fontSize}px !important; line-height: ${settings.lineHeight} !important; } p { line-height: inherit !important; } h1, h2 { line-height: 1.3; font-weight: 500; } a { color: inherit; } ::selection { background: #d9b97188; } img { max-width:100%; } .${CSS.escape(view.book.media?.activeClass || "avid-narration-active")} { background: #d6b96e88 !important; color: inherit !important; }`);
}
