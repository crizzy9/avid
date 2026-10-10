import {describe,expect,it,vi} from 'vitest';
import {createDesktopFetch,resolveDesktopPlaybackBook,type DesktopHttpBridge,type DesktopMediaBridge} from './network';
import type {PlaybackBook} from '../../../packages/playback/src';
function bridge(chunks:number[][]=[[65,66],[67]]):DesktopHttpBridge{return {
  open:vi.fn(async()=>({id:'response',status:200,statusText:'OK',headers:[['content-type','text/plain']]})),
  read:vi.fn(async()=>chunks.length?{bytes:chunks.shift()!,done:false}:{bytes:[],done:true}),close:vi.fn(async()=>{}),
};}
const source:PlaybackBook={bookId:'1',fileId:'2',title:'Book',authors:['Author'],manifestRevision:'edition',tracks:[{id:'2',url:'https://books.example/api/v1/books/files/2/serve',duration:40},{id:'3',url:'blob:local',duration:30}]};
function media():DesktopMediaBridge{return {sources:vi.fn(async()=>({ids:['a1b2c3d4-1234-1234-1234-123456789abc']})),url:id=>`avid-media://localhost/${id}`};}
describe('desktop native fetch boundary',()=>{
  it('streams ordered binary chunks and closes the native response after EOF',async()=>{
    const native=bridge();const response=await createDesktopFetch(native)('https://books.example/api/v1/books');
    expect(response.headers.get('content-type')).toBe('text/plain');expect(await response.text()).toBe('ABC');
    expect(native.close).toHaveBeenCalledTimes(1);
  });
  it('serializes multipart uploads using the Request-generated boundary',async()=>{
    const native=bridge([]);const body=new FormData();body.append('file',new Blob(['epub'],{type:'application/epub+zip'}),'book.epub');
    const response=await createDesktopFetch(native)('https://books.example/api/v1/import',{method:'POST',body});await response.text();
    const request=vi.mocked(native.open).mock.calls[0]![0];
    expect(request.headers.find(([key])=>key==='content-type')?.[1]).toContain('multipart/form-data; boundary=');
    expect(atob(request.bodyBase64!)).toContain('filename="book.epub"');expect(atob(request.bodyBase64!)).toContain('epub');
  });
  it('rejects aborted requests before native allocation',async()=>{
    const native=bridge(),abort=new AbortController();abort.abort();
    await expect(createDesktopFetch(native)('https://books.example/api/v1/books',{signal:abort.signal})).rejects.toThrow();
    expect(native.open).not.toHaveBeenCalled();
  });
  it('closes a late response when cancellation happened during open',async()=>{
    const native=bridge(),abort=new AbortController();vi.mocked(native.open).mockImplementation(async()=>{abort.abort();return {id:'late',status:200,statusText:'OK',headers:[]};});
    await expect(createDesktopFetch(native)('https://books.example/api/v1/books',{signal:abort.signal})).rejects.toThrow();
    expect(native.close).toHaveBeenCalledWith({id:'late'});
  });
  it('closes a native body when the consumer cancels its stream',async()=>{
    const native=bridge([[1],[2],[3]]);const response=await createDesktopFetch(native)('https://books.example/api/v1/books');
    await response.body!.cancel();expect(native.close).toHaveBeenCalledTimes(1);
  });
  it('rejects malformed or oversized native chunks and closes the handle',async()=>{
    for(const bytes of [[256],Array.from({length:256*1024+1},()=>1)]){
      const native=bridge([bytes]);const response=await createDesktopFetch(native)('https://books.example/api/v1/books');
      await expect(response.arrayBuffer()).rejects.toThrow('chunk is invalid');expect(native.close).toHaveBeenCalledTimes(1);
    }
  });
  it('releases no-body responses without constructing a stream',async()=>{
    const native=bridge();vi.mocked(native.open).mockResolvedValue({id:'empty',status:204,statusText:'No Content',headers:[]});
    const response=await createDesktopFetch(native)('https://books.example/api/v1/books');expect(response.body).toBeNull();expect(native.read).not.toHaveBeenCalled();expect(native.close).toHaveBeenCalled();
  });
});
describe('desktop authenticated media mapping',()=>{
  it('replaces server URLs with opaque range handles while preserving source identity',async()=>{
    const native=media();const value=await resolveDesktopPlaybackBook(source,'scope',()=>true,native);
    expect(native.sources).toHaveBeenCalledWith({accountScope:'scope',urls:[source.tracks[0]!.url]});
    expect(value.tracks[0]).toEqual({...source.tracks[0],url:'avid-media://localhost/a1b2c3d4-1234-1234-1234-123456789abc'});
    expect(value.tracks[1]).toEqual(source.tracks[1]);expect(value.manifestRevision).toBe(source.manifestRevision);
  });
  it('rejects a mapping that completes after the account changes',async()=>{
    const native=media();let active=true;vi.mocked(native.sources).mockImplementation(async()=>{active=false;return {ids:['a1b2c3d4-1234-1234-1234-123456789abc']};});
    await expect(resolveDesktopPlaybackBook(source,'scope',()=>active,native)).rejects.toThrow('account changed');
  });
  it('rejects arbitrary native URI injection through a resource response',async()=>{
    const native=media();vi.mocked(native.sources).mockResolvedValue({ids:['https://unexpected.example']});
    await expect(resolveDesktopPlaybackBook(source,'scope',()=>true,native)).rejects.toThrow('resource response is invalid');
  });
});
