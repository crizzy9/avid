import {createReaderDiscovery,type DiscoveredReader,type DiscoverReaders} from '../../../packages/integrations/src/discovery';
import {invoke,isTauri} from '@tauri-apps/api/core';
import {createDesktopFetch,type DesktopHttpBridge,type DesktopHttpHead} from './network';

export interface DesktopCrossPointBridge {
  open(request:Parameters<DesktopHttpBridge['open']>[0]&{id:string}):Promise<DesktopHttpHead>;
  read:DesktopHttpBridge['read'];
  close:DesktopHttpBridge['close'];
}
const native:DesktopCrossPointBridge={
  open:request=>invoke('desktop_crosspoint_open',{request}),
  read:request=>invoke('desktop_crosspoint_read',{request}),
  close:request=>invoke('desktop_crosspoint_close',{request}),
};
/** A dedicated credential-free native LAN client. Cancellation reaches an in-flight upload. */
export function createDesktopCrossPointFetch(bridge:DesktopCrossPointBridge=native):typeof fetch {
  return createDesktopFetch({
    async open(request,signal){
      const id=crypto.randomUUID();
      let rejectAbort:((reason:unknown)=>void)|undefined;
      const aborted=new Promise<never>((_,reject)=>{rejectAbort=reject;});
      const close=()=>{void bridge.close({id}).catch(()=>{});};
      const cancel=()=>{close();rejectAbort?.(signal?.reason??new DOMException('Request aborted.','AbortError'));};
      signal?.throwIfAborted();
      signal?.addEventListener('abort',cancel,{once:true});
      try {
        const pending=bridge.open({...request,id}).then(async result=>{
          if(signal?.aborted){close();signal.throwIfAborted();}
          if(result.id!==id){await bridge.close({id}).catch(()=>{});throw new Error('The native reader response identity changed.');}
          return result;
        });
        return await Promise.race([pending,aborted]);
      }finally{signal?.removeEventListener('abort',cancel);}
    },
    read:request=>bridge.read(request),close:request=>bridge.close(request),
  },64*1024*1024+64*1024);
}
const request=createDesktopCrossPointFetch();
export function getDesktopCrossPointFetch():typeof fetch|null{return isTauri()?request:null;}

const discover=createReaderDiscovery({
  discover:async request=>({readers:await invoke<DiscoveredReader[]>('desktop_crosspoint_discover',{request})}),
  close:request=>native.close(request),
});
export function getDesktopReaderDiscovery():DiscoverReaders|undefined{return isTauri()?discover:undefined;}
