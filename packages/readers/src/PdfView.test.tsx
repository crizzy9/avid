// @vitest-environment jsdom
import {act} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {beforeEach,afterEach,expect,it,vi} from 'vitest';
import {PdfView} from './PdfView';
import {defaultSettings,type EngineProps,type EngineHandle} from './contracts';
import {setLocale} from '../../i18n/src';
const fixture=vi.hoisted(()=>({renderGate:undefined as Promise<void>|undefined,render:vi.fn(),getDocument:vi.fn(),cancel:vi.fn(),resize:()=>{},width:1200}));
vi.mock('pdfjs-dist',()=>({GlobalWorkerOptions:{},getDocument:(...args:unknown[])=>{
  fixture.getDocument(...args);return {destroy:async()=>{},promise:Promise.resolve({numPages:2,destroy:async()=>{},getPage:async(page:number)=>({
    getViewport:({scale}:{scale:number})=>({width:600*scale,height:800*scale,userUnit:2,scale}),
    render:(options:unknown)=>{fixture.render(options);return{promise:fixture.renderGate??Promise.resolve(),cancel:fixture.cancel};},
    getTextContent:async()=>({items:[{str:`Original page ${page}` }]}),cleanup:()=>{},
  })})};
},TextLayer:class{container:HTMLElement;constructor({container}:{container:HTMLElement}){this.container=container;}async render(){this.container.innerHTML='<span>Original PDF passage</span>';}cancel(){}}}));
let root:Root,host:HTMLDivElement,props:EngineProps,handle:EngineHandle;
const render=()=>act(async()=>root.render(<PdfView {...props}/>));
beforeEach(()=>{
  setLocale('en');vi.clearAllMocks();fixture.renderGate=undefined;fixture.width=1200;Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});
  vi.stubGlobal('ResizeObserver',class{constructor(callback:()=>void){fixture.resize=callback;}observe(){}disconnect(){}});
  vi.spyOn(HTMLElement.prototype,'clientWidth','get').mockImplementation(function(this:HTMLElement){return this.classList.contains('avid-pdf-scroll')?fixture.width:0;});
  vi.spyOn(HTMLElement.prototype,'clientHeight','get').mockReturnValue(900);vi.spyOn(HTMLElement.prototype,'offsetHeight','get').mockReturnValue(44);
  vi.spyOn(HTMLCanvasElement.prototype,'getBoundingClientRect').mockImplementation(function(this:HTMLCanvasElement){return {left:0,top:0,width:parseFloat(this.style.width),height:parseFloat(this.style.height)} as DOMRect;});
  Object.defineProperty(window,'devicePixelRatio',{configurable:true,value:2});
  host=document.createElement('div');document.body.append(host);root=createRoot(host);
  const book={id:'pdf',title:'Original PDF',authors:[],description:'',format:'PDF' as const,color:'',progress:0,status:'unread' as const,genres:[],addedAt:'',files:[{id:'file',name:'original.pdf',format:'PDF' as const,url:'blob:original-pdf'}]};
  props={book,file:book.files[0]!,settings:defaultSettings,annotations:[],onClose:vi.fn(),onAnchor:vi.fn(),onAnnotation:vi.fn(),onReady:value=>{handle=value;},onLocation:vi.fn(),onError:vi.fn(),onNotice:vi.fn(),onSelection:vi.fn(),onSpeaking:vi.fn(),onMediaState:vi.fn()};
});
afterEach(async()=>{await act(async()=>root.unmount());window.getSelection()?.removeAllRanges();host.remove();vi.restoreAllMocks();vi.unstubAllGlobals();});
it('uses the full measured width and PDF user unit for text, independent of canvas DPR',async()=>{
  await render();const canvas=host.querySelector('canvas')!,text=host.querySelector<HTMLElement>('.textLayer')!;
  expect(canvas.style.width).toBe('1200px');expect(canvas.width).toBe(2400);expect(text.style.width).toBe('1200px');expect(text.style.getPropertyValue('--total-scale-factor')).toBe('4');
  expect(props.onError).not.toHaveBeenCalled();expect(props.onLocation).toHaveBeenCalledOnce();
  fixture.width=720;await act(async()=>fixture.resize());expect(canvas.style.width).toBe('720px');expect(text.style.getPropertyValue('--total-scale-factor')).toBe('2.4');expect(props.onLocation).toHaveBeenCalledOnce();
});
it('fits the whole page or cropped visible width without moving the saved checkpoint',async()=>{
  await render();const fit=host.querySelector('select')!;
  await act(async()=>{fit.value='page';fit.dispatchEvent(new Event('change',{bubbles:true}));});
  expect(host.querySelector('canvas')!.style.height).toBe('840px');
  await act(async()=>{fit.value='width';fit.dispatchEvent(new Event('change',{bubbles:true}));});
  const left=host.querySelector<HTMLInputElement>('input[aria-label="Left crop"]')??[...host.querySelectorAll<HTMLInputElement>('input')].at(-1)!;
  await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(left,'20');left.dispatchEvent(new Event('input',{bubbles:true}));});
  expect(host.querySelector<HTMLElement>('.avid-pdf-clip')!.style.width).toBe('1200px');expect(host.querySelector('canvas')!.style.width).toBe('1500px');expect(host.querySelector<HTMLElement>('.avid-pdf-page')!.style.left).toBe('-300px');expect(props.onLocation).toHaveBeenCalledOnce();
});
it('records word rectangles in page coordinates and does not select old text while next page renders',async()=>{
  await render();const text=host.querySelector('.textLayer span')!.firstChild!,range=document.createRange();range.selectNodeContents(text);
  range.getClientRects=()=>[{left:120,top:160,width:240,height:40}] as unknown as DOMRectList;
  window.getSelection()!.addRange(range);const selection=handle.selection()!;
  expect(JSON.parse(selection.locator)).toEqual({page:1,offset:0,rectangles:[{x:.1,y:.1,width:.2,height:.025}]});expect(selection.quote).toBe('Original PDF passage');
  props.annotations=[{id:'a',bookId:'pdf',fileId:'file',locator:selection.locator,kind:'highlight',quote:selection.quote,text:'',color:'#d6b96e',createdAt:'',updatedAt:''}];await render();
  expect(host.querySelector<HTMLElement>('.avid-pdf-highlight')?.style.left).toBe('10%');
  let finish!:()=>void;fixture.renderGate=new Promise<void>(resolve=>{finish=resolve;});await act(async()=>handle.next());expect(handle.selection()).toBeUndefined();expect(host.querySelector('.avid-pdf-highlight')).toBeNull();
  await act(async()=>finish());expect(props.onLocation).toHaveBeenLastCalledWith(JSON.stringify({page:2,offset:0}),1,'Page 2 of 2',{pageNumber:2,pageCount:2});
});
it('does not start an old PDF load after its asynchronous source is replaced',async()=>{
  let resolve!: (bytes:ArrayBuffer)=>void;const source={arrayBuffer:()=>new Promise<ArrayBuffer>(done=>{resolve=done;})} as Blob;
  props.source=source;await render();expect(fixture.getDocument).not.toHaveBeenCalled();props.source=undefined;await render();expect(fixture.getDocument).toHaveBeenCalledOnce();
  await act(async()=>resolve(new ArrayBuffer(8)));expect(fixture.getDocument).toHaveBeenCalledOnce();
});
