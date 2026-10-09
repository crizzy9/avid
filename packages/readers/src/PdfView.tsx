import { useReaderI18n, ReaderError, readerError } from './readerI18n';
import { useEffect, useRef, useState } from 'react';
import { GlobalWorkerOptions, getDocument, TextLayer, type PDFDocumentProxy } from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { EngineProps, SelectionAnchor } from './contracts';
import { detectContentBounds, pageLocator, parsePageAnchor } from './anchors';
GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
const noCrop = { top: 0, right: 0, bottom: 0, left: 0 };
export function PdfView(props: EngineProps) {
  const { t } = useReaderI18n();
  const [pdf, setPdf] = useState<PDFDocumentProxy>();
  const [page, setPage] = useState(1);
  const [crop, setCrop] = useState(noCrop);
  const canvas = useRef<HTMLCanvasElement>(null);
  const text = useRef<HTMLDivElement>(null);
  const container = useRef<HTMLDivElement>(null);
  const current = useRef(props); current.current = props;
  const currentPage = useRef(page); currentPage.current = page;
  const selection = (): SelectionAnchor | undefined => {
    const selected = window.getSelection();
    if (!selected?.toString().trim() || !container.current?.contains(selected.anchorNode)) return;
    const rects = selected.rangeCount ? [...selected.getRangeAt(0).getClientRects()] : [];
    const canvasRect = canvas.current?.getBoundingClientRect();
    const rectangles = canvasRect ? rects.map(rect => ({ x: (rect.x - canvasRect.x) / canvasRect.width, y: (rect.y - canvasRect.y) / canvasRect.height, width: rect.width / canvasRect.width, height: rect.height / canvasRect.height })) : [];
    return { quote: selected.toString().trim(), locator: JSON.stringify({ page: currentPage.current, offset: 0, rectangles }) };
  };
  useEffect(() => {
    let cancelled = false;
    let task: ReturnType<typeof getDocument> | undefined;
    void (async () => {
      const source = props.source ? { data: new Uint8Array(await props.source.arrayBuffer()) } : props.file.url ? { url: props.file.url } : undefined;
      if (!source) throw new ReaderError('pdfUnavailable');
      task = getDocument({ ...source, useSystemFonts: true });
      const document = await task.promise;
      if (cancelled) { await document.destroy(); return; }
      setPdf(document); setPage(parsePageAnchor(props.initialAnchor?.locator, document.numPages).page);
      current.current.onReady({
        next: () => setPage(value => Math.min(document.numPages, value + 1)), prev: () => setPage(value => Math.max(1, value - 1)),
        goTo: locator => setPage(typeof locator === 'number' ? Math.max(1, Math.min(document.numPages, locator)) : parsePageAnchor(locator, document.numPages).page), selection,
        search: async query => {
          const results = [];
          for (let number = 1; number <= document.numPages; number++) {
            const pdfPage = await document.getPage(number);
            const content = await pdfPage.getTextContent();
            const value = content.items.map(item => 'str' in item ? item.str : '').join(' ');
            const index = value.toLowerCase().indexOf(query.toLowerCase());
            if (number !== currentPage.current) pdfPage.cleanup();
            if (index >= 0) results.push({ locator: pageLocator(number), label: t('page', { number }), pageNumber: number, excerpt: value.slice(Math.max(0, index - 45), index + query.length + 90) });
            if (results.length >= 100) break;
          }
          return results;
        },
        autoCrop: () => { const element = canvas.current; const context = element?.getContext('2d'); if (element && context) setCrop(detectContentBounds(context.getImageData(0, 0, element.width, element.height).data, element.width, element.height)); },
        resetCrop: () => setCrop(noCrop),
      }, Array.from({ length: document.numPages }, (_, index) => ({ label: t('page', { number: index + 1 }), pageNumber: index + 1, href: pageLocator(index + 1) })));
    })().catch(error => { if (!cancelled) current.current.onError(readerError(error, 'pdfFailed')); });
    return () => { cancelled = true; void task?.destroy(); };
  }, [props.book.id, props.file.id, props.file.url, props.source]);
  useEffect(() => {
    if (!pdf) return;
    let cancelled = false;
    let renderTask: ReturnType<Awaited<ReturnType<PDFDocumentProxy['getPage']>>['render']> | undefined;
    let textLayer: TextLayer | undefined;
    const render = async () => {
      const pdfPage = await pdf.getPage(page);
      if (cancelled || !canvas.current || !text.current) return;
      const original = pdfPage.getViewport({ scale: 1 });
      const width = Math.min(1050, (container.current?.clientWidth || 800) - 48);
      const scale = width / original.width;
      const viewport = pdfPage.getViewport({ scale });
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      canvas.current.width = Math.floor(viewport.width * ratio); canvas.current.height = Math.floor(viewport.height * ratio);
      canvas.current.style.width = `${viewport.width}px`; canvas.current.style.height = `${viewport.height}px`;
      text.current.style.width = `${viewport.width}px`; text.current.style.height = `${viewport.height}px`;
      text.current.style.setProperty('--scale-factor', String(scale));
      text.current.replaceChildren();
      renderTask = pdfPage.render({ canvas: canvas.current, viewport, transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0] });
      await renderTask.promise;
      if (cancelled) return;
      textLayer = new TextLayer({ textContentSource: await pdfPage.getTextContent(), container: text.current, viewport });
      await textLayer.render();
      current.current.onLocation(pageLocator(page), (page - 1) / Math.max(1, pdf.numPages - 1), t('pageOf', { number: page, count: pdf.numPages }));
    };
    void render().catch(error => { if (!cancelled && error?.name !== 'RenderingCancelledException') current.current.onError(readerError(error, 'renderFailed')); });
    return () => { cancelled = true; renderTask?.cancel(); textLayer?.cancel(); };
  }, [pdf, page]);
  useEffect(() => {
    const selected = () => current.current.onSelection(selection());
    document.addEventListener('selectionchange', selected);
    return () => document.removeEventListener('selectionchange', selected);
  }, []);
  return <div className="avid-pdf-scroll" ref={container}>
    <div className="avid-pdf-crop-controls"><span>{t('trimMargins')}</span>{(['top', 'right', 'bottom', 'left'] as const).map(side => <label key={side}>{t(side)}<input aria-label={t('crop', { side: t(side) })} type="range" min="0" max="40" value={crop[side] * 100} onChange={event => setCrop(value => ({ ...value, [side]: Number(event.target.value) / 100 }))} /></label>)}</div>
    <div className="avid-pdf-page" style={{ clipPath: `inset(${crop.top * 100}% ${crop.right * 100}% ${crop.bottom * 100}% ${crop.left * 100}%)` }}><canvas ref={canvas} aria-label={t('pdfPage', { number: page })} /><div className="textLayer" ref={text} />
      {props.annotations.filter(annotation => !annotation.deleted && annotation.bookId === props.book.id && annotation.fileId === props.file.id).map(annotation => {
        try { const locator = JSON.parse(annotation.locator); return locator.page === page ? (locator.rectangles ?? []).map((rect: { x: number; y: number; width: number; height: number }, index: number) => <span key={`${annotation.id}-${index}`} className="avid-pdf-highlight" style={{ left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.width * 100}%`, height: `${rect.height * 100}%`, background: annotation.color }} />) : null; } catch { return null; }
      })}
    </div>
  </div>;
}
