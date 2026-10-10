import { Capacitor, registerPlugin } from '@capacitor/core';
import type { PlaybackBook } from '../../../packages/playback/src';

export interface NativeMediaIdentity { accountScope:string;bookId:string;fileId:string;trackId:string }
export interface NativeMediaStorePlugin {
  begin(value:NativeMediaIdentity & {size:number;mime:string}):Promise<{id:string}>;
  append(value:{id:string;offset:number;dataBase64:string}):Promise<void>;
  finish(value:{id:string}):Promise<{url:string}>;
  cancel(value:{id:string}):Promise<void>;
  validate(value:NativeMediaIdentity & {url:string}):Promise<{valid:boolean}>;
}
const native = registerPlugin<NativeMediaStorePlugin>('AvidMediaStore');
export function getNativeMediaStore():NativeMediaStorePlugin|null {
  return Capacitor.isNativePlatform() && Capacitor.isPluginAvailable('AvidMediaStore') ? native : null;
}
const CHUNK_BYTES = 256 * 1024;
const FILE_LIMIT = 4 * 1024 * 1024 * 1024;
const memo = new Map<string,string>();
function check(current:()=>boolean) { if (!current()) throw new Error('The playback account or source changed during import.'); }
function base64(bytes:Uint8Array):string {
  let value='';
  for (let start=0;start<bytes.length;start+=8192) value+=String.fromCharCode(...bytes.subarray(start,start+8192));
  return btoa(value);
}
export interface NativeMediaResolveOptions {
  isCurrent:()=>boolean;
  /** Inject a bridge/fetch for boundary tests; production uses the registered native store. */
  plugin?:NativeMediaStorePlugin|null;
  fetchBlob?:(url:string)=>Promise<Blob>;
}
async function localBlob(url:string):Promise<Blob> {
  // Capacitor 8.5.3 retains the WebView fetch before its HTTP patch. A blob belongs to the
  // WebView; sending it through a native HTTP proxy cannot resolve its private object URL.
  const host=globalThis as typeof globalThis & {CapacitorWebFetch?:typeof fetch};
  const browserFetch=host.CapacitorWebFetch?.bind(globalThis) ?? globalThis.fetch.bind(globalThis);
  const response=await browserFetch(url);
  if (!response.ok) throw new Error('The imported audio file is no longer available.');
  return response.blob();
}
/** Copy only local blobs in bounded chunks. Server streams retain their authenticated URLs. */
export async function resolveNativePlaybackBook(book:PlaybackBook,accountScope:string,options:NativeMediaResolveOptions):Promise<PlaybackBook> {
  check(options.isCurrent);
  let coverUrl=book.coverUrl;
  if(coverUrl?.startsWith('blob:')) {
    // Artwork is optional: expired/oversized object URLs must not prevent audio playback.
    try {
      const artwork=await (options.fetchBlob ?? localBlob)(coverUrl);
      check(options.isCurrent);
      coverUrl=artwork.size>0 && artwork.size<=2*1024*1024 && /^image\/(jpeg|png|webp)$/.test(artwork.type)
        ? `data:${artwork.type};base64,${base64(new Uint8Array(await artwork.arrayBuffer()))}` : undefined;
    } catch { coverUrl=undefined; }
    check(options.isCurrent);
  }
  if (!book.tracks.some(track=>track.url.startsWith('blob:'))) return coverUrl===book.coverUrl?book:{...book,coverUrl};
  const plugin=options.plugin === undefined ? getNativeMediaStore() : options.plugin;
  if (!plugin) throw new Error('This native host does not support imported audio files. Update Avid to continue.');
  const tracks=[];
  for (const track of book.tracks) {
    check(options.isCurrent);
    if (!track.url.startsWith('blob:')) { tracks.push({...track}); continue; }
    const identity={accountScope,bookId:book.bookId,fileId:book.fileId,trackId:track.id};
    const key=JSON.stringify([accountScope,book.bookId,book.fileId,track.id,track.url]);
    const cached=memo.get(key);
    if (cached && (await plugin.validate({...identity,url:cached})).valid) {
      check(options.isCurrent); tracks.push({...track,url:cached}); continue;
    }
    memo.delete(key);
    const blob=await (options.fetchBlob ?? localBlob)(track.url);
    check(options.isCurrent);
    if (!blob.size || blob.size>FILE_LIMIT) throw new Error('Native audio imports support files up to 4 GB.');
    const {id}=await plugin.begin({...identity,size:blob.size,mime:blob.type || 'application/octet-stream'});
    let complete=false;
    try {
      for (let offset=0;offset<blob.size;offset+=CHUNK_BYTES) {
        check(options.isCurrent);
        const bytes=new Uint8Array(await blob.slice(offset,Math.min(blob.size,offset+CHUNK_BYTES)).arrayBuffer());
        check(options.isCurrent);
        await plugin.append({id,offset,dataBase64:base64(bytes)});
      }
      check(options.isCurrent);
      const result=await plugin.finish({id});
      complete=true;
      check(options.isCurrent);
      if (!/^file:/i.test(result.url) || !(await plugin.validate({...identity,url:result.url})).valid) throw new Error('The native audio store did not return a valid file receipt.');
      check(options.isCurrent);
      memo.set(key,result.url);
      while (memo.size>20) memo.delete(memo.keys().next().value!);
      tracks.push({...track,url:result.url});
    } finally { if (!complete) await plugin.cancel({id}).catch(()=>{}); }
  }
  return {...book,tracks,...(coverUrl!==book.coverUrl?{coverUrl}:{})};
}
