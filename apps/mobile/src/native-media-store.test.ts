import {describe,expect,it,vi} from 'vitest';
import {resolveNativePlaybackBook,type NativeMediaStorePlugin} from './native-media-store';
import type {PlaybackBook} from '../../../packages/playback/src';

const scope='["https://demo.avid.invalid","demo"]';
let serial=0;
function book():PlaybackBook{return {bookId:`local-${++serial}`,fileId:'audio',title:'Local book',authors:['Author'],manifestRevision:'edition-2',tracks:[{id:'one',url:'blob:local',duration:60}],chapters:[{id:'chapter',title:'Chapter',start:0,duration:60}]};}
function bridge():NativeMediaStorePlugin{return {begin:vi.fn(async()=>({id:'transfer'})),append:vi.fn(async()=>{}),finish:vi.fn(async()=>({url:'file:///private/receipt.audio'})),cancel:vi.fn(async()=>{}),validate:vi.fn(async()=>({valid:true}))};}
describe('native media transfer boundary',()=>{
  it('copies bounded, ordered chunks and preserves canonical identity and duration',async()=>{
    const source=book(),plugin=bridge();const bytes=new Uint8Array(600_000).fill(7);
    const result=await resolveNativePlaybackBook(source,scope,{plugin,isCurrent:()=>true,fetchBlob:async()=>new Blob([bytes],{type:'audio/mpeg'})});
    expect(plugin.begin).toHaveBeenCalledWith({accountScope:scope,bookId:source.bookId,fileId:'audio',trackId:'one',size:600_000,mime:'audio/mpeg'});
    const chunks=vi.mocked(plugin.append).mock.calls.map(([value])=>value);
    expect(chunks.map(value=>value.offset)).toEqual([0,262144,524288]);
    expect(chunks.map(value=>atob(value.dataBase64).length)).toEqual([262144,262144,75712]);
    expect(result).toEqual({...source,tracks:[{...source.tracks[0],url:'file:///private/receipt.audio'}]});
    expect(source.tracks[0]!.url).toBe('blob:local');expect(plugin.cancel).not.toHaveBeenCalled();
  });
  it('leaves remote streams alone without requiring a store or fetching the file',async()=>{
    const source=book();source.tracks[0]!.url='https://server.example/audio';const fetchBlob=vi.fn();
    expect(await resolveNativePlaybackBook(source,scope,{plugin:null,isCurrent:()=>true,fetchBlob})).toBe(source);
    expect(fetchBlob).not.toHaveBeenCalled();
  });
  it('cancels partial imports on a failed append and never finishes them',async()=>{
    const plugin=bridge();vi.mocked(plugin.append).mockRejectedValueOnce(new Error('disk full'));
    await expect(resolveNativePlaybackBook(book(),scope,{plugin,isCurrent:()=>true,fetchBlob:async()=>new Blob(['audio'])})).rejects.toThrow('disk full');
    expect(plugin.cancel).toHaveBeenCalledWith({id:'transfer'});expect(plugin.finish).not.toHaveBeenCalled();
  });
  it('stops if the account changes during a native append',async()=>{
    const plugin=bridge();let current=true;vi.mocked(plugin.append).mockImplementation(async()=>{current=false;});
    await expect(resolveNativePlaybackBook(book(),scope,{plugin,isCurrent:()=>current,fetchBlob:async()=>new Blob(['audio'])})).rejects.toThrow('account or source changed');
    expect(plugin.finish).not.toHaveBeenCalled();expect(plugin.cancel).toHaveBeenCalled();
  });
  it('validates a memoized receipt again before reuse and reimports a removed file',async()=>{
    const source=book(),plugin=bridge(),fetchBlob=vi.fn(async()=>new Blob(['audio']));const options={plugin,isCurrent:()=>true,fetchBlob};
    await resolveNativePlaybackBook(source,scope,options);await resolveNativePlaybackBook(source,scope,options);
    expect(plugin.begin).toHaveBeenCalledTimes(1);
    vi.mocked(plugin.validate).mockResolvedValueOnce({valid:false});await resolveNativePlaybackBook(source,scope,options);
    expect(plugin.begin).toHaveBeenCalledTimes(2);expect(fetchBlob).toHaveBeenCalledTimes(2);
  });
  it('rejects an arbitrary native response URI',async()=>{
    const plugin=bridge();vi.mocked(plugin.finish).mockResolvedValue({url:'content://unowned/media'});
    await expect(resolveNativePlaybackBook(book(),scope,{plugin,isCurrent:()=>true,fetchBlob:async()=>new Blob(['audio'])})).rejects.toThrow('valid file receipt');
  });
  it('rejects unsupported sizes before allocating a native transfer',async()=>{
    const plugin=bridge();const huge={size:4*1024**3+1,type:'audio/mpeg'} as Blob;
    await expect(resolveNativePlaybackBook(book(),scope,{plugin,isCurrent:()=>true,fetchBlob:async()=>huge})).rejects.toThrow('up to 4 GB');
    expect(plugin.begin).not.toHaveBeenCalled();
  });
  it('converts supported local artwork with bounded bytes and does not need an audio export',async()=>{
    const source=book();source.tracks[0]!.url='https://server.example/audio';source.coverUrl='blob:art';
    const result=await resolveNativePlaybackBook(source,scope,{plugin:null,isCurrent:()=>true,fetchBlob:async()=>new Blob(['image'],{type:'image/png'})});
    expect(result.coverUrl).toBe('data:image/png;base64,aW1hZ2U=');
  });
  it('drops unavailable artwork without hiding an account transition',async()=>{
    const source=book();source.tracks[0]!.url='https://server.example/audio';source.coverUrl='blob:art';
    const result=await resolveNativePlaybackBook(source,scope,{plugin:null,isCurrent:()=>true,fetchBlob:async()=>{throw new Error('expired');}});
    expect(result.coverUrl).toBeUndefined();
    let current=true;
    await expect(resolveNativePlaybackBook(source,scope,{plugin:null,isCurrent:()=>current,fetchBlob:async()=>{current=false;throw new Error('expired');}})).rejects.toThrow('account or source changed');
  });
});
