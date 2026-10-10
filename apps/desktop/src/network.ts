import {convertFileSrc,invoke,isTauri} from '@tauri-apps/api/core';
import {listen} from '@tauri-apps/api/event';
import type {NativeSessionVault} from '../../mobile/src/native-session';
import type {NativeAuthPlugin} from '../../mobile/src/native-auth';
import type {PlaybackBook} from '../../../packages/playback/src';

const vault:NativeSessionVault={
  read:()=>invoke('desktop_session_read'),
  write:request=>invoke('desktop_session_write',{request}),
  clear:(request={})=>invoke('desktop_session_clear',{request}),
};
const auth:NativeAuthPlugin={
  authenticate:request=>invoke('desktop_authenticate',{request}),
  refresh:request=>invoke('desktop_refresh',{request}),
  addListener:async(_event,callback)=>{
    const remove=await listen<{generation:string;accountScope:string}>('avid:desktop-session',event=>callback(event.payload));
    return {remove:async()=>remove()};
  },
};
export function getDesktopSessionVault():NativeSessionVault|null{return isTauri()?vault:null;}
export function getDesktopAuth():NativeAuthPlugin|null{return isTauri()?auth:null;}
export interface DesktopHttpHead {id:string;status:number;statusText:string;headers:[string,string][]}
export interface DesktopHttpBridge {
  open(request:{url:string;method:string;headers:[string,string][];bodyBase64?:string},signal?:AbortSignal):Promise<DesktopHttpHead>;
  read(request:{id:string}):Promise<{bytes:number[];done:boolean}>;
  close(request:{id:string}):Promise<void>;
}
const http:DesktopHttpBridge={
  open:request=>invoke('desktop_http_open',{request}),
  read:request=>invoke('desktop_http_read',{request}),
  close:request=>invoke('desktop_http_close',{request}),
};
function encode(bytes:Uint8Array):string{let raw='';for(let offset=0;offset<bytes.length;offset+=8192)raw+=String.fromCharCode(...bytes.subarray(offset,offset+8192));return btoa(raw);}
/** Native responses cross IPC in bounded chunks and retain fetch cancellation semantics. */
export function createDesktopFetch(bridge:DesktopHttpBridge,maxUploadBytes=64*1024*1024):typeof fetch {
  return async(input,init)=>{
    const request=new Request(input,init);
    const signal=request.signal;
    signal.throwIfAborted();
    const outbound=!["GET","HEAD"].includes(request.method)?new Uint8Array(await request.arrayBuffer()):undefined;
    if(outbound && outbound.length>maxUploadBytes)throw new Error('Desktop uploads support a maximum request size of 64 MiB.');
    signal.throwIfAborted();
    const head=await bridge.open({url:request.url,method:request.method,headers:[...request.headers.entries()],...(outbound?.length?{bodyBase64:encode(outbound)}:{})},signal);
    let closed=false;
    const close=async()=>{if(!closed){closed=true;await bridge.close({id:head.id}).catch(()=>{});}};
    if(signal.aborted){await close();signal.throwIfAborted();}
    if(!Number.isInteger(head.status)||head.status<200||head.status>599){await close();throw new Error('The native HTTP response is invalid.');}
    if(request.method==='HEAD'||[204,205,304].includes(head.status)) {await close();return new Response(null,{status:head.status,statusText:head.statusText,headers:head.headers});}
    let controller:ReadableStreamDefaultController<Uint8Array>|undefined;
    const abort=()=>{if(!closed){controller?.error(signal.reason??new DOMException('Request aborted.','AbortError'));void close();}};
    const stream=new ReadableStream<Uint8Array>({
      start(value){controller=value;signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();},
      async pull(value){
        if(closed)return;
        try {
          const next=await bridge.read({id:head.id});
          if(closed)return;
          if(next.bytes.length>256*1024 || next.bytes.some(byte=>!Number.isInteger(byte)||byte<0||byte>255))throw new Error('The native HTTP response chunk is invalid.');
          if(next.bytes.length)value.enqueue(new Uint8Array(next.bytes));
          if(next.done){signal.removeEventListener('abort',abort);await close();value.close();}
        }catch(error){signal.removeEventListener('abort',abort);if(!closed){await close();value.error(error);}}
      },
      async cancel(){signal.removeEventListener('abort',abort);await close();},
    });
    return new Response(stream,{status:head.status,statusText:head.statusText,headers:head.headers});
  };
}
const nativeFetch=createDesktopFetch(http);
/** Only BookOrbit requests should use this adapter; local object URLs retain WebView fetch. */
export function getDesktopFetch():typeof fetch|null{return isTauri()?nativeFetch:null;}
export interface DesktopMediaBridge {sources(request:{accountScope:string;urls:string[]}):Promise<{ids:string[]}>;url(id:string):string}
const media:DesktopMediaBridge={sources:request=>invoke('desktop_media_sources',{request}),url:id=>convertFileSrc(id,'avid-media')};
/** Replaces authenticated server audio with scoped native range resources; source IDs remain canonical. */
export async function resolveDesktopPlaybackBook(book:PlaybackBook,accountScope:string,isCurrent:()=>boolean,bridge:DesktopMediaBridge=media):Promise<PlaybackBook>{
  if(!isCurrent())throw new Error('The playback account changed.');
  const remote=book.tracks.filter(track=>/^https?:\/\//i.test(track.url));
  if(!remote.length)return book;
  const result=await bridge.sources({accountScope,urls:remote.map(track=>track.url)});
  if(!isCurrent())throw new Error('The playback account changed.');
  if(result.ids.length!==remote.length||new Set(result.ids).size!==result.ids.length||result.ids.some(id=>!/^[0-9a-f-]{36}$/i.test(id)))throw new Error('The native audio resource response is invalid.');
  let index=0;
  return {...book,tracks:book.tracks.map(track=>/^https?:\/\//i.test(track.url)?{...track,url:bridge.url(result.ids[index++]!)}:{...track})};
}
