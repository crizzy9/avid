// @vitest-environment jsdom
import {act} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {beforeEach,afterEach,expect,it,vi} from 'vitest';
import {Reader} from './Reader';
import {isOnlineBookOrbitVoice} from './voiceDisclosure';
import {registerOnlineSpeechProvider} from '../../playback/src/speechRuntime';
import {setLocale,LOCALES} from '../../i18n/src';
import {selectionTranslate} from './selectionMessages';
vi.mock('./EbookView',()=>({EbookView:()=>null}));vi.mock('./PdfView',()=>({PdfView:()=>null}));vi.mock('./ComicView',()=>({ComicView:()=>null}));
let root:Root,host:HTMLDivElement;
const uri='avid-online:configured-provider:voice',speak=vi.fn();
beforeEach(()=>{localStorage.clear();setLocale('en');Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});HTMLDialogElement.prototype.showModal=function(){this.open=true;};HTMLDialogElement.prototype.close=function(){this.open=false;};host=document.createElement('div');document.body.append(host);root=createRoot(host);registerOnlineSpeechProvider({available:true,handlesVoice:value=>value===uri,voices:async()=>[{voiceURI:uri,name:'Voice · Provider',lang:'en',localService:false,default:false}],subscribeVoices:()=>()=>{},createPlayer:()=>({speak,cancel:()=>{},destroy:()=>{}})});});
afterEach(async()=>{await act(async()=>root.unmount());registerOnlineSpeechProvider(null);host.remove();});
it('only labels explicitly namespaced server voices as BookOrbit online voices',()=>{expect(isOnlineBookOrbitVoice(uri)).toBe(true);expect(isOnlineBookOrbitVoice('remote-browser-voice')).toBe(false);expect(isOnlineBookOrbitVoice('')).toBe(false);});
it('discloses the destination and network requirement before online narration, in all seven locales',async()=>{
  const book={id:'book',title:'Original book',authors:[],description:'',format:'EPUB' as const,color:'',progress:0,status:'unread' as const,genres:[],addedAt:'',files:[{id:'file',name:'original.epub',format:'EPUB' as const}]};
  await act(async()=>root.render(<Reader book={book} annotations={[]} onClose={()=>{}} onAnchor={()=>{}} onAnnotation={()=>{}}/>));await act(async()=>host.querySelector<HTMLButtonElement>('button[aria-label="Reading settings"]')!.click());
  expect(host.querySelector('.reader-online-voice')).toBeNull();const voice=[...host.querySelectorAll('select')].find(select=>[...select.options].some(option=>option.value===uri))!;
  await act(async()=>{voice.value=uri;voice.dispatchEvent(new Event('change',{bubbles:true}));});
  for(const {code} of LOCALES){await act(async()=>setLocale(code));expect(host.querySelector('.reader-online-voice')?.textContent).toContain(selectionTranslate('onlineVoiceHint',{},code));}
  expect(speak).not.toHaveBeenCalled();
  await act(async()=>{voice.value='';voice.dispatchEvent(new Event('change',{bubbles:true}));});expect(host.querySelector('.reader-online-voice')).toBeNull();
});
