import {describe, expect, it, vi} from 'vitest';
import {createReaderDiscovery, type DiscoveredReader} from './discovery';
describe('reader discovery boundary', () => {
  it('keeps private HTTP peer addresses, validates names, and deduplicates', async () => {
    const close = vi.fn(async () => {});
    const discover = createReaderDiscovery({close, discover: async () => ({readers: [
      {address:'http://192.168.1.2',hostname:'reader'}, {address:'http://192.168.1.2',hostname:'duplicate'},
      {address:'http://8.8.8.8',hostname:'public'}, {address:'http://10.1.2.3:81',hostname:'websocket'},
      {address:'http://10.1.2.3',hostname:'<script>'}, {address:'http://10.1.2.3',hostname:'reader-2'},
    ]})});
    expect(await discover()).toEqual([{address:'http://192.168.1.2',hostname:'reader'},{address:'http://10.1.2.3',hostname:'reader-2'}]);
    expect(close).toHaveBeenCalledOnce();
  });
  it('cancels the native socket and suppresses a late result', async () => {
    let done!: (value:{readers:DiscoveredReader[]}) => void;
    const close=vi.fn(async()=>{}), abort=new AbortController();
    const discover=createReaderDiscovery({close,discover:()=>new Promise(resolve=>{done=resolve;})});
    const pending=discover(abort.signal); abort.abort();
    expect(close).toHaveBeenCalledOnce();
    await expect(pending).rejects.toMatchObject({name:'AbortError'});
    done({readers:[]});
  });
  it('never starts an already canceled scan and always closes malformed results', async () => {
    const close=vi.fn(async()=>{}), open=vi.fn(async()=>({readers:new Array(33).fill({address:'http://127.0.0.1',hostname:'a'})}));
    const discover=createReaderDiscovery({close,discover:open}); const abort=new AbortController(); abort.abort();
    await expect(discover(abort.signal)).rejects.toMatchObject({name:'AbortError'}); expect(open).not.toHaveBeenCalled();
    await expect(discover()).rejects.toThrow('Invalid'); expect(close).toHaveBeenCalledOnce();
  });
});
