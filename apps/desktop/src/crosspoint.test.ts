import {describe,expect,it,vi} from 'vitest';
import {createDesktopCrossPointFetch,type DesktopCrossPointBridge} from './crosspoint';
describe('desktop CrossPoint transport',()=>{
  it('cancels the native request while waiting for upload response headers',async()=>{
    let complete!:(value:Awaited<ReturnType<DesktopCrossPointBridge['open']>>)=>void;
    let id='';
    const bridge:DesktopCrossPointBridge={open:vi.fn(request=>{id=request.id;return new Promise(resolve=>{complete=resolve;});}),read:vi.fn(),close:vi.fn(async()=>{})};
    const abort=new AbortController();
    const pending=createDesktopCrossPointFetch(bridge)('http://192.168.1.2/api/status?plugin=avid',{signal:abort.signal});
    await vi.waitFor(()=>expect(id).not.toBe(''));
    abort.abort();
    expect(bridge.close).toHaveBeenCalledWith({id});
    complete({id,status:200,statusText:'OK',headers:[]});
    await expect(pending).rejects.toMatchObject({name:'AbortError'});
  });
  it('preserves a multipart EPUB and closes the matching native handle',async()=>{
    let request:Parameters<DesktopCrossPointBridge['open']>[0]|undefined;
    const bridge:DesktopCrossPointBridge={open:vi.fn(async value=>{request=value;return{id:value.id,status:200,statusText:'OK',headers:[]};}),read:vi.fn(async()=>({bytes:[79,75],done:true})),close:vi.fn(async()=>{})};
    const body=new FormData();body.append('file',new Blob(['EPUB']),'Example.epub');
    const response=await createDesktopCrossPointFetch(bridge)('http://192.168.1.2/upload?path=/',{method:'POST',body});
    expect(atob(request!.bodyBase64!)).toContain('filename="Example.epub"');
    expect(atob(request!.bodyBase64!)).toContain('EPUB');
    expect(await response.text()).toBe('OK');
    expect(bridge.close).toHaveBeenCalledWith({id:request!.id});
  });
  it('rejects a mismatched response handle without reading from it',async()=>{
    const bridge:DesktopCrossPointBridge={open:vi.fn(async()=>({id:'different',status:200,statusText:'OK',headers:[]})),read:vi.fn(),close:vi.fn(async()=>{})};
    await expect(createDesktopCrossPointFetch(bridge)('http://192.168.1.2/api/status?plugin=avid')).rejects.toThrow('identity changed');
    expect(bridge.read).not.toHaveBeenCalled();
    expect(bridge.close).toHaveBeenCalledOnce();
  });
});
