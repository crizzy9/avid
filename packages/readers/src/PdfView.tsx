import { useReaderI18n, ReaderError, readerError } from './readerI18n';
import { useEffect, useRef, useState } from 'react';
import { GlobalWorkerOptions, getDocument, TextLayer, type PDFDocumentProxy } from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import './pdfTextLayer.css';
import type { EngineProps, SelectionAnchor } from './contracts';
import { detectContentBounds, pageLocator, parsePageAnchor } from './anchors';
import { usePageSlide } from './pageSlide';
import {useSelectionI18n} from './selectionMessages';
import {pdfLayout,pdfOutputRatio,pdfSelectionRectangles,savedPdfRectangles} from './pdfGeometry';
GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
const noCrop = { top: 0, right: 0, bottom: 0, left: 0 };
export function PdfView(props: EngineProps) {
  const { t } = useReaderI18n();
  const {t:labels}=useSelectionI18n();
  const [pdf, setPdf] = useState<PDFDocumentProxy>();
  const [page, setPage] = useState(1);
  const [crop, setCrop] = useState(noCrop);
  const [fit,setFit]=useState<'width'|'page'>('width'),[available,setAvailable]=useState({width:1,height:1}),[layout,setLayout]=useState<ReturnType<typeof pdfLayout>>();
  const canvas = useRef<HTMLCanvasElement>(null);
  const text = useRef<HTMLDivElement>(null);
  const container = useRef<HTMLDivElement>(null);
  const pageSurface = useRef<HTMLDivElement>(null);
  const controls=useRef<HTMLDivElement>(null),renderChain=useRef<Promise<void>>(Promise.resolve()),renderedPage=useRef<number|null>(null),reportedPage=useRef<number|null>(null);
  const pageDisplayed = usePageSlide(pageSurface, { identity: JSON.stringify([props.book.id, props.file.id]), enabled: props.settings.animation === 'slide', direction: props.settings.direction });
  const current = useRef(props); current.current = props;
  const currentPage = useRef(page); currentPage.current = page;
  const selection = (): SelectionAnchor | undefined => {
    const selected = window.getSelection();
    if(renderedPage.current!==currentPage.current || !selected?.rangeCount || !selected.toString().trim())return;
    const range=selected.getRangeAt(0);
    if(!text.current?.contains(range.startContainer)||!text.current.contains(range.endContainer))return;
    const rects = Array.from(range.getClientRects());
    const canvasRect = canvas.current?.getBoundingClientRect();
    const rectangles = canvasRect ? pdfSelectionRectangles(rects,canvasRect) : [];
    if(!rectangles.length)return;
    return { quote: selected.toString().trim(), locator: JSON.stringify({ page: currentPage.current, offset: 0, rectangles }) };
  };
  useEffect(()=>{
    const element=container.current;if(!element)return;
    const measure=()=>{
      const style=getComputedStyle(element),horizontal=(parseFloat(style.paddingLeft)||0)+(parseFloat(style.paddingRight)||0),vertical=(parseFloat(style.paddingTop)||0)+(parseFloat(style.paddingBottom)||0);
      const width=Math.max(1,element.clientWidth-horizontal),height=Math.max(1,element.clientHeight-vertical-(controls.current?.offsetHeight??0)-16);
      setAvailable(old=>Math.abs(old.width-width)<.5&&Math.abs(old.height-height)<.5?old:{width,height});
    };
    measure();const observer=typeof ResizeObserver==='undefined'?undefined:new ResizeObserver(measure);observer?.observe(element);if(controls.current)observer?.observe(controls.current);
    window.addEventListener('resize',measure);return()=>{observer?.disconnect();window.removeEventListener('resize',measure);};
  },[]);
  useEffect(() => {
    let cancelled = false;
    let task: ReturnType<typeof getDocument> | undefined;
    setPdf(undefined);setLayout(undefined);setCrop(noCrop);renderedPage.current=null;reportedPage.current=null;
    void (async () => {
      const source = props.source ? { data: new Uint8Array(await props.source.arrayBuffer()) } : props.file.url ? { url: props.file.url } : undefined;
      if(cancelled)return;
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
            if(cancelled)return[];
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
        autoCrop: () => { const element = canvas.current; const context = element?.getContext('2d'); if (element && context && renderedPage.current===currentPage.current) setCrop(detectContentBounds(context.getImageData(0, 0, element.width, element.height).data, element.width, element.height)); },
        resetCrop: () => setCrop(noCrop),
      }, Array.from({ length: document.numPages }, (_, index) => ({ label: t('page', { number: index + 1 }), pageNumber: index + 1, href: pageLocator(index + 1) })));
    })().catch(error => { if (!cancelled) current.current.onError(readerError(error, 'pdfFailed')); });
    return () => { cancelled = true; void task?.destroy(); };
  }, [props.book.id, props.file.id, props.file.url, props.source,props.accountScope]);
  useEffect(() => {
    if (!pdf) return;
    let cancelled = false;
    let renderTask: ReturnType<Awaited<ReturnType<PDFDocumentProxy['getPage']>>['render']> | undefined;
    let textLayer: TextLayer | undefined;
    renderedPage.current=null;current.current.onSelection(undefined);
    const render = async () => {
      if(cancelled)return;
      const pdfPage = await pdf.getPage(page);
      if (cancelled || !canvas.current || !text.current) return;
      const geometry=pdfLayout(pdfPage.getViewport({scale:1}),available,crop,fit);setLayout(geometry);
      const scale = geometry.scale;
      const viewport = pdfPage.getViewport({ scale });
      const ratio = pdfOutputRatio(viewport.width,viewport.height,window.devicePixelRatio);
      canvas.current.width = Math.max(1,Math.floor(viewport.width * ratio)); canvas.current.height = Math.max(1,Math.floor(viewport.height * ratio));
      canvas.current.style.width = `${viewport.width}px`; canvas.current.style.height = `${viewport.height}px`;
      text.current.style.width = `${viewport.width}px`; text.current.style.height = `${viewport.height}px`;
      text.current.style.setProperty('--scale-factor', String(scale));
      // PDF.js 5 text glyphs and layer dimensions use the same CSS scale as the
      // canvas, including a PDF's optional UserUnit; backing-store DPR is separate.
      text.current.style.setProperty('--total-scale-factor', String(scale * viewport.userUnit));
      text.current.style.setProperty('--scale-round-x', '1px');
      text.current.style.setProperty('--scale-round-y', '1px');
      text.current.replaceChildren();
      renderTask = pdfPage.render({ canvas: canvas.current, viewport, transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0] });
      await renderTask.promise;
      if (cancelled) return;
      const content=await pdfPage.getTextContent();if(cancelled || !text.current)return;
      textLayer = new TextLayer({ textContentSource:content, container: text.current, viewport });
      await textLayer.render();
      if (cancelled) return;
      renderedPage.current=page;pageDisplayed(page);
      if(reportedPage.current!==page){reportedPage.current=page;current.current.onLocation(pageLocator(page), (page - 1) / Math.max(1, pdf.numPages - 1), t('pageOf', { number: page, count: pdf.numPages }),{pageNumber:page,pageCount:pdf.numPages});}
    };
    renderChain.current=renderChain.current.catch(()=>{}).then(render);
    void renderChain.current.catch(error => { if (!cancelled && error?.name !== 'RenderingCancelledException') current.current.onError(readerError(error, 'renderFailed')); });
    return () => { cancelled = true; renderTask?.cancel(); textLayer?.cancel(); };
  }, [pdf, page,available,crop,fit]);
  useEffect(() => {
    const selected = () => current.current.onSelection(selection());
    document.addEventListener('selectionchange', selected);
    return () => document.removeEventListener('selectionchange', selected);
  }, []);
  return <div className="avid-pdf-scroll" ref={container}>
    <div className="avid-pdf-crop-controls" ref={controls}><label>{labels('pdfFit')}<select value={fit} onChange={event=>setFit(event.target.value as 'width'|'page')}><option value="width">{labels('fitWidth')}</option><option value="page">{labels('fitPage')}</option></select></label><span>{t('trimMargins')}</span>{(['top', 'right', 'bottom', 'left'] as const).map(side => <label key={side}>{t(side)}<input aria-label={t('crop', { side: t(side) })} type="range" min="0" max="40" value={crop[side] * 100} onChange={event => setCrop(value => ({ ...value, [side]: Number(event.target.value) / 100 }))} /></label>)}</div>
    <div className="avid-pdf-clip" style={{width:layout?.visibleWidth,height:layout?.visibleHeight}}><div className="avid-pdf-page" ref={pageSurface} style={{width:layout?.width,height:layout?.height,left:-(layout?.left??0),top:-(layout?.top??0)}}><canvas ref={canvas} aria-label={t('pdfPage', { number: page })} /><div className="textLayer" ref={text} />
      {props.annotations.filter(annotation => !annotation.deleted && annotation.bookId === props.book.id && annotation.fileId === props.file.id).flatMap(annotation => savedPdfRectangles(annotation.locator,page).map((rect,index)=><span key={`${annotation.id}-${index}`} className="avid-pdf-highlight" style={{left:`${rect.x*100}%`,top:`${rect.y*100}%`,width:`${rect.width*100}%`,height:`${rect.height*100}%`,backgroundColor:annotation.color}}/>))}
    </div></div>
  </div>;
}
